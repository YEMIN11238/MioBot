import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';
import {recordPrivateInbound} from '../server/private-inbound.mjs';

const NOW=Date.parse('2026-11-02T22:00:00+08:00');
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'miobot-private-inbound-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=new Store(root),web=store.createChat('daily');
  function channel(type='aiocqhttp',suffix='fixture-channel',senderId='synthetic-sender'){
    const item={id:suffix,name:'合成测试渠道',type,assistantId:'daily',enabled:true,supportProactive:true,status:'verified',verifiedAt:new Date(NOW-1000).toISOString(),target:`${type}:FriendMessage:${senderId}`,nativeId:`pa-${store.state.instanceId}-${suffix}`};
    store.state.channels.push(item);return item;
  }
  const first=channel();
  function payload(c=first,overrides={}){return {platform:c.type,umo:`${c.nativeId}:FriendMessage:synthetic-sender`,sessionId:'synthetic-sender',senderId:'synthetic-sender',userText:'明天早上7点叫我起床',messageId:'native-message-1',...overrides};}
  const call=(data,options={})=>recordPrivateInbound(store,data,{now:NOW,...options});
  return {store,web,first,channel,payload,call};
}

test('actual managed native UMO binds verified private sender and stores a separate local owner conversation',t=>{
  const {store,web,first,payload,call}=fixture(t),data=payload(),result=call({...data,assistantId:'career',ownerId:'forged-owner',createdAt:'1900-01-01'});
  assert.equal(result.channel,first);assert.equal(result.assistant.id,'daily');assert.notEqual(result.chat.id,web.id);
  assert.equal(result.chat.origin,'channel');assert.equal(result.chat.ownerId,'local-user');assert.equal(result.chat.nativeUmo,data.umo);
  assert.equal(result.user.nativeMessageId,data.messageId);assert.equal(result.user.text,data.userText);assert.equal(result.user.createdAt,new Date(NOW).toISOString());
  assert.equal(result.user.source,'channel');assert.equal(result.user.status,'complete');assert.equal(web.messages.length,0);
  const restored=new Store(store.root),saved=restored.chat(result.chat.id);assert.equal(saved.messages[0].nativeMessageId,data.messageId);assert.equal(saved.ownerId,'local-user');
});

test('OneBot, official QQ and Telegram require their actual private sender-session equivalence',t=>{
  const {store,channel,payload,call}=fixture(t);
  for(const type of ['aiocqhttp','qq_official','telegram']){
    const c=channel(type,'channel-'+type),data=payload(c),result=call(data);assert.equal(result.channel.id,c.id);
    c.target=`${c.nativeId}:FriendMessage:synthetic-sender`;
    assert.equal(call(data).chat.id,result.chat.id,'exact nativeId target is sendChannel-equivalent');
  }
  assert.equal(store.state.chats.filter(c=>c.origin==='channel').length,3);
});

test('retries are idempotent, preserve original receipt time and cannot replace the latest user authorization',t=>{
  const {payload,call}=fixture(t),data=payload(),first=call(data);
  const duplicate=call(data,{now:NOW+1000});assert.equal(duplicate.user,first.user);assert.equal(first.chat.messages.length,1);
  assert.equal(duplicate.user.createdAt,new Date(NOW).toISOString());
  const second=call(payload(undefined,{messageId:'native-message-2',userText:'不用了，先别设提醒'}),{now:NOW+2000});
  const replay=call(data,{now:NOW+3000});assert.equal(replay.user.id,first.user.id);
  assert.equal(replay.chat.messages.findLast(m=>m.role==='user').id,second.user.id);assert.equal(replay.chat.messages.length,2);
  assert.throws(()=>call({...data,userText:'伪造改写内容'}),{code:'PRIVATE_MESSAGE_ID_CONFLICT'});
});

test('group, different sender, wrong native prefix, missing message ID and unknown adapter are rejected without mutation',t=>{
  const {store,payload,call}=fixture(t),original=JSON.stringify(store.state.chats);
  const bad=[payload(undefined,{umo:'wrong:GroupMessage:synthetic-sender'}),payload(undefined,{senderId:'someone-else'}),payload(undefined,{sessionId:'someone-else'}),payload(undefined,{umo:'wrong:FriendMessage:synthetic-sender'}),payload(undefined,{messageId:''}),payload(undefined,{messageId:undefined}),payload(undefined,{platform:'unrecognized'}),payload(undefined,{platform:'discord'}),payload(undefined,{userText:'x'.repeat(16001)}),payload(undefined,{userText:''})];
  for(const data of bad)assert.throws(()=>call(data));
  assert.equal(JSON.stringify(store.state.chats),original);
});

test('disabled, unverified, wrong target, unsupported proactive and mismatched assistant bindings are refused',t=>{
  const {store,first,payload,call}=fixture(t),original=JSON.stringify(store.state.chats);
  const changes=[{enabled:false},{supportProactive:false},{status:'sent'},{verifiedAt:undefined},{target:'aiocqhttp:GroupMessage:synthetic-sender'},{target:'aiocqhttp:FriendMessage:other-person'},{target:'invented-prefix:FriendMessage:synthetic-sender'},{nativeId:'arbitrary-unmanaged-bot'},{assistantId:'unknown-assistant'},{ownerId:'different-owner'}];
  const baseline={...first};
  for(const patch of changes){Object.assign(first,baseline,patch);assert.throws(()=>call(payload()),undefined,JSON.stringify(patch));delete first.ownerId;}
  Object.assign(first,baseline);store.assistant('daily').enabled=false;assert.throws(()=>call(payload()),{code:'PRIVATE_ASSISTANT_DISABLED'});
  assert.equal(JSON.stringify(store.state.chats),original);
});

test('ambiguous bindings and existing foreign owner conversations fail closed',t=>{
  const {store,first,payload,call}=fixture(t);store.state.channels.push({...first});
  assert.throws(()=>call(payload()),{code:'AMBIGUOUS_PRIVATE_CHANNEL'});store.state.channels.pop();
  const firstResult=call(payload());firstResult.chat.ownerId='foreign-owner';
  assert.throws(()=>call(payload()),{code:'PRIVATE_CHAT_BINDING_MISMATCH'});
});

test('assistant rebinds start independent context and never adopt the original assistant or webchat history',t=>{
  const {store,first,web,payload,call}=fixture(t),initial=call(payload());
  first.assistantId='game';store.assistant('game').enabled=true;
  const rebound=call(payload(undefined,{messageId:'native-game-message'}));
  assert.notEqual(initial.chat.id,rebound.chat.id);assert.equal(rebound.chat.assistantId,'game');assert.equal(initial.chat.assistantId,'daily');
  assert.equal(rebound.chat.messages.length,1);assert.equal(web.messages.length,0);
});

test('a failed persistent write rolls back a new conversation or pending received message',t=>{
  const {store,payload,call}=fixture(t),data=payload(),save=store.save.bind(store),before=store.state.chats.length;
  store.save=()=>{throw Error('synthetic disk failure');};
  assert.throws(()=>call(data),/synthetic disk failure/);assert.equal(store.state.chats.length,before);
  store.save=save;const first=call(data);store.save=()=>{throw Error('synthetic disk failure');};
  assert.throws(()=>call({...data,messageId:'second-message'}),/synthetic disk failure/);assert.equal(first.chat.messages.length,1);
  store.save=save;
});
