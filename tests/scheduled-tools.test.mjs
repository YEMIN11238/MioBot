import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store,Scheduler} from '../server/store.mjs';
import {handleTaskTool,requestedReminderTime} from '../server/scheduled-tools.mjs';

const noon=Date.parse('2026-11-02T12:00:00+08:00'),tomorrow='2026-11-03T07:00:00+08:00';
function fixture(fn){const root=mkdtempSync(join(tmpdir(),'miobot-task-tools-')),store=new Store(root),chat=store.createChat('daily'),scope={assistantId:'daily',chatId:chat.id,ownerId:'private-owner',channel:'web'};const user=(text,at=noon)=>{const m=store.message(chat.id,'user',text,{status:'complete'});m.createdAt=new Date(at).toISOString();return m;};const call=(name,args={},opts={})=>handleTaskTool(store,scope,name,args,{now:noon,...opts});try{return fn({root,store,chat,scope,user,call});}finally{rmSync(root,{recursive:true,force:true});}}

test('an explicit natural-language request creates a confirmed one-time task that the real scheduler delivers exactly once',()=>fixture(({store,user,call})=>{
  user('明天早上7点叫我起床');const made=call('schedule_reminder',{title:'起床啦',dueAt:tomorrow});assert.equal(made.ok,true);assert.equal(made.task.status,'pending');assert.equal(made.task.dueAt,'2026-11-02T23:00:00.000Z');assert.equal(made.timeZone,'Asia/Shanghai');
  const notices=[],scheduler=new Scheduler(store,{now:()=>Date.parse(made.task.dueAt),onNotify:n=>notices.push(n)});scheduler.tick();scheduler.tick();assert.equal(notices.length,1);assert.equal(store.state.tasks[0].status,'done');assert.equal(store.state.notifications.length,1);
}));

test('missing time, invented time, non-reminder statements and recurrence never create a fake successful task',()=>fixture(({store,user,call})=>{
  for(const [text,dueAt,code] of [['明天早上叫我起床',tomorrow,'NEEDS_TIME'],['明天7点叫我起床','2026-11-03T09:00:00+08:00','TIME_MISMATCH'],['我明天7点起床',tomorrow,'NEEDS_AUTHORIZATION'],['每天7点提醒我起床',tomorrow,'RECURRENCE_NOT_SUPPORTED']]){user(text);const r=call('schedule_reminder',{title:'起床',dueAt});assert.equal(r.ok,false,text);assert.equal(r.error.code,code,text);}assert.equal(store.state.tasks.length,0);
}));

test('clarification can complete an existing real reminder request while keeping its original relative date',()=>fixture(({store,chat,user,call})=>{
  user('明天早上叫我起来',Date.parse('2026-11-02T23:59:00+08:00'));store.message(chat.id,'assistant','明天具体几点叫你？',{status:'complete'});user('早上七点',Date.parse('2026-11-03T00:01:00+08:00'));
  const result=call('schedule_reminder',{title:'起床',dueAt:tomorrow},{now:Date.parse('2026-11-03T00:01:10+08:00')});assert.equal(result.ok,true);assert.equal(result.task.dueAt,'2026-11-02T23:00:00.000Z');
}));

test('relative reminders are anchored to the real user request and tool retries cannot schedule duplicates',()=>fixture(({store,user,call})=>{
  user('两分钟后提醒我喝水');const args={title:'喝水',dueAt:'2026-11-02T12:02:05+08:00'};
  const first=call('schedule_reminder',args,{now:noon+5000}),retry=call('schedule_reminder',{...args,title:'记得喝水'},{now:noon+10000});assert.equal(first.ok,true);assert.equal(first.task.dueAt,'2026-11-02T04:02:00.000Z');assert.equal(retry.duplicate,true);assert.equal(first.task.id,retry.task.id);assert.equal(store.state.tasks.length,1);
}));

test('tool arguments cannot choose another assistant, recipient, arbitrary URL or malformed timezone',()=>fixture(({store,user,call})=>{
  user('明天7点提醒我起床');for(const extra of [{assistantId:'game'},{ownerId:'other'},{channel:'qq'},{url:'https://example.invalid'},{repeat:'daily'}]){const r=call('schedule_reminder',{title:'起床',dueAt:tomorrow,...extra});assert.equal(r.error.code,'INVALID_ARGUMENTS');}
  for(const dueAt of ['2026-11-03T07:00:00','2026-02-30T07:00:00+08:00','2026-11-03T25:00:00+08:00'])assert.equal(call('schedule_reminder',{title:'起床',dueAt}).error.code,'INVALID_TIME_FORMAT');assert.equal(store.state.tasks.length,0);
}));

test('QQ-specific requests do not silently fall back to an app-only notification',()=>fixture(({store,scope,user,call})=>{
  user('明天早上7点在QQ上叫我起床');const args={title:'起床',dueAt:tomorrow};assert.equal(call('schedule_reminder',args).error.code,'CHANNEL_NOT_CONNECTED');
  const channel={id:'qq',type:'aiocqhttp',assistantId:'daily',enabled:true,target:'qq:FriendMessage:fixture-owner',supportProactive:true,status:'sent'};store.state.channels.push(channel);scope.channel='qq';assert.equal(call('schedule_reminder',args).error.code,'CHANNEL_NOT_CONNECTED');
  channel.status='verified';const result=call('schedule_reminder',args);assert.equal(result.ok,true);assert.equal(result.task.channel,'qq');assert.equal(result.task.status,'pending');
}));

test('private owner and assistant boundaries are enforced for both listing and cancellation',()=>fixture(({store,chat,scope,user,call})=>{
  user('明天7点提醒我起床');const made=call('schedule_reminder',{title:'起床',dueAt:tomorrow});assert.equal(call('list_reminders').total,1);
  user('取消刚才的提醒');const otherOwner={...scope,ownerId:'someone-else'};assert.equal(handleTaskTool(store,otherOwner,'list_reminders',{}, {now:noon}).total,0);assert.equal(handleTaskTool(store,otherOwner,'cancel_reminder',{taskId:made.task.id},{now:noon}).error.code,'NOT_FOUND');
  const game=store.createChat('game');store.message(game.id,'user','取消提醒',{status:'complete'});const otherAssistant={...scope,assistantId:'game',chatId:game.id};assert.equal(handleTaskTool(store,otherAssistant,'list_reminders',{}, {now:noon}).total,0);assert.equal(handleTaskTool(store,otherAssistant,'cancel_reminder',{taskId:made.task.id},{now:noon}).error.code,'NOT_FOUND');
  assert.equal(store.chat(chat.id).assistantId,'daily');assert.equal(call('cancel_reminder',{taskId:made.task.id}).task.status,'cancelled');assert.equal(call('cancel_reminder',{taskId:made.task.id}).alreadyCancelled,true);
}));

test('disabled scheduling, absent user authorization and in-flight or completed delivery return truthful failure',()=>fixture(({store,user,call})=>{
  user('明天7点提醒我起床');store.state.extensions.reminders=false;assert.equal(call('schedule_reminder',{title:'起床',dueAt:tomorrow}).error.code,'DISABLED');store.state.extensions.reminders=true;
  const made=call('schedule_reminder',{title:'起床',dueAt:tomorrow});user('你好');assert.equal(call('cancel_reminder',{taskId:made.task.id}).error.code,'NEEDS_AUTHORIZATION');user('取消这条提醒');store.state.tasks[0].status='sending';assert.equal(call('cancel_reminder',{taskId:made.task.id}).error.code,'IN_PROGRESS');store.state.tasks[0].status='done';assert.equal(call('cancel_reminder',{taskId:made.task.id}).error.code,'ALREADY_SENT');
}));

test('Beijing dates, afternoon times, midnight rollover and normal title words are evaluated without the host timezone',()=>{
  assert.equal(requestedReminderTime('明天下午三点半提醒我喝水',{now:noon,requestedAt:noon}).at,Date.parse('2026-11-03T15:30:00+08:00'));
  const late=Date.parse('2026-12-31T23:59:00+08:00');assert.equal(requestedReminderTime('明天早上七点叫我',{now:late,requestedAt:late}).at,Date.parse('2027-01-01T07:00:00+08:00'));
  assert.equal(requestedReminderTime('明天7点提醒我不要每天熬夜',{now:noon,requestedAt:noon}).ok,true);
  assert.equal(requestedReminderTime('七点叫我起床',{now:noon,requestedAt:noon}).error.code,'NEEDS_DATE');
});
