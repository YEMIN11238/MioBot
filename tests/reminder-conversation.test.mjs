import test from 'node:test';
import assert from 'node:assert/strict';
import {recognizeReminderConversation} from '../server/reminder-conversation.mjs';
import {requestedReminderTime} from '../server/scheduled-tools.mjs';

const NOW=Date.parse('2026-11-02T12:00:00+08:00');
const message=(role,text,id,extra={})=>({role,text,id,createdAt:new Date(NOW).toISOString(),status:'complete',...extra});
function run(text,history=[],extra={}){const user=message('user',text,'current'),chat={messages:[...history,user]};return recognizeReminderConversation(chat,user,{now:NOW,...extra});}
const request=message('user','明天早上叫我','original'),clarifier=message('assistant','明早几点叫你？','clarifier');

test('direct and conversational requests with no clock time ask a short natural clarification',()=>{
  for(const text of ['明天早上叫我','所以你能明天早上叫我吗','那你明天早上叫醒我吧','能不能明早喊我起床']){
    const result=run(text);assert.equal(result?.type,'NEEDS_TIME',text);assert.equal(result.text,'明早几点叫你？');assert.equal(result.request.text,text);
  }
  assert.equal(run('明天提醒我喝水').text,'明天几点提醒你？');
  assert.equal(run('提醒我喝水').text,'想让我哪天、几点提醒你？');
});

test('explicit full times and ordinary chat remain with the existing model or task tools',()=>{
  for(const text of ['明天早上7点叫我起床','明天07:30提醒我喝水','3秒后提醒我测试云端','明天早上七点喊我','2026-11-03T07:00:00+08:00提醒我喝水','7点','我明天早上要早起','我妈妈明天早上叫我','你说的明天早上叫我是什么意思','Minecraft红石定时器怎么做'])assert.equal(run(text),null,text);
});

test('cancellation and recurrence are not mistaken for new one-time reminders or capability permission',()=>{
  for(const text of ['明天早上不要叫我','不用明天早上叫我了','取消明天的提醒','每天早上叫我','每周一早上提醒我开会','你能每天早上叫我吗','提醒我每天喝水','工作日7点叫我'])assert.equal(run(text),null,text);
});

test('capability questions produce no unconditional success or enabled-state claim',()=>{
  for(const text of ['你有闹钟吗','游戏怎么定时','你能提醒我吗','你支持定时提醒吗','定时提醒怎么用'])assert.deepEqual(run(text),{type:'CAPABILITY'},text);
});

test('a pure clock answer is combined only with a real immediately preceding reminder clarification',()=>{
  for(const text of ['7点','早上七点','7点半','上午07:30']){
    const result=run(text,[request,clarifier]);assert.equal(result?.type,'READY',text);
    assert.equal(result.request.text,request.text+' '+text);assert.equal(result.request.referenceAt,request.createdAt);
    assert.deepEqual(result.request.sourceMessageIds,['original','current']);
  }
  assert.equal(run('7点',[message('user','我明天打算玩游戏','unrelated'),message('assistant','你准备几点开始？','question')]),null);
  assert.equal(run('7点',[request,clarifier,message('user','先说别的吧','topic-change')]),null);
  assert.equal(run('7点',[request,message('assistant','你一般几点打游戏？','topic-change')]),null);
  assert.equal(run('7点',[request,clarifier,message('assistant','回复失败，请重试','error-barrier',{status:'error'})]),null);
  assert.equal(run('7点，我的经验等级是23',[request,clarifier]),null);
  assert.equal(run('24点',[request,clarifier]),null);
});

test('combined history keeps the original calendar date across midnight without rewriting any message',()=>{
  const original=message('user','明天早上叫我起来','original',{createdAt:'2026-11-02T23:59:00+08:00'}),user=message('user','7点','current',{createdAt:'2026-11-03T00:01:00+08:00'}),chat={messages:[original,clarifier,user]},before=JSON.stringify(chat);
  const result=recognizeReminderConversation(chat,user,{now:Date.parse(user.createdAt)});
  assert.equal(result.type,'READY');
  const parsed=requestedReminderTime(result.request.text,{now:Date.parse(user.createdAt),requestedAt:Date.parse(result.request.referenceAt)});
  assert.equal(parsed.at,Date.parse('2026-11-03T07:00:00+08:00'));assert.equal(JSON.stringify(chat),before);
});

test('question marks following a real reminder clarification repeat the missing time naturally',()=>{
  for(const text of ['?','？','？？'])assert.equal(run(text,[request,clarifier])?.text,'明早几点叫你？');
  assert.equal(run('?',[]),null);
  assert.equal(run('?', [message('user','你好','hi'),message('assistant','你好呀','reply')]),null);
  assert.equal(run('?', [request,message('assistant','明早几点叫你？','failed',{status:'error'})]),null);
});

test('question marks can reference a genuine tool receipt but never trust a model claim or old draft as task state',()=>{
  const receipt=message('assistant','已经安排好了','receipt',{taskId:'real-task',toolCalls:[{name:'schedule_reminder',ok:true}],source:'local'});
  const result=run('？',[request,receipt]);assert.equal(result.type,'TASK_REFERENCE');assert.equal(result.taskId,'real-task');
  assert.equal(run('？',[request,message('assistant','我已经安排好了','model-only')]),null);
  assert.equal(run('？',[request,message('assistant','草稿待确认','draft',{taskId:'draft-task',source:'local'})]),null);
  assert.equal(run('？',[request,message('assistant','工具失败','failed',{taskId:'failed-task',toolCalls:[{name:'schedule_reminder',ok:false}]})]),null);
});

test('stale or synthetic user arguments, invalid historical timestamps and streaming placeholders never create a fake request',()=>{
  const user=message('user','7点','current'),chat={messages:[request,clarifier,user,message('assistant','','placeholder',{status:'streaming'})]};
  assert.equal(recognizeReminderConversation(chat,user,{now:NOW}).type,'READY','current assistant placeholder is not an earlier clarification');
  assert.equal(recognizeReminderConversation(chat,{...user,text:'8点'},{now:NOW}),null);
  assert.equal(recognizeReminderConversation(chat,{...user,id:'not-stored'},{now:NOW}),null);
  assert.equal(recognizeReminderConversation({messages:[request,clarifier,user,message('user','别的消息','later')]},user,{now:NOW}),null);
  assert.equal(run('7点',[{...request,createdAt:'invalid'},clarifier]),null);
});
