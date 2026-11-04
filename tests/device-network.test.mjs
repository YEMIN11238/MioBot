import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {DeviceNetwork} from '../server/device-network.mjs';

function fixture(t,{state={}}={}){
  const requests=[],store={state:structuredClone(state),saved:null,writes:0,fail:false,save(){this.writes++;if(this.fail)throw Error('synthetic disk failure');this.saved=structuredClone(this.state);}};
  const network=new DeviceNetwork({store,port:0,listener:(req,res)=>{requests.push(req.url);res.end('isolated fixture');}});
  t.after(()=>network.disable({persist:false}));
  return {store,network,requests};
}
async function occupied(t){
  const server=http.createServer((req,res)=>res.end());await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();}));return server;
}
async function canBind(port){
  const server=http.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  await new Promise(resolve=>server.close(resolve));
}

test('enable persistence failure closes the new listener and restores the old in-memory sharing setting',async t=>{
  const {store,network}=fixture(t,{state:{deviceSharing:{enabled:false,previous:'fixture'}}});store.fail=true;
  let attemptedPort;
  // A known free port makes the failure's listener observable without exposing
  // implementation-only hooks or changing the listener under test.
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'0.0.0.0',resolve));attemptedPort=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));network.port=attemptedPort;
  await assert.rejects(network.enable(),error=>error.code==='DEVICE_SHARING_SAVE_FAILED'&&error.status===503);
  assert.equal(network.server,null);assert.equal(network.status().enabled,false);assert.match(network.status().error,/已关闭/);
  assert.deepEqual(store.state.deviceSharing,{enabled:false,previous:'fixture'});assert.equal(store.saved,null);
  await canBind(attemptedPort);
});

test('failed first-time enable does not invent a saved sharing setting',async t=>{
  const {store,network}=fixture(t);store.fail=true;
  await assert.rejects(network.enable(),/保存/);assert.equal(Object.hasOwn(store.state,'deviceSharing'),false);assert.equal(network.status().enabled,false);
});

test('disable persistence failure still closes its listener and retains a truthful recoverable status',async t=>{
  const {store,network}=fixture(t),started=await network.enable(),server=network.server;assert.equal(started.enabled,true);store.fail=true;
  await assert.rejects(network.disable(),error=>error.code==='DEVICE_SHARING_SAVE_FAILED');
  assert.equal(server.listening,false);assert.equal(network.server,null);assert.equal(network.status().enabled,false);assert.match(network.status().error,/下次启动/);
  assert.deepEqual(store.state.deviceSharing,{enabled:true});assert.deepEqual(store.saved.deviceSharing,{enabled:true},'old persisted opt-in may still be restored on a later startup');
  await canBind(started.port);
  store.fail=false;assert.equal((await network.disable()).enabled,false);assert.deepEqual(store.saved.deviceSharing,{enabled:false});assert.equal(network.status().error,undefined);
});

test('shutdown without persistence closes active sockets even while saving is unavailable',async t=>{
  const {store,network}=fixture(t),started=await network.enable();store.fail=true;
  const accepted=once(network.server,'connection'),socket=net.createConnection({host:'127.0.0.1',port:started.port});
  t.after(()=>socket.destroy());await Promise.all([once(socket,'connect'),accepted]);const closed=once(socket,'close');
  const writes=store.writes;assert.equal((await network.disable({persist:false})).enabled,false);await closed;
  assert.equal(store.writes,writes);assert.equal(network.server,null);assert.equal(socket.destroyed,true);await canBind(started.port);
});

test('a busy port leaves no active listener or persisted opt-in',async t=>{
  const server=await occupied(t),{store,network}=fixture(t);network.port=server.address().port;
  await assert.rejects(network.enable(),/端口/);assert.equal(network.server,null);assert.equal(network.status().enabled,false);assert.equal(store.writes,0);
});

test('listener errors remain handled after startup and are visible through status',async t=>{
  const {network}=fixture(t);await network.enable();
  assert.doesNotThrow(()=>network.server.emit('error',Error('synthetic listener error')));assert.match(network.status().error,/发生错误/);
  assert.equal(network.status().enabled,true,'an error signal alone does not falsely claim a live listener has closed');
  await network.disable({persist:false});assert.equal(network.status().enabled,false);
});

test('concurrent enable and disable requests serialize instead of leaking an extra listener',async t=>{
  const {store,network}=fixture(t);
  const starts=await Promise.all([network.enable(),network.enable(),network.enable()]);assert.equal(new Set(starts.map(item=>item.port)).size,1);assert.equal(store.writes,1);
  const port=starts[0].port;await Promise.all([network.disable(),network.disable()]);assert.equal(network.server,null);assert.equal(network.status().enabled,false);await canBind(port);
});
