import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startServer} from '../server/index.mjs';

async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'miobot-private-http-'));let app;
  const unexpectedRequests=[];
  t.after(async()=>{
    if(app){app.server.closeAllConnections?.();await app.close();}
    rmSync(directory,{recursive:true,force:true});
  });
  app=await startServer({dataRoot:directory,port:0,fetcher:async()=>{unexpectedRequests.push(true);throw Error('fixture forbids model or QQ outbound traffic');}});
  const web=app.store.createChat('daily'),sender='synthetic-private-sender',channel={id:'synthetic-onebot-channel',name:'隔离 OneBot 私聊验收',type:'aiocqhttp',assistantId:'daily',enabled:true,supportProactive:true,status:'verified',verifiedAt:new Date().toISOString(),target:'aiocqhttp:FriendMessage:'+sender,nativeId:`pa-${app.store.state.instanceId}-synthetic-onebot-channel`};
  app.store.state.channels.push(channel);app.store.save();
  const event=(overrides={})=>({platform:'aiocqhttp',umo:`${channel.nativeId}:FriendMessage:${sender}`,sessionId:sender,senderId:sender,userText:'明天早上7点叫我测试私聊定时',messageId:'synthetic-native-message-1',...overrides});
  const post=async(path,body,{authorized=true,headers={}}={})=>{
    const response=await fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{'X-MioBot-Tool-Token':app.runtime.toolBridge.token}:{}),...headers},body:JSON.stringify(body)});
    return {status:response.status,value:await response.json()};
  };
  const tomorrow=new Date(Date.now()+32*60*60*1000).toISOString().slice(0,10),dueAt=tomorrow+'T07:00:00+08:00';
  return {app,web,channel,event,post,dueAt,unexpectedRequests};
}

test('real internal HTTP bridge requires its private token and rejects browser-origin calls',async t=>{
  const {app,event,post,dueAt,unexpectedRequests}=await fixture(t);
  for(const path of ['/internal/inbound-trusted','/internal/assistant-tools']){
    const body={...event(),name:'schedule_reminder',args:{title:'测试私聊定时',dueAt}};
    assert.equal((await post(path,body,{authorized:false})).status,403);
    assert.equal((await post(path,body,{headers:{'X-MioBot-Tool-Token':'synthetic-wrong-token'}})).status,403);
    assert.equal((await post(path,body,{headers:{Origin:'https://synthetic.invalid'}})).status,403);
  }
  assert.equal(app.store.state.tasks.length,0);
  assert.equal(app.store.state.chats.filter(chat=>chat.origin==='channel').length,0);
  assert.deepEqual(unexpectedRequests,[]);assert.equal(app.runtime.child,null);
});

test('trusted native private receipt creates a correctly scoped reminder once and rejects stale-message tool replay',async t=>{
  const {app,web,channel,event,post,dueAt,unexpectedRequests}=await fixture(t),received=event();
  const first=await post('/internal/inbound-trusted',received);
  assert.equal(first.status,200);assert.equal(first.value.ok,true);
  const repeated=await post('/internal/inbound-trusted',received);
  assert.equal(repeated.status,200);assert.equal(repeated.value.messageId,first.value.messageId);
  const chat=app.store.chat(first.value.chatId),user=chat.messages.find(item=>item.id===first.value.messageId);
  assert.equal(chat.origin,'channel');assert.equal(chat.ownerId,'local-user');assert.notEqual(chat.id,web.id);
  assert.equal(user.nativeMessageId,received.messageId);assert.equal(user.text,received.userText);assert.equal(chat.messages.length,1);
  const tool={...received,name:'schedule_reminder',args:{title:'测试私聊定时',dueAt}};
  const created=await post('/internal/assistant-tools',tool);
  assert.equal(created.status,200);assert.equal(created.value.ok,true);
  assert.equal(created.value.task.status,'pending');assert.equal(created.value.task.channel,channel.id);
  assert.equal(created.value.task.assistantId,'daily');assert.equal(created.value.task.dueAt,new Date(dueAt).toISOString());
  assert.ok(Date.parse(created.value.task.dueAt)>Date.now()+10*60*1000,'leave execution tomorrow, never send to QQ during this test');
  const duplicate=await post('/internal/assistant-tools',tool);
  assert.equal(duplicate.status,200);assert.equal(duplicate.value.ok,true);assert.equal(duplicate.value.duplicate,true);
  assert.equal(duplicate.value.task.id,created.value.task.id);assert.equal(app.store.state.tasks.length,1);
  const storedTask=app.store.state.tasks[0];
  assert.equal(storedTask.chatId,chat.id);assert.equal(storedTask.ownerId,'local-user');assert.equal(storedTask.requestMessageId,user.id);

  const next=await post('/internal/inbound-trusted',event({messageId:'synthetic-native-message-2',userText:'先不用设新的提醒了，普通聊聊天'}));
  assert.equal(next.status,200);assert.notEqual(next.value.messageId,user.id);
  const stale=await post('/internal/assistant-tools',tool);
  assert.equal(stale.status,409);assert.equal(stale.value.ok,false);
  assert.equal(chat.messages.findLast(item=>item.role==='user').id,next.value.messageId);
  assert.equal(app.store.state.tasks.length,1);assert.equal(web.messages.length,0);
  const disk=JSON.parse(readFileSync(app.store.file,'utf8'));
  assert.equal(disk.tasks.length,1);assert.equal(disk.tasks[0].requestMessageId,user.id);
  assert.equal(disk.chats.find(item=>item.id===chat.id).messages.filter(item=>item.nativeMessageId===received.messageId).length,1);
  assert.deepEqual(unexpectedRequests,[]);assert.equal(app.runtime.child,null);
});

test('HTTP bridge rejects group and foreign sender events, unverified channels and every non-task external capability',async t=>{
  const {app,channel,event,post,dueAt,unexpectedRequests}=await fixture(t);
  const invalid=[event({umo:`${channel.nativeId}:GroupMessage:synthetic-group`,sessionId:'synthetic-group'}),event({senderId:'someone-else'}),event({senderId:'someone-else',sessionId:'someone-else',umo:`${channel.nativeId}:FriendMessage:someone-else`}),event({messageId:''})];
  for(const payload of invalid){
    for(const path of ['/internal/inbound-trusted','/internal/assistant-tools']){
      const result=await post(path,{...payload,name:'schedule_reminder',args:{title:'测试私聊定时',dueAt}});
      assert.ok([400,403].includes(result.status),'invalid native identities never enter a private conversation');
    }
  }
  channel.status='sent';
  assert.equal((await post('/internal/inbound-trusted',event())).status,400);
  assert.equal((await post('/internal/assistant-tools',{...event(),name:'schedule_reminder',args:{title:'测试私聊定时',dueAt}})).status,400);
  channel.status='verified';
  for(const name of ['search_web','read_file','voice_reply','send_sticker']){
    const denied=await post('/internal/assistant-tools',{...event(),name,args:{}});
    assert.equal(denied.status,403);assert.equal(denied.value.ok,false);
  }
  assert.equal(app.store.state.tasks.length,0);assert.equal(app.store.state.chats.filter(chat=>chat.origin==='channel').length,0);
  assert.deepEqual(unexpectedRequests,[]);assert.equal(app.runtime.child,null);
});

test('tool arguments cannot substitute user authorization or invent a time through the real native bridge',async t=>{
  const {app,event,post,dueAt,unexpectedRequests}=await fixture(t);
  const ordinary=event({userText:'你好，今天聊什么？'});
  const refused=await post('/internal/assistant-tools',{...ordinary,name:'schedule_reminder',args:{title:'伪造提醒',dueAt}});
  assert.equal(refused.status,200);assert.equal(refused.value.ok,false);assert.equal(refused.value.error.code,'NEEDS_AUTHORIZATION');
  const mismatched=await post('/internal/assistant-tools',{...event({messageId:'synthetic-native-message-3'}),name:'schedule_reminder',args:{title:'测试私聊定时',dueAt:dueAt.replace('T07:00','T08:00')}});
  assert.equal(mismatched.status,200);assert.equal(mismatched.value.ok,false);assert.equal(mismatched.value.error.code,'TIME_MISMATCH');
  assert.equal(app.store.state.tasks.length,0);assert.deepEqual(unexpectedRequests,[]);
});
