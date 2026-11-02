import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {startServer} from '../server/index.mjs';
import {legacyReminderReply} from '../server/reminder-presentation.mjs';
import {requestedReminderTime} from '../server/scheduled-tools.mjs';

test('real scheduled action gets a persona response; failed wording generation cannot undo or falsely fail the created task',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'miobot-reminder-experience-')),app=await startServer({dataRoot:directory,port:0});t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const post=async(path,body)=>{const r=await fetch(app.url+'/api'+path,{method:'POST',headers:{'X-Personal-Agent':'1','Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  app.store.state.modelConnections.push({id:'fixture',model:'fixture',type:'openai_chat_completion',config:{}});app.store.state.settings.defaultConnectionId='fixture';app.runtime.status='ready';
  let calls=0;app.runtime.chat=async(chat,prompt)=>{calls++;assert.match(prompt,/应用核实的任务结果/);assert.match(prompt,/"status":"pending"/);assert.match(prompt,/不要重复创建/);return '行，两分钟后叫你，别又坐着不动。';};
  const chat=app.store.createChat('game');const first=await post('/chats/'+chat.id+'/messages',{text:'两分钟后提醒我休息一下'});
  assert.equal(first.status,200);assert.equal(calls,1);assert.equal(first.body.text,'行，两分钟后叫你，别又坐着不动。');assert.equal(app.store.state.tasks[0].status,'pending');assert.ok(first.body.taskId);assert.ok(!first.body.text.includes('接收位置'));
  app.runtime.chat=async()=>{throw Error('fixture wording timeout');};const second=await post('/chats/'+chat.id+'/messages',{text:'三分钟后提醒我喝水'});
  assert.equal(second.status,200);assert.equal(second.body.status,'complete');assert.ok(second.body.taskId);assert.equal(app.store.state.tasks.length,2);assert.equal(app.store.state.tasks[0].status,'pending');assert.match(second.body.text,/到点叫你/);
});

test('old exact generated receipts are projected without changing user text or other model replies',()=>{
  const generated={role:'assistant',source:'local',taskId:'fixture',text:'已安排：2026/11/2 23:14:08 提醒你「休息一下」。接收位置：本应用。本机模式需要保持应用运行。'};
  assert.equal(legacyReminderReply(generated),'好，记下了，到点叫你。');assert.equal(legacyReminderReply({...generated,role:'user'}),generated.text);assert.equal(legacyReminderReply({...generated,source:'astrbot'}),generated.text);
});

test('the game assistant naturally asks for missing time and passes a real clarification to the connected model',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'miobot-game-reminder-')),app=await startServer({dataRoot:directory,port:0});t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const chat=app.store.createChat('game'),post=async text=>{const r=await fetch(app.url+'/api/chats/'+chat.id+'/messages',{method:'POST',headers:{'X-Personal-Agent':'1','Content-Type':'application/json'},body:JSON.stringify({text})});assert.equal(r.status,200);return r.json();};
  const question=await post('所以你能明天早上叫我吗');assert.equal(question.text,'明早几点叫你？');assert.equal(app.store.state.tasks.length,0);
  app.store.state.modelConnections.push({id:'fixture',model:'fixture',type:'openai_chat_completion',config:{}});app.store.state.settings.defaultConnectionId='fixture';app.runtime.status='ready';
  app.runtime.username='fixture';chat.nativeSession='fixture';
  app.runtime.chat=async(_,prompt)=>{
    assert.match(prompt,/真实前文/);assert.match(prompt,/所以你能明天早上叫我吗 7点/);
    const parsed=requestedReminderTime('所以你能明天早上叫我吗 7点',{requestedAt:Date.parse(chat.messages[0].createdAt)});
    const r=await fetch(app.url+'/internal/assistant-tools',{method:'POST',headers:{'Content-Type':'application/json','X-MioBot-Tool-Token':app.runtime.toolBridge.token},body:JSON.stringify({platform:'webchat',senderId:'fixture',sessionId:'fixture',name:'schedule_reminder',args:{title:'起床',dueAt:new Date(parsed.at).toISOString()}})});
    assert.equal((await r.json()).ok,true);return '收到，明早七点叫你。';
  };
  const answer=await post('7点');assert.equal(answer.text,'收到，明早七点叫你。');
  assert.equal(app.store.state.tasks.length,1);assert.equal(app.store.state.tasks[0].status,'pending');assert.ok(answer.taskId);
  assert.ok(app.store.assistant('game').skills.includes('humanize'));assert.ok(app.store.assistant('game').skills.includes('reminders'));
});
