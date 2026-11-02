import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,Scheduler,reminderDraft} from '../server/store.mjs';
import {startServer,projectRoot} from '../server/index.mjs';

test('explicit reminder stays a draft; ambiguous ordinary requests stay with the agent',()=>{
 const now=Date.parse('2026-11-02T10:00:00+08:00');
 assert.equal(reminderDraft('两分钟后提醒我喝水',now).dueAt,new Date(now+120000).toISOString());
 assert.equal(reminderDraft('今晚八点提醒我领取奖励',now).dueAt,'2026-11-02T12:00:00.000Z');
 assert.equal(reminderDraft('帮我安排游戏时间',now),null);
 assert.equal(reminderDraft('下周三八点提醒我喝水',now),null);
 assert.equal(reminderDraft('明天下午八点提醒我喝水',now),null);
 assert.equal(reminderDraft('1秒后提醒我休息',now).status,'draft');
 assert.match(reminderDraft('今天九点提醒我喝水',now).error,/已经过去/);
});

test('only confirmed reminders deliver, each at most once; cancellation and pause survive reload',()=>{
 const root=mkdtempSync(join(tmpdir(),'pa-scheduler-'));try{
 const s=new Store(root),base={assistantId:'daily',title:'test',channel:'web',dueAt:new Date(1000).toISOString(),logs:[]};
 s.state.tasks=['draft','pending','cancelled','paused'].map((status,i)=>({...base,id:String(i),logs:[],status}));s.save();
 const reloaded=new Store(root);let delivered=0;const scheduler=new Scheduler(reloaded,{now:()=>2000,onNotify:()=>delivered++});scheduler.tick();scheduler.tick();
 assert.equal(delivered,1);assert.equal(reloaded.state.notifications.length,1);assert.equal(reloaded.state.tasks.find(x=>x.id==='1').status,'done');assert.equal(reloaded.state.tasks.find(x=>x.id==='0').status,'draft');
 assert.equal(new Store(root).state.notifications.length,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('overdue restart does not silently send old reminders',()=>{
 const root=mkdtempSync(join(tmpdir(),'pa-recover-'));try{const s=new Store(root);s.state.tasks=[{id:'old',status:'pending',dueAt:new Date(0).toISOString(),logs:[]}];const scheduler=new Scheduler(s,{now:()=>100000});scheduler.recover();scheduler.tick();assert.equal(s.state.tasks[0].status,'overdue');assert.equal(s.state.notifications.length,0);}finally{rmSync(root,{recursive:true,force:true});}
});

test('HTTP state hides credentials and rejects cross-site writes; memory edits preserve native sessions',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pa-http-'));const app=await startServer({root:projectRoot,dataRoot:root,port:0});
 const request=async(path,method='GET',body,headers={})=>{const r=await fetch(app.url+'/api'+path,{method,headers:{'X-Personal-Agent':'1','Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 try{
 assert.equal((await fetch(app.url+'/api/state')).status,403);
 assert.equal((await request('/settings','PATCH',{model:'evil'},{Origin:'https://example.com'})).status,403);
 await request('/settings','PATCH',{modelKey:'private-test-placeholder'});
 const snapshot=(await request('/state')).body;assert.equal(snapshot.settings.hasModelKey,true);assert.ok(!JSON.stringify(snapshot).includes('private-test-placeholder'));
 const c=await request('/chats','POST',{assistantId:'daily'});app.store.chat(c.body.id).nativeSession='prior';
 const m=await request('/memories','POST',{assistantId:'daily',content:'I like brief answers'});assert.equal(m.status,201);assert.equal(app.store.chat(c.body.id).nativeSession,'prior');
 assert.equal((await request('/tasks','POST',{assistantId:'daily',title:'no QQ yet',dueAt:new Date(Date.now()+60000).toISOString(),channel:'qq'})).status,400);
 assert.equal((await request('/tasks','POST',{assistantId:'daily',title:'past',dueAt:new Date(0).toISOString()})).status,400);
 const task=(await request('/tasks','POST',{assistantId:'daily',title:'future',dueAt:new Date(Date.now()+60000).toISOString()})).body;
 await request('/tasks/'+task.id,'PATCH',{action:'confirm'});await request('/tasks/'+task.id,'PATCH',{action:'confirm'});
 assert.equal(app.store.state.tasks[0].logs.length,1);
 await request('/tasks/'+task.id,'PATCH',{action:'cancel'});assert.equal(app.store.state.tasks[0].status,'cancelled');
 const paused=(await request('/tasks','POST',{assistantId:'daily',title:'disable test',dueAt:new Date(Date.now()+60000).toISOString()})).body;
 await request('/tasks/'+paused.id,'PATCH',{action:'confirm'});
 assert.equal((await request('/extensions/reminders','PATCH',{enabled:false})).status,409);
 assert.equal(app.store.state.tasks.find(t=>t.id===paused.id).status,'pending');
 await request('/tasks/'+paused.id,'PATCH',{action:'pause'});assert.equal(app.store.state.tasks.find(t=>t.id===paused.id).status,'paused');
 await request('/extensions/reminders','PATCH',{enabled:true});assert.equal(app.store.state.tasks.find(t=>t.id===paused.id).status,'paused');
 }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
