import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../server/index.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function close(app){
  if(!app)return;
  app.server.closeAllConnections?.();
  await app.close();
}
async function request(base,path,{method='GET',body,headers={}}={}){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,value:await response.json()};
}

test('a real cloud service executes an authorized reminder while its desktop manager is closed, then a restarted manager reads the durable result',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'miobot-cloud-lifecycle-')),token=randomBytes(32).toString('base64url');
  let cloud,desktop,restarted;
  t.after(async()=>{
    await close(restarted);await close(desktop);await close(cloud);
    rmSync(directory,{recursive:true,force:true});
  });
  // A network boundary makes accidental native/model/real-platform requests a
  // test failure. Only the temporary cloud HTTP service is a permitted upstream.
  const allowedOrigins=new Set(),unexpectedUpstreams=[];
  const isolatedFetch=(input,options)=>{
    const url=new URL(typeof input==='string'?input:input.url);
    if(!allowedOrigins.has(url.origin)){unexpectedUpstreams.push(url.origin);throw Error('isolated fixture refuses non-cloud upstream');}
    return fetch(input,options);
  };
  const notices=[];
  cloud=await startServer({dataRoot:join(directory,'cloud'),host:'127.0.0.1',port:0,cloudMode:true,cloudToken:token,serverName:'隔离验收云端',fetcher:isolatedFetch,onNotify:item=>notices.push(item)});
  allowedOrigins.add(cloud.url);
  assert.equal(cloud.runtime.child,null,'native engine is not started');
  const ownerHeaders={Authorization:'Bearer '+token};
  assert.deepEqual((await request(cloud.url,'/health')).value,{ok:true});
  for(const path of ['/api/cloud/info','/api/state']){
    assert.equal((await request(cloud.url,path)).status,401,'cloud API requires owner authorization');
    assert.equal((await request(cloud.url,path,{headers:{Authorization:'Bearer synthetic-wrong-key'}})).status,401);
    const owner=await request(cloud.url,path,{headers:ownerHeaders});
    assert.equal(owner.status,200,'owner Bearer does not require the desktop-specific marker');
    assert.equal(JSON.stringify(owner.value).includes(token),false,'cloud metadata and state do not return the key');
  }

  const desktopData=join(directory,'desktop');
  desktop=await startServer({dataRoot:desktopData,port:0,fetcher:isolatedFetch});
  const fromDesktop=(path,options={})=>request(desktop.url,path,{...options,headers:{'X-Personal-Agent':'1',...options.headers}});
  const paired=await fromDesktop('/api/deployment/connect',{method:'POST',body:{url:cloud.url,token}});
  assert.equal(paired.status,200);assert.equal(paired.value.mode,'cloud');assert.equal(paired.value.cloud.online,true);
  assert.equal(JSON.stringify(paired.value).includes(token),false);
  const created=await fromDesktop('/api/chats',{method:'POST',body:{assistantId:'daily'}});
  assert.equal(created.status,201);
  const reply=await fromDesktop('/api/chats/'+created.value.id+'/messages',{method:'POST',body:{text:'3秒后提醒我测试云端',requestId:randomUUID()}});
  assert.equal(reply.status,200);assert.equal(reply.value.status,'complete');assert.ok(reply.value.taskId);
  const task=cloud.store.state.tasks.find(item=>item.id===reply.value.taskId);
  assert.ok(task,'proxy request creates the task in the real cloud store');
  assert.equal(task.status,'pending');assert.equal(task.title,'测试云端');assert.equal(task.channel,'web');
  assert.equal(task.chatId,created.value.id);assert.equal(desktop.store.state.tasks.length,0,'task is not copied into the manager local store');
  assert.equal(cloud.runtime.child,null);assert.equal(desktop.runtime.child,null);

  await close(desktop);desktop=undefined;
  assert.ok(Date.now()<Date.parse(task.dueAt),'manager closes before the task becomes due');
  assert.equal(cloud.server.listening,true,'cloud server remains running independently');
  const deadline=Date.now()+8000;
  while(task.status==='pending'&&Date.now()<deadline)await delay(100);
  assert.equal(task.status,'done','the real cloud timer executes without any manager');
  assert.ok(Date.parse(task.deliveredAt)>=Date.parse(task.dueAt));
  assert.equal(notices.filter(item=>item.taskId===task.id).length,1);

  const durable=JSON.parse(readFileSync(cloud.store.file,'utf8'));
  const notification=durable.notifications.find(item=>item.taskId===task.id);
  const reminder=durable.chats.find(item=>item.id===created.value.id).messages.filter(item=>item.taskId===task.id&&item.source==='reminder');
  assert.equal(durable.tasks.find(item=>item.id===task.id).status,'done');
  assert.ok(notification);assert.equal(notification.read,false,'inbox delivery is distinct from a user reading it');
  assert.equal(reminder.length,1);assert.match(reminder[0].text,/测试云端/);

  restarted=await startServer({dataRoot:desktopData,port:0,fetcher:isolatedFetch});
  const fromRestarted=(path,options={})=>request(restarted.url,path,{...options,headers:{'X-Personal-Agent':'1',...options.headers}});
  const reconnect=await fromRestarted('/api/deployment/connect',{method:'POST',body:{url:cloud.url,token:''}});
  assert.equal(reconnect.status,200);assert.equal(reconnect.value.cloud.online,true,'saved pairing can reconnect without copying the key into a new request');
  const observed=await fromRestarted('/api/state');
  assert.equal(observed.status,200);assert.equal(observed.value.instanceId,cloud.store.state.instanceId);
  assert.equal(observed.value.tasks.find(item=>item.id===task.id).status,'done');
  assert.equal(observed.value.notifications.find(item=>item.taskId===task.id).id,notification.id);
  assert.equal(observed.value.chats.find(item=>item.id===created.value.id).messages.filter(item=>item.source==='reminder'&&item.taskId===task.id).length,1);
  assert.equal(restarted.store.state.tasks.length,0);assert.equal(JSON.stringify(observed.value).includes(token),false);
  assert.deepEqual(unexpectedUpstreams,[],'no native model or real messaging service was contacted');
  assert.equal(cloud.runtime.child,null);assert.equal(restarted.runtime.child,null);
});
