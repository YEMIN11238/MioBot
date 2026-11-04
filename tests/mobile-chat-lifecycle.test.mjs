import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../server/index.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,message){
  const deadline=Date.now()+2500;
  while(Date.now()<deadline){const result=await check();if(result)return result;await sleep(5);}
  assert.fail(message);
}
async function json(app,path,{method='GET',body,headers={}}={}){
  const response=await fetch(app.url+'/api'+path,{method,headers:{'X-Personal-Agent':'1','Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {response,status:response.status,value:await response.json()};
}
async function fixture(t,options={}){
  const directory=mkdtempSync(join(tmpdir(),'miobot-mobile-lifecycle-')),external=[];
  const fetcher=()=>{external.push('unexpected external request');throw Error('fixture refuses native and external model requests');};
  const app=await startServer({dataRoot:directory,port:0,fetcher,...options});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});assert.deepEqual(external,[]);});
  app.runtime.syncWorkflows=async()=>({ready:true,jobs:[]});
  app.store.state.modelConnections.push({id:'lifecycle-fixture',model:'fixture-chat',type:'openai_chat_completion',config:{}});
  app.store.state.settings.defaultConnectionId='lifecycle-fixture';app.runtime.status='ready';
  app.store.save();
  return app;
}
function gatedModel(app,text='后台已经完成这条回复。'){
  let calls=0,cancelCalls=0,signal,release;
  app.runtime.cancel=async()=>{cancelCalls++;};
  app.runtime.chat=async(_chat,_prompt,options)=>{
    calls++;signal=options.signal;
    return new Promise((resolve,reject)=>{
      release=()=>{options.onDelta?.(text);resolve(text);};
      signal.addEventListener('abort',()=>reject(new DOMException('fixture cancelled','AbortError')),{once:true});
      if(signal.aborted)reject(new DOMException('fixture cancelled','AbortError'));
    });
  };
  return {release:()=>{assert.ok(release,'model has started');release();},calls:()=>calls,cancelCalls:()=>cancelCalls,signal:()=>signal,text};
}
async function openStream(app,chatId,payload,headers={}){
  const response=await fetch(app.url+'/api/chats/'+chatId+'/messages/stream',{method:'POST',headers:{'X-Personal-Agent':'1','Content-Type':'application/json',...headers},body:JSON.stringify(payload)});
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reader=response.body.getReader(),first=await reader.read();assert.equal(first.done,false);assert.match(new TextDecoder().decode(first.value),/"type":"start"/);
  return {reader,response};
}
async function finishStream(reader){let text='';for(;;){const chunk=await reader.read();if(chunk.done)return text;text+=new TextDecoder().decode(chunk.value);}}
function watchDetachedResponse(t,app,path){
  let detached=false;
  const listener=(req,res)=>{if(req.url===path)res.once('close',()=>{if(!res.writableEnded)detached=true;});};
  app.server.on('request',listener);t.after(()=>app.server.off('request',listener));
  return ()=>detached;
}
function messageFrom(state,id){return state.chats.find(item=>item.id===id).messages.findLast(item=>item.role==='assistant');}

test('disconnecting the actual SSE viewer leaves the model running and a reconnect reads the durable completed reply',async t=>{
  const app=await fixture(t),chat=app.store.createChat('daily'),model=gatedModel(app),requestId=randomUUID();
  const detached=watchDetachedResponse(t,app,'/api/chats/'+chat.id+'/messages/stream');
  const {reader}=await openStream(app,chat.id,{text:'和我说句话',requestId});
  assert.equal(model.calls(),1);await reader.cancel();await until(detached,'HTTP viewer did not actually disconnect');
  assert.equal(model.signal().aborted,false);assert.equal(model.cancelCalls(),0);
  const running=await json(app,'/chats/'+chat.id+'/run');assert.equal(running.status,200);assert.equal(running.value.status,'running');assert.equal(running.value.requestId,requestId);
  model.release();
  const finished=await until(async()=>{const r=await json(app,'/chats/'+chat.id+'/run');return r.value.status==='idle'&&r.value.message?.status==='complete'?r.value:null;},'detached reply never completed');
  assert.equal(finished.message.text,model.text);assert.equal(finished.requestId,requestId);
  const state=await json(app,'/state');assert.equal(messageFrom(state.value,chat.id).text,model.text);assert.equal(state.value.chats.find(item=>item.id===chat.id).runStatus,'idle');
  const durable=JSON.parse(readFileSync(app.store.file,'utf8'));assert.equal(messageFrom(durable,chat.id).status,'complete');assert.equal(messageFrom(durable,chat.id).text,model.text);
  assert.equal(model.calls(),1);assert.equal(model.cancelCalls(),0);assert.equal(app.runtime.child,null);
});

test('the same message identity returns a receipt during and after execution while a changed body is rejected without another model call',async t=>{
  const app=await fixture(t),chat=app.store.createChat('daily'),model=gatedModel(app),payload={text:'这条消息只处理一次',requestId:randomUUID()};
  const {reader}=await openStream(app,chat.id,payload);
  const duplicate=await json(app,'/chats/'+chat.id+'/messages/stream',{method:'POST',body:payload});
  assert.equal(duplicate.status,200);assert.match(duplicate.response.headers.get('content-type'),/application\/json/);assert.equal(duplicate.value.duplicate,true);assert.equal(duplicate.value.runStatus,'running');assert.equal(duplicate.value.message.requestId,payload.requestId);
  const conflict=await json(app,'/chats/'+chat.id+'/messages',{method:'POST',body:{...payload,text:'同编号的另一条正文'}});
  assert.equal(conflict.status,409);assert.equal(model.calls(),1);
  model.release();assert.match(await finishStream(reader),/"type":"done"/);
  const completed=await json(app,'/chats/'+chat.id+'/messages',{method:'POST',body:payload});
  assert.equal(completed.status,200);assert.equal(completed.value.duplicate,true);assert.equal(completed.value.message.status,'complete');assert.equal(completed.value.message.text,model.text);
  assert.equal(chat.messages.filter(item=>item.role==='user').length,1);assert.equal(chat.messages.filter(item=>item.role==='assistant').length,1);assert.equal(model.calls(),1);
});

test('an explicit stop still aborts the provider and persists a cancelled reply',async t=>{
  const app=await fixture(t),chat=app.store.createChat('daily'),model=gatedModel(app),requestId=randomUUID();
  const {reader}=await openStream(app,chat.id,{text:'这次我要主动停止',requestId});
  const stopped=await json(app,'/chats/'+chat.id+'/cancel',{method:'POST',body:{requestId}});
  assert.equal(stopped.status,200);assert.equal(stopped.value.status,'cancelling');assert.equal(model.signal().aborted,true);assert.equal(model.cancelCalls(),1);
  assert.match(await finishStream(reader),/"type":"cancelled"/);
  const run=await json(app,'/chats/'+chat.id+'/run');assert.equal(run.value.status,'idle');assert.equal(run.value.message.status,'cancelled');
  const durable=JSON.parse(readFileSync(app.store.file,'utf8'));assert.equal(messageFrom(durable,chat.id).status,'cancelled');assert.equal(model.calls(),1);
  const restoredChat=app.store.createChat('daily'),restoredModel=gatedModel(app);
  const restored=await openStream(app,restoredChat.id,{text:'恢复页面后手动停止当前回复',requestId:randomUUID()});
  const stopCurrent=await json(app,'/chats/'+restoredChat.id+'/cancel',{method:'POST',body:{}});
  assert.equal(stopCurrent.status,200);assert.equal(restoredModel.signal().aborted,true);assert.equal(restoredModel.cancelCalls(),1);
  assert.match(await finishStream(restored.reader),/"type":"cancelled"/);
});

test('a stale stop receipt cannot cancel the newer request currently running in the same chat',async t=>{
  const app=await fixture(t),chat=app.store.createChat('daily'),model=gatedModel(app),requestId=randomUUID();
  const {reader}=await openStream(app,chat.id,{text:'这是当前的新请求',requestId});
  const stale=await json(app,'/chats/'+chat.id+'/cancel',{method:'POST',body:{requestId:randomUUID()}});
  assert.equal(stale.status,409,'stale viewers must not stop another request');assert.equal(model.signal().aborted,false);assert.equal(model.cancelCalls(),0);
  const stopped=await json(app,'/chats/'+chat.id+'/cancel',{method:'POST',body:{requestId}});assert.equal(stopped.status,200);assert.equal(model.cancelCalls(),1);
  assert.match(await finishStream(reader),/"type":"cancelled"/);
});

test('a separately paired phone reads the same unfinished and completed reply using its own device cookie',async t=>{
  const app=await fixture(t),chat=app.store.createChat('daily'),model=gatedModel(app),requestId=randomUUID();
  const pairing=await json(app,'/devices/pairings',{method:'POST',body:{label:'隔离手机'}});assert.equal(pairing.status,201);
  const exchanged=await json(app,'/device-sessions',{method:'POST',body:{code:pairing.value.code,label:'隔离手机'}});assert.equal(exchanged.status,201);
  const cookie=exchanged.response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);assert.equal(JSON.stringify(exchanged.value).includes(cookie),false);
  const {reader}=await openStream(app,chat.id,{text:'从电脑继续到手机',requestId});
  const phoneRun=await json(app,'/chats/'+chat.id+'/run',{headers:{Cookie:cookie}});assert.equal(phoneRun.status,200);assert.equal(phoneRun.value.status,'running');assert.equal(phoneRun.value.requestId,requestId);
  await reader.cancel();model.release();
  const phoneReply=await until(async()=>{const r=await json(app,'/state',{headers:{Cookie:cookie}});const reply=messageFrom(r.value,chat.id);return reply.status==='complete'?reply:null;},'paired phone did not observe completion');
  assert.equal(phoneReply.text,model.text);assert.equal(phoneReply.requestId,requestId);assert.equal(model.calls(),1);
});

test('closing a desktop SSE proxy aborts only its transport while the separate cloud job completes and is readable after reconnect',async t=>{
  const token=randomBytes(32).toString('base64url'),cloud=await fixture(t,{cloudMode:true,cloudToken:token,serverName:'隔离云端'}),model=gatedModel(cloud,'云端独立完成了回复。');
  const upstreams=[];
  const desktop=await fixture(t,{fetcher:(input,options)=>{
    const url=new URL(typeof input==='string'?input:input.url);assert.equal(url.origin,cloud.url,'only the isolated cloud is a permitted upstream');upstreams.push({path:url.pathname,signal:options.signal});return fetch(input,options);
  }});
  const paired=await json(desktop,'/deployment/connect',{method:'POST',body:{url:cloud.url,token}});assert.equal(paired.status,200);assert.equal(paired.value.mode,'cloud');
  const created=await json(desktop,'/chats',{method:'POST',body:{assistantId:'daily'}});assert.equal(created.status,201);const chat=created.value,payload={text:'关掉本地页面后继续完成',requestId:randomUUID()};
  const desktopDetached=watchDetachedResponse(t,desktop,'/api/chats/'+chat.id+'/messages/stream'),cloudDetached=watchDetachedResponse(t,cloud,'/api/chats/'+chat.id+'/messages/stream');
  const {reader}=await openStream(desktop,chat.id,payload);await reader.cancel();
  await until(()=>desktopDetached()&&cloudDetached(),'proxy cancellation did not reach the cloud HTTP viewer');
  const streamedUpstream=upstreams.find(item=>item.path.endsWith('/messages/stream'));assert.ok(streamedUpstream);assert.equal(streamedUpstream.signal.aborted,true,'proxy aborts its outgoing HTTP transport');
  assert.equal(model.signal().aborted,false,'cloud provider survives the proxy viewer');assert.equal(model.cancelCalls(),0);
  const running=await json(desktop,'/chats/'+chat.id+'/run');assert.equal(running.status,200);assert.equal(running.value.status,'running');
  model.release();
  const result=await until(async()=>{const r=await json(desktop,'/chats/'+chat.id+'/run');return r.value.status==='idle'&&r.value.message?.status==='complete'?r.value:null;},'cloud reply did not complete after proxy detached');
  assert.equal(result.message.text,model.text);assert.equal(result.requestId,payload.requestId);assert.equal(model.calls(),1);
  const state=await json(desktop,'/state');assert.equal(messageFrom(state.value,chat.id).text,model.text);assert.equal(state.value.instanceId,cloud.store.state.instanceId);assert.equal(JSON.stringify(state.value).includes(token),false);
  assert.equal(desktop.store.state.chats.length,0,'desktop manager does not create another local chat');assert.equal(desktop.runtime.child,null);assert.equal(cloud.runtime.child,null);
  assert.equal(messageFrom(JSON.parse(readFileSync(cloud.store.file,'utf8')),chat.id).status,'complete');
});

test('revoking or logging out a device closes its existing viewers without leaking later output or cancelling the shared job',async t=>{
  const app=await fixture(t);
  async function pair(label){
    const issued=await json(app,'/devices/pairings',{method:'POST',body:{label}});assert.equal(issued.status,201);
    const session=await json(app,'/device-sessions',{method:'POST',body:{code:issued.value.code,label}});assert.equal(session.status,201);
    const cookie=session.response.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
    return {id:session.value.device.id,cookie};
  }
  const observer=await pair('仍有授权的手机');
  for(const scenario of [
    {stream:true,action:'revoke'}, {stream:true,action:'logout'},
    {stream:false,action:'revoke'}, {stream:false,action:'logout'},
  ]){
    const device=await pair('即将退出的手机'),chat=app.store.createChat('daily');
    const hidden='授权结束后不应继续收到的内容',model=gatedModel(app,'已经收到前半句。\n\n'+hidden+'。');
    const payload={text:'设备授权变化期间继续完成回复',requestId:randomUUID()};
    let viewer,first='',pending;
    if(scenario.stream){
      viewer=await openStream(app,chat.id,payload,{Cookie:device.cookie});model.release();
      while(!first.includes('"type":"part"')){const chunk=await viewer.reader.read();assert.equal(chunk.done,false);first+=new TextDecoder().decode(chunk.value);}
      assert.ok(first.includes('已经收到前半句'));assert.equal(first.includes(hidden),false);
    }else{
      pending={};
      void fetch(app.url+'/api/chats/'+chat.id+'/messages',{method:'POST',headers:{'X-Personal-Agent':'1','Content-Type':'application/json',Cookie:device.cookie},body:JSON.stringify(payload)}).then(response=>{pending.response=response;},error=>{pending.error=error;});
      await until(()=>model.calls()===1,'nonstream model never started');
    }
    const removed=scenario.action==='revoke'
      ?await json(app,'/devices/'+device.id,{method:'DELETE'})
      :await json(app,'/device-session',{method:'DELETE',headers:{Cookie:device.cookie}});
    assert.equal(removed.status,200);
    if(scenario.stream){
      const remaining=await finishStream(viewer.reader);assert.equal(remaining.includes(hidden),false);assert.equal(remaining.includes('"type":"done"'),false);
    }else{
      await until(()=>pending.response||pending.error,'nonstream viewer was not detached promptly');
      assert.equal(pending.error,undefined);assert.equal(pending.response.status,401);
      const denied=await pending.response.json();assert.match(denied.error,/授权|配对/);assert.equal(JSON.stringify(denied).includes(hidden),false);
      model.release();
    }
    assert.equal(model.signal().aborted,false);assert.equal(model.cancelCalls(),0);
    const rejected=await json(app,'/state',{headers:{Cookie:device.cookie}});assert.equal(rejected.status,401);
    const other=await until(async()=>{const r=await json(app,'/chats/'+chat.id+'/run',{headers:{Cookie:observer.cookie}});assert.equal(r.status,200);return r.value.status==='idle'&&r.value.message?.status==='complete'?r.value:null;},'other paired device did not recover the completed shared reply');
    assert.equal(other.message.text,model.text);assert.equal(model.calls(),1);assert.equal(model.cancelCalls(),0);
    assert.equal(messageFrom(JSON.parse(readFileSync(app.store.file,'utf8')),chat.id).status,'complete');
  }
});
