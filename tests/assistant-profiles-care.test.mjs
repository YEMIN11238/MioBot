import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';
import {ASSISTANT_PRESETS,DEFAULT_CARE,validateSkills,validateCare,conversationalParts} from '../server/assistant-profiles.mjs';
import {CareScheduler,quietTime} from '../server/care.mjs';
import {proactiveDeliveryKey,PROACTIVE_SOURCE} from '../integrations/proactive/policy.mjs';

const noon=Date.parse('2026-11-02T12:00:00+08:00');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function careFixture(run,{enabled=true,care={},reply='刚才那场面试，想吐槽的话我听着。\n先喘口气。',policy,assistantId='daily'}={}){
  const root=mkdtempSync(join(tmpdir(),'miobot-care-'));
  let clock=noon;
  const store=new Store(root),calls=[],notices=[],policyCalls=[];
  // Store persists the fixture clock so day limits do not depend on host time.
  const realMessage=store.message.bind(store);
  store.message=(...args)=>{const message=realMessage(...args);message.createdAt=new Date(clock).toISOString();store.save();return message;};
  const assistant=store.assistant(assistantId);assistant.enabled=true;assistant.skills=['memory','reminders','humanize'];assistant.care={...DEFAULT_CARE,enabled,...care};
  const chat=store.createChat(assistant.id);
  const user=store.message(chat.id,'user','今天面试有点紧张。',{status:'complete'});
  user.createdAt=new Date(clock-3*3600000).toISOString();store.save();
  const runtime={status:'ready',proactivePolicy:async payload=>{policyCalls.push(payload);return policy?policy(payload):{allowed:true,reason:'eligible',scopeKey:proactiveDeliveryKey(payload.scope),source:PROACTIVE_SOURCE,prompt:'Native policy fixture with real context:\n'+JSON.stringify(payload.messages)};},chat:async (...args)=>{calls.push(args);return typeof reply==='function'?reply(...args):reply;},safeError:error=>'safe: '+error.message};
  const scheduler=new CareScheduler(store,runtime,{now:()=>clock,onNotify:notice=>notices.push(notice)});
  try{await run({root,store,assistant,chat,user,runtime,scheduler,calls,notices,policyCalls,now:()=>clock,advance:milliseconds=>{clock+=milliseconds;}});}
  finally{scheduler.close();rmSync(root,{recursive:true,force:true});}
}

test('assistant role capabilities reject wrong-role tools and invalid care schedules',()=>{
  assert.deepEqual(validateSkills(['memory','minecraft','minecraft'],'game'),['memory','minecraft']);
  assert.throws(()=>validateSkills(['minecraft'],'daily'),/仅用于游戏助手/);
  assert.throws(()=>validateSkills(['minecraft'],'career'),/仅用于游戏助手/);
  assert.throws(()=>validateSkills(['arbitrary-shell'],'game'),/无效/);
  assert.throws(()=>validateSkills('memory','daily'),/无效/);
  assert.deepEqual(validateCare({},'daily'),DEFAULT_CARE);
  for(const kind of ['daily','game','career'])assert.equal(validateCare({enabled:true},kind).enabled,true);
  for(const invalid of [{idleMinutes:9},{idleMinutes:10081},{idleMinutes:'120'},{quietStart:24},{quietEnd:-1},{quietEnd:8.5},{maxPerDay:0},{maxPerDay:4}])assert.throws(()=>validateCare(invalid,'daily'),/时间或频率无效/);
  assert.ok(ASSISTANT_PRESETS.daily.skills.includes('humanize'));
  assert.ok(ASSISTANT_PRESETS.game.skills.includes('minecraft'));
  assert.ok(!ASSISTANT_PRESETS.career.skills.includes('minecraft'));
});

test('conversation formatting splits brief replies while preserving code and task instructions',()=>{
  assert.deepEqual(conversationalParts('先歇会儿。\n想吐槽的话我听着。',true),['先歇会儿。','想吐槽的话我听着。']);
  assert.deepEqual(conversationalParts('先歇会儿。\n想吐槽的话我听着。',false),['先歇会儿。\n想吐槽的话我听着。']);
  assert.deepEqual(conversationalParts('第一句\n第二句\n第三句\n第四句',true),['第一句','第二句','第三句\n第四句']);
  const code='这段代码可以试试。\n```js\nconsole.log("hello");\n```';
  const task='1. 保存当前配置\n2. 检查连接结果\n3. 发送一条消息';
  const bullets='材料如下。\n- 木板\n- 木棍';
  const long='这是需要保持完整的解释。'.repeat(55);
  for(const text of [code,task,bullets,long])assert.deepEqual(conversationalParts(text,true),[text]);
});

test('quiet hours use Beijing time, cover overnight periods, and equal hours mute the whole day',()=>{
  const at=hour=>Date.parse(`2026-11-02T${String(hour).padStart(2,'0')}:00:00+08:00`);
  assert.equal(quietTime(at(23),DEFAULT_CARE),true);
  assert.equal(quietTime(at(7),DEFAULT_CARE),true);
  assert.equal(quietTime(at(8),DEFAULT_CARE),false);
  assert.equal(quietTime(at(12),DEFAULT_CARE),false);
  for(let hour=0;hour<24;hour++)assert.equal(quietTime(at(hour),{quietStart:8,quietEnd:8}),true);
  assert.equal(quietTime(at(12),{quietStart:10,quietEnd:14}),true);
  assert.equal(quietTime(at(14),{quietStart:10,quietEnd:14}),false);
});

test('care is opt-in and never calls a model when disabled, quiet, disconnected, or busy',async()=>{
  await careFixture(async({scheduler,calls,notices})=>{await scheduler.tick();assert.equal(calls.length,0);assert.equal(notices.length,0);},{enabled:false});
  await careFixture(async({scheduler,calls})=>{await scheduler.tick();assert.equal(calls.length,0);},{care:{quietStart:8,quietEnd:8}});
  await careFixture(async({scheduler,runtime,calls})=>{runtime.status='disconnected';await scheduler.tick();assert.equal(calls.length,0);});
  await careFixture(async({store,runtime,now,calls})=>{const scheduler=new CareScheduler(store,runtime,{now,isBusy:()=>true});try{await scheduler.tick();assert.equal(calls.length,0);}finally{scheduler.close();}});
});

test('idle care uses an isolated background request and sends at most once per unanswered user turn',async()=>careFixture(async({store,assistant,chat,user,scheduler,calls,notices,now,advance})=>{
  user.createdAt=new Date(now()-30*60000).toISOString();store.save();
  await scheduler.tick();assert.equal(calls.length,0,'no early check-in before the chosen idle interval');
  advance(91*60000);await scheduler.tick();
  assert.equal(calls.length,1);assert.equal(calls[0][0].id,chat.id);assert.equal(calls[0][2].background,true);
  assert.ok(calls[0][1].includes('今天面试有点紧张。'),'background prompt uses actual recent chat');
  assert.equal(chat.messages.filter(m=>m.role==='user').length,1,'care prompt must not become a user message');
  assert.equal(chat.messages.filter(m=>m.source==='care').length,1);assert.equal(notices.length,1);assert.equal(notices[0].type,'care');
  assert.deepEqual(chat.messages.at(-1).parts,['刚才那场面试，想吐槽的话我听着。','先喘口气。']);
  advance(3*3600000);await scheduler.tick();assert.equal(calls.length,1,'silence after one check-in must not trigger another');
  assistant.care.maxPerDay=3;
  advance(1000);store.message(chat.id,'user','现在愿意聊聊了。',{status:'complete'});
  advance(121*60000);await scheduler.tick();
  assert.equal(calls.length,2,'a fresh real user turn can allow one later check-in');
  await scheduler.tick();assert.equal(calls.length,2);
}));

test('daily care cap is shared by all chats of the same assistant',async()=>careFixture(async({store,assistant,chat,scheduler,calls,advance})=>{
  await scheduler.tick();assert.equal(calls.length,1);
  const second=store.createChat(assistant.id);
  const turn=store.message(second.id,'user','另一段对话。',{status:'complete'});turn.createdAt=new Date(noon-3*3600000).toISOString();store.save();
  advance(60*60000);await scheduler.tick();assert.equal(calls.length,1,'another conversation cannot bypass the daily cap');
  assert.equal(chat.messages.filter(m=>m.source==='care').length,1);assert.equal(second.messages.filter(m=>m.source==='care').length,0);
}));

test('new messages, disabling care, and shutdown discard in-flight care results',async()=>{
  for(const action of ['new-user-turn','disable','close']){
    const pending=deferred();
    await careFixture(async({store,assistant,chat,scheduler,calls,notices,advance})=>{
      const running=scheduler.tick();await Promise.resolve();assert.equal(calls.length,1);
      await scheduler.tick();assert.equal(calls.length,1,'concurrent ticks cannot duplicate an in-flight request');
      if(action==='new-user-turn'){advance(1000);store.message(chat.id,'user','先回答我现在这个问题。',{status:'complete'});}
      if(action==='disable'){assistant.care.enabled=false;store.save();}
      if(action==='close')scheduler.close();
      pending.resolve('这条过期关心不应投递。');await running;
      assert.equal(chat.messages.filter(m=>m.source==='care').length,0,action);
      assert.equal(notices.length,0,action);assert.equal(scheduler.running.size,0,action);
    },{reply:()=>pending.promise});
  }
});

test('failed check-ins retain safe error and bounded retry information without posting success',async()=>careFixture(async({root,store,chat,runtime,scheduler,calls,notices,now,advance})=>{
  runtime.chat=async(...args)=>{calls.push(args);throw new Error('fixture upstream unavailable');};
  await scheduler.tick();assert.equal(calls.length,1);assert.equal(notices.length,0);
  assert.equal(chat.messages.filter(m=>m.source==='care').length,0);
  assert.equal(chat.careError,'safe: fixture upstream unavailable');
  assert.equal(Date.parse(chat.careRetryAt),now()+3600000);
  const reloaded=new Store(root).chat(chat.id);assert.equal(reloaded.careError,chat.careError);assert.equal(reloaded.careRetryAt,chat.careRetryAt);
  advance(3599000);await scheduler.tick();assert.equal(calls.length,1,'retry must wait at least one hour');
  advance(1000);runtime.chat=async(...args)=>{calls.push(args);return '刚才没连上，现在在了。';};await scheduler.tick();
  assert.equal(calls.length,2);assert.equal(chat.messages.filter(m=>m.source==='care').length,1);assert.equal(notices.length,1);
  assert.equal(chat.careError,undefined);assert.equal(chat.careRetryAt,undefined);
}));

function verifiedChannel(store,assistant,patch={}){
  const channel={id:'fixture-private-channel',assistantId:assistant.id,type:'discord',status:'verified',enabled:true,supportProactive:true,target:'FriendMessage:fixture-recipient',...patch};
  store.state.channels.push(channel);assistant.care.deliveryChannel=channel.id;store.save();return channel;
}
const nativePolicy=payload=>({allowed:true,reason:'eligible',scopeKey:proactiveDeliveryKey(payload.scope),source:PROACTIVE_SOURCE,prompt:'Native policy fixture:\n'+JSON.stringify(payload.messages)});

test('native policy receives one bound private scope and only six bounded real messages before a tool-free model call',async()=>careFixture(async({store,chat,user,assistant,scheduler,policyCalls,calls,now})=>{
  for(let i=0;i<9;i++){const message=store.message(chat.id,i%2?'assistant':'user','真实记录'+i+'。'.repeat(1500),{status:'complete'});message.createdAt=new Date(now()-3*3600000+i).toISOString();}
  store.message(chat.id,'assistant','不可加入的失败消息',{status:'error'});store.message(chat.id,'assistant','不可加入的取消消息',{status:'cancelled'});store.message(chat.id,'assistant','不可加入的流式消息',{status:'streaming'});store.save();
  await scheduler.tick();assert.equal(policyCalls.length,1);assert.equal(calls.length,1);
  const payload=policyCalls[0];assert.deepEqual(payload.scope,{instanceId:store.state.instanceId,assistantId:assistant.id,userId:'local-user',sessionId:chat.id,channelId:'web'});assert.equal(Object.hasOwn(payload.scope,'chatId'),false);assert.equal(payload.messages.length,6);assert.ok(payload.messages.every(message=>message.text.length<=1200&&['user','assistant'].includes(message.role)));assert.ok(payload.messages.every(message=>!message.text.includes('不可加入')));assert.equal(payload.now,new Date(now()).toISOString());assert.equal(payload.sentToday,0);assert.equal(payload.lastUserAt,chat.messages.filter(message=>message.role==='user').at(-1).createdAt);
  assert.equal(calls[0][1],nativePolicy(payload).prompt.replace('Native policy fixture:','Native policy fixture with real context:'));assert.deepEqual(calls[0][2].tools,[]);assert.equal(calls[0][2].background,true);assert.equal(calls[0][2].signal.aborted,false);assert.equal(chat.carePolicy.scopeKey,proactiveDeliveryKey(payload.scope));assert.equal(chat.messages.filter(message=>message.role==='user').length,6);
}));

test('disallowed native policy never calls a model, and missing, failed or mismatched policy remains a real error',async()=>{
  await careFixture(async({runtime,scheduler,calls,chat,notices,policyCalls})=>{
    runtime.proactivePolicy=async payload=>{policyCalls.push(payload);return {...nativePolicy(payload),allowed:false,reason:'awaiting_user_reply',prompt:undefined};};
    await scheduler.tick();assert.equal(calls.length,0);assert.equal(notices.length,0);assert.equal(chat.carePolicy.allowed,false);assert.equal(chat.carePolicy.reason,'awaiting_user_reply');assert.equal(chat.careError,undefined);
  });
  for(const mode of ['missing','failed','wrong-scope','wrong-source','invalid'])await careFixture(async({runtime,scheduler,calls,chat,notices})=>{
    if(mode==='missing')delete runtime.proactivePolicy;
    else runtime.proactivePolicy=async payload=>{if(mode==='failed')throw Error('fixture native policy unavailable');const policy=nativePolicy(payload);return mode==='wrong-scope'?{...policy,scopeKey:'other-user'}:mode==='wrong-source'?{...policy,source:{...PROACTIVE_SOURCE,revision:'unverified'}}:null;};
    await scheduler.tick();assert.equal(calls.length,0,mode);assert.equal(notices.length,0,mode);assert.ok(chat.careError,mode);assert.equal(chat.messages.filter(message=>message.source==='care').length,0,mode);
  });
});

test('a new user turn, disabled care or closing during native policy prevents even the model request',async()=>{
  for(const action of ['new-user','other-chat-user','disable','close']){
    const pending=deferred();await careFixture(async({runtime,scheduler,store,assistant,chat,calls,notices,advance})=>{
      let payload;runtime.proactivePolicy=async value=>{payload=value;return pending.promise;};const running=scheduler.tick();assert.ok(payload);
      if(action==='new-user'){advance(1000);store.message(chat.id,'user','现在先回答我。',{status:'complete'});}
      if(action==='other-chat-user'){advance(1000);const other=store.createChat(assistant.id);store.message(other.id,'user','我在另一个对话问问题。',{status:'complete'});}
      if(action==='disable')assistant.care.enabled=false;if(action==='close')scheduler.close();pending.resolve(nativePolicy(payload));await running;
      assert.equal(calls.length,0,action);assert.equal(notices.length,0,action);assert.equal(scheduler.running.size,0,action);
    });
  }
});

test('external care validates the same verified assistant channel and persists sending then accepted without claiming receipt',async()=>careFixture(async({root,store,assistant,chat,user,scheduler,notices,policyCalls})=>{
  const channel=verifiedChannel(store,assistant),delivered=[];
  scheduler.deliver=async(...args)=>{delivered.push(args);const persisted=new Store(root).chat(chat.id).careDeliveries.at(-1);assert.equal(persisted.status,'sending');assert.equal(persisted.channelId,channel.id);assert.equal(persisted.userMessageId,user.id);assert.match(persisted.logs[0].text,/尚未确认用户收到/);return {status:'accepted'};};
  await scheduler.tick();assert.equal(delivered.length,1);assert.equal(delivered[0][0].id,assistant.id);assert.equal(delivered[0][1],channel.id);assert.equal(policyCalls[0].scope.channelId,channel.id);
  const record=chat.careDeliveries[0],message=chat.messages.at(-1);assert.equal(record.status,'accepted');assert.equal(record.messageId,message.id);assert.equal(record.superseded,false);assert.equal(message.delivery.status,'accepted');assert.equal(message.delivery.received,false);assert.equal(message.delivery.read,false);assert.match(record.logs.at(-1).text,/不代表用户已收到或已读/);assert.equal(notices.length,1);assert.equal(notices[0].received,false);assert.equal(notices[0].deliveryStatus,'accepted');assert.equal(scheduler.sentToday(assistant),1,'history message and matching delivery record count only once');
}));

test('unverified, disabled, wrong-assistant and targetless external channels do not request policy, model or delivery',async()=>{
  for(const patch of [{status:'configured'},{enabled:false},{assistantId:'game'},{supportProactive:false},{target:''}])await careFixture(async({store,assistant,scheduler,calls,policyCalls,chat})=>{
    verifiedChannel(store,assistant,patch);let sent=0;scheduler.deliver=async()=>{sent++;return {status:'accepted'};};await scheduler.tick();assert.equal(policyCalls.length,0);assert.equal(calls.length,0);assert.equal(sent,0);assert.ok(chat.careError);assert.equal(chat.careDeliveries,undefined);
  });
  await careFixture(async({store,assistant,scheduler,calls,chat})=>{verifiedChannel(store,assistant);await scheduler.tick();assert.equal(calls.length,0);assert.match(chat.careError,/投递服务/);});
});

test('uncertain external failures never post success or auto-retry, persist across restart, and unlock only on a new turn or activation',async()=>{
  for(const unlock of ['new-user','manual-enable'])await careFixture(async({root,store,assistant,chat,user,runtime,scheduler,calls,notices,now,advance})=>{
    assistant.care.maxPerDay=3;assistant.care.activationId='fixture-activation';verifiedChannel(store,assistant);let delivered=0;
    scheduler.deliver=async()=>{delivered++;throw Error('fixture send result unknown');};await scheduler.tick();assert.equal(delivered,1);assert.equal(calls.length,1);assert.equal(notices.length,0);assert.equal(chat.messages.filter(message=>message.source==='care').length,0);assert.equal(chat.careDeliveries[0].status,'uncertain');assert.equal(chat.careDeliveryBlock.userMessageId,user.id);assert.match(chat.careError,/不会自动重发/);assert.equal(chat.careRetryAt,undefined);
    advance(2*3600000);await scheduler.tick();assert.equal(delivered,1,'waiting does not release an uncertain send');
    const disk=new Store(root),restarted=new CareScheduler(disk,runtime,{now,deliver:async()=>{delivered++;return {status:'accepted'};}});try{await restarted.tick();assert.equal(delivered,1,'restart does not release the persisted block');}finally{restarted.close();}
    if(unlock==='new-user'){advance(1000);store.message(chat.id,'user','现在可以再聊了。',{status:'complete'});advance(121*60000);}else assistant.care.activationId='manual-new-activation';
    scheduler.deliver=async()=>{delivered++;return {status:'accepted'};};await scheduler.tick();assert.equal(delivered,2,unlock);assert.equal(chat.messages.filter(message=>message.source==='care').length,1,unlock);assert.equal(chat.careDeliveries[1].status,'accepted');assert.equal(chat.careDeliveryBlock,undefined);assert.equal(notices.length,1);
  });
});

test('startup converts interrupted sending into an uncertain blocked attempt rather than silently resending',async()=>careFixture(async({root,store,assistant,chat,user,runtime,now,calls})=>{
  verifiedChannel(store,assistant);assistant.care.maxPerDay=3;assistant.care.activationId='activation-before-crash';chat.careDeliveries=[{id:'interrupted-attempt',assistantId:assistant.id,chatId:chat.id,userMessageId:user.id,channelId:assistant.care.deliveryChannel,activationId:assistant.care.activationId,status:'sending',attemptedAt:new Date(now()).toISOString(),logs:[]}];store.save();let sent=0;
  const recovered=new CareScheduler(store,runtime,{now,deliver:async()=>{sent++;return {status:'accepted'};}});try{assert.equal(chat.careDeliveries[0].status,'uncertain');assert.match(chat.careError,/应用在渠道发送期间停止/);await recovered.tick();assert.equal(calls.length,0);assert.equal(sent,0);assert.equal(new Store(root).chat(chat.id).careDeliveryBlock.attemptId,'interrupted-attempt');assert.equal(recovered.sentToday(assistant),1);}finally{recovered.close();}
}));

test('channel changes while generating suppress delivery; late accepted sends are recorded truthfully without a stale notification',async()=>{
  const pending=deferred();await careFixture(async({store,assistant,scheduler,chat,notices})=>{const channel=verifiedChannel(store,assistant);let sent=0;scheduler.deliver=async()=>{sent++;return {status:'accepted'};};const running=scheduler.tick();await Promise.resolve();channel.enabled=false;pending.resolve('现在不该发送。');await running;assert.equal(sent,0);assert.equal(notices.length,0);assert.equal(chat.careDeliveries,undefined);},{reply:()=>pending.promise});
  for(const action of ['new-user','disable','close'])await careFixture(async({store,assistant,scheduler,chat,notices,advance})=>{
    verifiedChannel(store,assistant);const accepted=deferred();let sent=0;scheduler.deliver=async()=>{sent++;return accepted.promise;};const running=scheduler.tick();await new Promise(setImmediate);assert.equal(sent,1);
    if(action==='new-user'){advance(1000);store.message(chat.id,'user','先回答这个。',{status:'complete'});}if(action==='disable')assistant.care.enabled=false;if(action==='close')scheduler.close();accepted.resolve({status:'accepted'});await running;
    assert.equal(chat.careDeliveries[0].status,'accepted',action);assert.equal(chat.careDeliveries[0].superseded,true,action);assert.equal(chat.messages.filter(message=>message.source==='care').length,1,'already accepted external sends must remain in history');assert.equal(chat.messages.at(-1).delivery.received,false);assert.equal(notices.length,0,action);assert.equal(sent,1);
  });
});

test('game and career assistants opt into the same private policy without replacing their own persona',async()=>{
  for(const assistantId of ['game','career']){
    await careFixture(async({scheduler,calls,policyCalls,notices})=>{await scheduler.tick();assert.equal(calls.length,0);assert.equal(policyCalls.length,0);assert.equal(notices.length,0);},{assistantId,enabled:false});
    await careFixture(async({store,assistant,chat,scheduler,calls,policyCalls,notices,advance})=>{
      const persona=assistant.persona,skills=[...assistant.skills];await scheduler.tick();assert.equal(calls.length,1);assert.equal(policyCalls.length,1);assert.equal(policyCalls[0].scope.assistantId,assistantId);assert.equal(policyCalls[0].scope.sessionId,chat.id);assert.equal(policyCalls[0].scope.userId,'local-user');assert.equal(calls[0][0].assistantId,assistantId);assert.equal(calls[0][2].background,true);assert.deepEqual(calls[0][2].tools,[]);assert.equal(store.assistant(assistantId).persona,persona);assert.equal(persona,ASSISTANT_PRESETS[assistantId].persona,'proactive care must keep the selected role persona');assert.deepEqual(assistant.skills,skills);assert.equal(notices.length,1);assert.equal(notices[0].assistantId,assistantId);
      advance(3*3600000);await scheduler.tick();assert.equal(calls.length,1,'silence must not repeat care for another role either');
    },{assistantId});
  }
});
