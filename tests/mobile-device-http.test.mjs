import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {createServer} from 'node:http';
import {startServer} from '../server/index.mjs';

async function fixture(t,{cloud=true,allowedOrigin}={}){
  const directory=mkdtempSync(join(tmpdir(),'miobot-mobile-http-')),ownerToken=randomBytes(32).toString('base64url'),upstreams=[];
  const app=await startServer({dataRoot:directory,host:'127.0.0.1',port:0,sharingPort:0,cloudMode:cloud,cloudToken:cloud?ownerToken:'',fetcher:(input,options)=>{if(allowedOrigin&&new URL(String(input)).origin===allowedOrigin)return fetch(input,options);upstreams.push(String(input));throw Error('isolated device test refuses provider and external network requests');}});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});assert.deepEqual(upstreams,[],'these tests must not call model or messaging providers');});
  const request=async(path,{method='GET',body,headers={},base=app.url}={})=>{
    // Use node:http so a LAN Host can be exercised while the socket remains on
    // the isolated loopback fixture. Fetch may overwrite a custom Host header.
    return new Promise((resolve,reject)=>{
      const req=httpRequest(new URL(base+path),{method,headers:{'Content-Type':'application/json','X-Personal-Agent':'1',...headers}},res=>{
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,value:JSON.parse(Buffer.concat(chunks).toString()),cookie:res.headers['set-cookie']?.[0]||null});}catch(error){reject(error);}});
      });
      req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('isolated HTTP fixture timed out')));req.end(body===undefined?undefined:JSON.stringify(body));
    });
  };
  const owner=(path,options={})=>request(path,{...options,headers:{...(cloud?{Authorization:'Bearer '+ownerToken}:{}),...options.headers}});
  const pair=async(label='隔离手机')=>{
    const issued=await owner('/api/devices/pairings',{method:'POST',body:{label}});assert.equal(issued.status,201,JSON.stringify(issued.value));
    const exchanged=await request('/api/device-sessions',{method:'POST',body:{code:issued.value.code,label}});assert.equal(exchanged.status,201,JSON.stringify(exchanged.value));
    assert.ok(exchanged.cookie?.includes('HttpOnly'));const cookie=exchanged.cookie.split(';')[0],token=cookie.slice(cookie.indexOf('=')+1);
    return {device:exchanged.value.device,cookie,token,issued,publicResponse:exchanged.value,request:(path,options={})=>request(path,{...options,headers:{Cookie:cookie,...options.headers}})};
  };
  return {app,owner,ownerToken,request,pair};
}

test('two paired cloud devices use the same conversations, editable memories and confirmed reminders without provider calls',async t=>{
  const {app,ownerToken,pair}=await fixture(t),first=await pair('手机一'),second=await pair('手机二');
  assert.notEqual(first.device.id,second.device.id);
  const chat=await first.request('/api/chats',{method:'POST',body:{assistantId:'daily'}});assert.equal(chat.status,201);
  const remembered=await first.request('/api/chats/'+chat.value.id+'/messages',{method:'POST',body:{text:'记住我喜欢简短自然的回答',requestId:randomUUID()}});assert.equal(remembered.status,200);
  const reminder=await first.request('/api/chats/'+chat.value.id+'/messages',{method:'POST',body:{text:'一小时后提醒我休息',requestId:randomUUID()}});assert.equal(reminder.status,200);assert.ok(reminder.value.taskId);
  const memory=await first.request('/api/memories',{method:'POST',body:{assistantId:'daily',content:'忙的时候少打扰',category:'偏好'}});assert.equal(memory.status,201);
  const edit=await second.request('/api/memories/'+memory.value.id,{method:'PATCH',body:{content:'工作时少打扰，晚上可以聊聊'}});assert.equal(edit.status,200);
  const state=await second.request('/api/state');assert.equal(state.status,200);assert.equal(state.value.instanceId,app.store.state.instanceId);
  assert.ok(state.value.chats.some(item=>item.id===chat.value.id&&item.messages.some(message=>message.id===reminder.value.id)));
  assert.equal(state.value.memories.find(item=>item.id===memory.value.id).content,'工作时少打扰，晚上可以聊聊');
  assert.ok(state.value.memories.some(item=>item.content==='我喜欢简短自然的回答'));
  const task=state.value.tasks.find(item=>item.id===reminder.value.taskId);assert.equal(task.status,'pending');
  assert.equal((await second.request('/api/tasks/'+task.id,{method:'PATCH',body:{action:'pause'}})).status,200);
  assert.equal((await first.request('/api/state')).value.tasks.find(item=>item.id===task.id).status,'paused');
  assert.equal((await first.request('/api/tasks/'+task.id,{method:'PATCH',body:{action:'cancel'}})).status,200);
  assert.equal((await second.request('/api/state')).value.tasks.find(item=>item.id===task.id).status,'cancelled');
  for(const value of [first.publicResponse,second.publicResponse,state.value,(await first.request('/api/device-session')).value]){
    const serialized=JSON.stringify(value);for(const secret of [first.token,second.token,ownerToken])assert.equal(serialized.includes(secret),false);
    assert.equal(serialized.includes('tokenHash'),false);assert.equal(serialized.includes('codeHash'),false);
  }
  assert.equal(app.runtime.child,null,'the native model engine was not started');
});

test('personal devices cannot administer owner connections or other device grants, and revocation immediately removes access',async t=>{
  const {app,owner,pair}=await fixture(t),phone=await pair(),other=await pair('另一台设备');
  for(const [path,method,body] of [
    ['/api/devices/pairings','POST',{label:'unauthorized'}],['/api/devices','GET'],['/api/devices/'+other.device.id,'DELETE'],
    ['/api/device-sharing','POST',{enabled:true}],['/api/deployment/connect','POST',{url:'https://must-not-call.example',token:'synthetic-never-use'}],
    ['/api/model-connections','POST',{}],['/api/settings','PATCH',{runtimeUrl:'https://must-not-call.example'}]
  ])assert.equal((await phone.request(path,{method,body})).status,403,path);
  const listed=await owner('/api/devices');assert.equal(listed.status,200);assert.equal(listed.value.devices.length,2);
  const revoked=await owner('/api/devices/'+phone.device.id,{method:'DELETE'});assert.equal(revoked.status,200);
  assert.equal((await phone.request('/api/state')).status,401);assert.equal((await phone.request('/api/device-session')).status,401);
  assert.equal((await other.request('/api/state')).status,200);assert.equal(app.deviceNetwork.status().enabled,false);
});

test('cloud pairing, origin checks and explicit authorization failures do not bypass a device session boundary',async t=>{
  const {owner,request,pair}=await fixture(t),phone=await pair();
  assert.equal((await request('/api/device-access')).value.authenticated,false);assert.equal((await request('/api/state')).status,401);
  const grant=await owner('/api/devices/pairings',{method:'POST',body:{label:'待连接设备'}});assert.equal(grant.status,201);
  assert.equal((await request('/api/device-sessions',{method:'POST',body:{code:grant.value.code},headers:{Origin:'https://untrusted.example'}})).status,403);
  assert.equal((await request('/api/device-sessions',{method:'POST',body:{code:grant.value.code},headers:{'X-Personal-Agent':'0'}})).status,403);
  assert.equal((await request('/api/device-sessions',{method:'POST',body:{code:grant.value.code}})).status,201,'blocked attempts must not consume the valid code');
  assert.equal((await request('/api/device-sessions',{method:'POST',body:{code:grant.value.code}})).status,401,'the valid code is single-use');
  for(const path of ['/api/device-access','/api/state','/api/device-session'])assert.equal((await phone.request(path,{headers:{Origin:'https://untrusted.example'}})).status,403,path);
  for(const Authorization of ['Bearer synthetic-wrong-owner',''])assert.equal((await phone.request('/api/state',{headers:{Authorization}})).status,401,'an explicit invalid owner credential must not fall back to a valid device cookie');
  const signedOut=await phone.request('/api/device-session',{method:'DELETE'});assert.equal(signedOut.status,200);assert.match(signedOut.cookie,/Max-Age=0/);
  assert.equal((await phone.request('/api/state')).status,401,'logout invalidates a copied old cookie too');
});

test('local network listener requires pairing even if an unpaired client supplies desktop headers',async t=>{
  const {app,owner,request}=await fixture(t,{cloud:false});
  assert.equal(app.deviceNetwork.status().enabled,false);
  const sharing=await owner('/api/device-sharing',{method:'POST',body:{enabled:true}});assert.equal(sharing.status,200);assert.equal(sharing.value.enabled,true);
  const base='http://127.0.0.1:'+sharing.value.port,host='192.168.56.10:'+sharing.value.port;
  const lan=(path,options={})=>request(path,{...options,base,headers:{Host:host,...options.headers}});
  const publicStatus=await lan('/api/device-access');assert.equal(publicStatus.status,200);assert.equal(publicStatus.value.authenticated,false);assert.equal(publicStatus.value.owner,false);
  assert.equal((await lan('/api/state')).status,403);assert.equal((await lan('/api/devices/pairings',{method:'POST',body:{label:'spoofed desktop'}})).status,403);
  const pairing=await owner('/api/devices/pairings',{method:'POST',body:{label:'局域网手机'}});assert.equal(pairing.status,201);
  const exchanged=await lan('/api/device-sessions',{method:'POST',body:{code:pairing.value.code}});assert.equal(exchanged.status,201);assert.ok(exchanged.cookie);
  const cookie=exchanged.cookie.split(';')[0];
  assert.equal((await lan('/api/state',{headers:{Cookie:cookie}})).status,200);
  assert.equal((await lan('/api/device-session',{headers:{Cookie:cookie}})).value.owner,false);
  assert.equal((await lan('/api/device-sharing',{method:'POST',body:{enabled:false},headers:{Cookie:cookie}})).status,403);
  assert.equal((await lan('/api/devices/pairings',{method:'POST',body:{},headers:{Cookie:cookie}})).status,403);
  assert.equal((await lan('/api/state',{headers:{Cookie:cookie,Origin:'http://192.168.56.11:'+sharing.value.port}})).status,403);
  const disabled=await owner('/api/device-sharing',{method:'POST',body:{enabled:false}});assert.equal(disabled.status,200);assert.equal(disabled.value.enabled,false);
});

test('an old local device grant never becomes a cloud proxy grant after the desktop switches backend',async t=>{
  const calls=[],cloudKey='synthetic-isolated-cloud-owner-key',cloud=createServer(async(req,res)=>{
    for await(const chunk of req){}
    calls.push({path:req.url,authorization:req.headers.authorization});res.setHeader('Content-Type','application/json');
    if(req.url==='/api/cloud/info')return res.end(JSON.stringify({product:'MioBot',apiVersion:1,instanceId:'isolated-other-backend',name:'测试云端'}));
    if(req.url==='/api/state')return res.end(JSON.stringify({instanceId:'isolated-other-backend',fixture:true}));
    return res.end(JSON.stringify({unexpectedProxy:true}));
  });
  await new Promise(resolve=>cloud.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{cloud.close(resolve);cloud.closeAllConnections?.();}));
  const url='http://127.0.0.1:'+cloud.address().port,{app,owner,pair}=await fixture(t,{cloud:false,allowedOrigin:url}),phone=await pair('原本地手机');
  const unused=await owner('/api/devices/pairings',{method:'POST',body:{label:'未使用本地配对码'}});assert.equal(unused.status,201);
  const connected=await owner('/api/deployment/connect',{method:'POST',body:{url,token:cloudKey}});assert.equal(connected.status,200);
  const metadata=await phone.request('/api/device-access');assert.equal(metadata.status,200);assert.equal(metadata.value.authenticated,false);assert.equal(metadata.value.reconnectRequired,true);assert.match(metadata.value.error,/云端/);
  const count=calls.length;
  for(const [path,method,body] of [['/api/state','GET'],['/api/chats/fixture/messages/stream','POST',{text:'must not reach cloud',requestId:randomUUID()}],['/api/device-session','GET']]){
    const response=await phone.request(path,{method,body});assert.equal(response.status,403,path);assert.equal(response.value.code,'DIRECT_CLOUD_REQUIRED');
  }
  assert.equal(calls.length,count,'old device reads and stream submissions never reach the proxy');assert.equal(app.deployment.controllers.size,0);
  const ownerState=await owner('/api/state');assert.equal(ownerState.status,200);assert.equal(ownerState.value.instanceId,'isolated-other-backend');assert.equal(calls.at(-1).authorization,'Bearer '+cloudKey);
  const exchange=await phone.request('/api/device-sessions',{method:'POST',body:{code:unused.value.code}});assert.equal(exchange.status,409);assert.equal(exchange.value.code,'DIRECT_CLOUD_REQUIRED');
  const logout=await phone.request('/api/device-session',{method:'DELETE'});assert.equal(logout.status,200);assert.match(logout.cookie,/Max-Age=0/);assert.equal(app.devices.authenticate(phone.token),null);
});
