import test from 'node:test';
import assert from 'node:assert/strict';
import {beijingInput,reminderISO,groupMobileTasks,pendingSubmissionState,clearAcknowledgedDraft,submissionBelongsToBackend} from '../src/mobile-state.mjs';

test('mobile reminder editing stays in Beijing time across midnight instead of using the device timezone',()=>{
  assert.equal(beijingInput('2026-11-04T23:30:00Z'),'2026-11-05T07:30');
  assert.equal(reminderISO('2026-11-05T07:30'),'2026-11-04T23:30:00.000Z');
  assert.throws(()=>reminderISO('2026-02-30T07:30'),/有效/);
  assert.throws(()=>reminderISO('2026-11-05 07:30'),/有效/);
});

test('mobile schedule shows only the current assistant, separates finished items and groups dates by Beijing day',()=>{
  const task=(id,assistantId,dueAt,status='pending')=>({id,assistantId,dueAt,status});
  const tasks=[task('today','daily','2026-11-05T00:00:00Z'),task('tomorrow','daily','2026-11-06T00:00:00Z'),task('other','game','2026-11-05T00:00:00Z'),task('old','daily','2026-11-04T00:00:00Z','overdue'),task('done','daily','2026-11-04T01:00:00Z','done')];
  const groups=groupMobileTasks(tasks,'daily',{now:Date.parse('2026-11-04T23:30:00Z')});
  assert.deepEqual(groups.map(g=>[g.label,g.items.map(t=>t.id)]),[['需要处理',['old']],['今天',['today']],['明天',['tomorrow']]]);
  assert.equal(groupMobileTasks(tasks,'daily',{now:Date.parse('2026-11-04T23:30:00Z'),includeFinished:true}).find(g=>g.label==='已结束').items[0].id,'done');
});

test('uncertain submissions are acknowledged only by their request in the same backend and conversation',()=>{
  const pending={instanceId:'one',chatId:'chat',requestId:'request'};
  const data={instanceId:'one',chats:[{id:'chat',messages:[{id:'u',role:'user',requestId:'request'},{id:'a',role:'assistant',replyTo:'u',status:'streaming'}]}]};
  assert.deepEqual(pendingSubmissionState(data,pending),{status:'accepted',userId:'u',replyId:'a',finished:false});
  data.chats[0].messages[1].status='complete';assert.equal(pendingSubmissionState(data,pending).finished,true);
  assert.equal(pendingSubmissionState({...data,instanceId:'two'},pending).status,'other-instance');
  assert.equal(pendingSubmissionState(data,{...pending,chatId:'other'}).status,'unknown');
  assert.equal(pendingSubmissionState(data,{...pending,requestId:'other'}).status,'unknown');
});

test('late acknowledgement clears only the submitted draft and preserves edits or a different assistant draft',()=>{
  const pending={instanceId:'one',assistantId:'daily',text:'你好',draftText:' 你好 '},drafts={'one:daily':' 你好 ','one:game':'新的游戏问题','two:daily':'另一台后台的内容'};
  assert.deepEqual(clearAcknowledgedDraft(drafts,pending),{...drafts,'one:daily':''});
  const edited={...drafts,'one:daily':'我又想到一个问题'};assert.equal(clearAcknowledgedDraft(edited,pending),edited);
  assert.equal(clearAcknowledgedDraft(drafts,{...pending,instanceId:'two'}),drafts);
});

test('uncertain message retries cannot travel to another backend after a connection switch',()=>{
  assert.equal(submissionBelongsToBackend({instanceId:'one'},'one'),true);
  assert.equal(submissionBelongsToBackend({instanceId:'one'},'two'),false);
  assert.equal(submissionBelongsToBackend({instanceId:''},''),false);
  assert.equal(submissionBelongsToBackend(null,'one'),false);
});
