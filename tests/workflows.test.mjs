import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Workflows,normalizeWorkflowSchedule,nextWorkflowRun,requestedWorkflowSchedule} from '../server/workflows.mjs';
import {RssSources} from '../server/rss-sources.mjs';

const START=Date.parse('2026-11-05T12:00:00+08:00');
const daily={type:'daily',time:'08:00',timezone:'Asia/Shanghai'};
function fixture(t,options={}){
  const root=mkdtempSync(join(tmpdir(),'miobot-workflows-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const store=new Store(root),syncCalls=[],executions=[],deliveries=[],notices=[];let now=START;
  const runtime={status:'ready',token:'synthetic-runtime-token',safeError:e=>e.message,syncWorkflows:async args=>{syncCalls.push(structuredClone(args));return {ready:true,jobs:args.jobs.map(j=>({id:j.id,nextRunAt:nextWorkflowRun(j.schedule,now)}))};},...options.runtime};
  const rss=new RssSources({store,now:()=>now,lookup:async()=>[{address:'1.1.1.1',family:4}],fetcher:async()=>new Response('<rss/>'),parser:async()=>({items:[{id:'fixture-item',title:'Fixture article',url:'https://news.example.org/article',summary:'Fixture public source'}]})});
  const workflows=new Workflows({store,runtime,rss,now:()=>now,execute:async input=>{executions.push(input);return {text:'Fixture generated result',sources:[]}},deliver:async(...args)=>{deliveries.push(args)},onNotify:n=>notices.push(n),...options,runtime:runtime});
  t.after(()=>workflows.close());
  const create=extra=>workflows.create({requestId:'create-fixture',assistantId:'daily',title:'Morning research',instruction:'搜索并整理公开资料',kind:'agent',schedule:daily,channel:'web',confirmed:true,...extra});
  const external=()=>store.state.channels.push({id:'fixture-qq',type:'aiocqhttp',assistantId:'daily',enabled:true,status:'verified',supportProactive:true,target:'qq:FriendMessage:synthetic-recipient'});
  return {root,store,runtime,rss,workflows,create,external,syncCalls,executions,deliveries,notices,setNow:at=>{now=at},advance:ms=>{now+=ms}};
}

test('schedule parsing uses Beijing time, handles Sunday and validates actual calendar dates',()=>{
  assert.deepEqual(requestedWorkflowSchedule('每天早上8点搜AI新闻',{now:START}),daily);
  assert.deepEqual(requestedWorkflowSchedule('工作日晚上八点半整理日报',{now:START}),{type:'weekly',time:'20:30',weekdays:[1,2,3,4,5],timezone:'Asia/Shanghai'});
  assert.equal(requestedWorkflowSchedule('假如每天8点给我发新闻',{now:START}),null);
  assert.equal(requestedWorkflowSchedule('每周一、三早上8点整理新闻',{now:START}),null);
  assert.equal(nextWorkflowRun({type:'weekly',time:'08:00',weekdays:[7],timezone:'Asia/Shanghai'},START),'2026-11-08T00:00:00.000Z');
  assert.equal(nextWorkflowRun(daily,Date.parse('2026-12-31T23:59:00+08:00')),'2027-01-01T00:00:00.000Z');
  for(const runAt of ['2026-11-31T08:00:00+08:00','2027-02-30T08:00:00+08:00','2026-11-06T08:00:00'])assert.throws(()=>normalizeWorkflowSchedule({type:'once',runAt},{now:START}),undefined,runAt);
});

test('confirmed creates are durable and idempotent without running a model before the scheduled task',async t=>{
  const f=fixture(t),made=await f.create(),again=await f.create();assert.equal(made.id,again.id);assert.equal(again.duplicate,true);assert.equal(f.store.state.workflows.length,1);assert.equal(f.executions.length,0);assert.equal(f.notices.length,0);assert.equal(f.syncCalls.length,1);
  const disk=JSON.parse(readFileSync(f.store.file));assert.equal(disk.workflows[0].id,made.id);assert.equal(disk.workflows[0].bindingStatus,'ready');
  await assert.rejects(f.create({instruction:'Different request'}),/请求编号/);
  await assert.rejects(f.create({requestId:'unconfirmed',confirmed:false}),/确认/);
  await assert.rejects(f.create({requestId:'cross-source',kind:'rss',sourceIds:['not-owned']}),/订阅源/);
  await assert.rejects(f.create({requestId:'target-injection',target:'arbitrary'}),/不支持/);
  assert.equal(f.workflows.list({assistantId:'game'}).items.length,0);assert.throws(()=>f.workflows.owned(made.id,'game'),/找不到/);
});

test('missing native scheduler is reported truthfully while a confirmed plan remains saved',async t=>{
  const f=fixture(t,{runtime:{status:'stopped'}}),made=await f.create();assert.equal(made.bindingStatus,'needs_runtime');assert.equal(f.workflows.list({assistantId:'daily'}).scheduler.status,'needs_runtime');assert.equal(f.syncCalls.length,0);assert.equal(f.executions.length,0);
});

test('the same native occurrence queues once, and stale revisions or wrong wall-clock times are rejected',async t=>{
  const f=fixture(t),w=await f.create();f.setNow(Date.parse('2026-11-06T08:00:10+08:00'));
  const input={workflowId:w.id,revision:1,scheduledAt:'2026-11-06T00:00:00.000Z'},a=f.workflows.trigger(input),b=f.workflows.trigger(input);
  assert.equal(a.run.id,b.run.id);assert.equal(b.duplicate,true);assert.equal(f.store.state.workflowRuns.length,1);
  assert.throws(()=>f.workflows.trigger({...input,revision:0}),/过期/);assert.throws(()=>f.workflows.trigger({...input,scheduledAt:'2026-11-06T00:00:01.000Z'}),/时刻|周期|触发/);
  await f.workflows.run(a.run.id);assert.equal(f.executions.length,1);assert.equal(f.notices.length,1);assert.equal(f.store.state.workflowRuns[0].status,'completed');
  await f.workflows.run(a.run.id);assert.equal(f.executions.length,1);assert.equal(f.notices.length,1);
});

test('manual execution queues without running immediately and persists one output receipt',async t=>{
  const f=fixture(t),w=await f.create(),a=f.workflows.manual(w.id,{assistantId:'daily',requestId:'manual-1'}),b=f.workflows.manual(w.id,{assistantId:'daily',requestId:'manual-1'});
  assert.equal(a.run.id,b.run.id);assert.equal(b.duplicate,true);assert.equal(f.executions.length,0);assert.throws(()=>f.workflows.manual(w.id,{requestId:'manual-2'}),/排队/);
  await f.workflows.run(a.run.id);const result=f.store.state.workflowRuns[0];assert.equal(result.status,'completed');assert.equal(result.deliveryStatus,'inbox');assert.equal(result.result,'Fixture generated result');assert.equal(f.store.state.notifications[0].runId,result.id);assert.equal(f.deliveries.length,0);assert.equal(f.store.state.workflows[0].status,'active');
  assert.equal(JSON.parse(readFileSync(f.store.file)).workflowRuns[0].result,'Fixture generated result');
});

test('a model failure retries once and does not create a successful result or notification prematurely',async t=>{
  let tries=0;const f=fixture(t,{execute:async()=>{if(++tries===1)throw Error('synthetic model temporarily unavailable');return {text:'Recovered result'}}}),w=await f.create(),queued=f.workflows.manual(w.id,{requestId:'retry'});
  await f.workflows.run(queued.run.id);let run=f.store.state.workflowRuns[0];assert.equal(run.status,'queued');assert.equal(run.attempt,1);assert.equal(run.result,undefined);assert.equal(f.notices.length,0);assert.equal(Date.parse(run.retryAt),START+30000);
  f.advance(30000);await f.workflows.run(run.id);run=f.store.state.workflowRuns[0];assert.equal(run.status,'completed');assert.equal(run.attempt,2);assert.equal(tries,2);assert.equal(f.notices.length,1);assert.equal(run.result,'Recovered result');
});

test('two model failures stop with a failed receipt and no output delivery',async t=>{
  let tries=0;const f=fixture(t,{execute:async()=>{tries++;throw Error('synthetic persistent model failure')}}),w=await f.create(),q=f.workflows.manual(w.id,{requestId:'two-failures'});
  await f.workflows.run(q.run.id);f.advance(30000);await f.workflows.run(q.run.id);assert.equal(f.store.state.workflowRuns[0].status,'failed');assert.equal(tries,2);assert.equal(f.store.state.notifications.length,0);assert.equal(f.deliveries.length,0);
});

test('cancellation aborts active generation and prevents a late result from being delivered',async t=>{
  let release,entered;const started=new Promise(r=>{entered=r}),wait=new Promise(r=>{release=r});let seenSignal;
  const f=fixture(t,{execute:async({signal})=>{seenSignal=signal;entered();await wait;return {text:'Late result must not be sent'}}}),w=await f.create(),q=f.workflows.manual(w.id,{requestId:'cancel-active'}),running=f.workflows.run(q.run.id);
  await started;await f.workflows.change(w.id,{action:'cancel',assistantId:'daily'});assert.equal(seenSignal.aborted,true);release();await running;assert.equal(f.store.state.workflowRuns[0].status,'interrupted');assert.equal(f.store.state.notifications.length,0);assert.equal(f.deliveries.length,0);
});

test('pausing invalidates queued work and previously registered native revisions',async t=>{
  const f=fixture(t),w=await f.create(),q=f.workflows.manual(w.id,{requestId:'pause-queued'});await f.workflows.change(w.id,{action:'pause',assistantId:'daily'});
  assert.equal(f.store.state.workflowRuns[0].status,'interrupted');await f.workflows.run(q.run.id);assert.equal(f.executions.length,0);
  f.setNow(Date.parse('2026-11-06T08:00:00+08:00'));assert.throws(()=>f.workflows.trigger({workflowId:w.id,revision:1,scheduledAt:new Date(Date.parse('2026-11-06T08:00:00+08:00')).toISOString()}),/过期|停用/);
  const resumed=await f.workflows.change(w.id,{action:'resume',assistantId:'daily'});assert.equal(resumed.revision,3);assert.equal(resumed.status,'active');
});

test('an unverified external channel cannot be selected and uncertain sending is never retried automatically',async t=>{
  let sent=0;const f=fixture(t,{deliver:async()=>{sent++;throw Error('synthetic connection lost after accepting bytes')}});await assert.rejects(f.create({channel:'fixture-qq'}),/验证/);f.external();
  const w=await f.create({channel:'fixture-qq'}),q=f.workflows.manual(w.id,{requestId:'external-send'});await f.workflows.run(q.run.id);assert.equal(sent,1);assert.equal(f.store.state.workflowRuns[0].status,'delivery_unknown');
  await f.workflows.run(q.run.id);assert.equal(sent,1);assert.throws(()=>f.workflows.manual(w.id,{requestId:'do-not-resend'}),/不明/);assert.equal(f.store.state.notifications.length,0);
});

test('an accepted external send is not duplicated if persisting the final receipt fails once',async t=>{
  const f=fixture(t);f.external();const w=await f.create({channel:'fixture-qq'}),q=f.workflows.manual(w.id,{requestId:'external-save-failure'}),save=f.store.save.bind(f.store);let failed=false;
  f.store.save=()=>{if(!failed&&f.store.state.workflowRuns.some(r=>r.id===q.run.id&&r.deliveryStatus==='accepted')){failed=true;throw Error('synthetic final receipt disk failure')}return save()};
  await f.workflows.run(q.run.id);assert.equal(failed,true);assert.equal(f.deliveries.length,1);const run=f.store.state.workflowRuns[0];assert.ok(['completed','delivery_unknown'].includes(run.status),'accepted sends cannot be queued for automatic retry');await f.workflows.run(run.id);assert.equal(f.deliveries.length,1);
});

test('RSS inbox output and delivery ledger are committed together, with complete in-memory rollback and retry',async t=>{
  const f=fixture(t),s=await f.rss.create({assistantId:'daily',url:'https://feeds.example.org/rss',name:'Fixture RSS'}),w=await f.create({kind:'rss',sourceIds:[s.id]}),q=f.workflows.manual(w.id,{requestId:'rss-atomic'}),save=f.store.save.bind(f.store);let failed=false;
  f.store.save=()=>{if(!failed&&f.store.state.notifications.some(n=>n.runId===q.run.id)&&f.store.state.rssDeliveryLedger?.length){failed=true;throw Error('synthetic atomic inbox save failure')}return save()};
  await f.workflows.run(q.run.id);assert.equal(failed,true);assert.equal(f.store.state.notifications.length,0);assert.equal(f.store.state.rssDeliveryLedger?.length||0,0);assert.equal(f.store.state.workflowRuns[0].status,'queued');assert.equal(f.notices.length,0);assert.equal(f.executions.length,1);
  f.advance(30000);await f.workflows.run(q.run.id);assert.equal(f.store.state.workflowRuns[0].status,'completed');assert.equal(f.store.state.notifications.length,1);assert.equal(f.store.state.rssDeliveryLedger.length,1);assert.equal(f.executions.length,1,'retry reuses the already generated result');assert.equal(f.notices.length,1);
  const disk=JSON.parse(readFileSync(f.store.file));assert.equal(disk.notifications[0].runId,q.run.id);assert.equal(disk.rssDeliveryLedger[0].runId,q.run.id);assert.equal(disk.workflowRuns[0].status,'completed');
});

test('an accepted external RSS delivery keeps dedup when its first final persistence fails',async t=>{
  const f=fixture(t);f.external();const s=await f.rss.create({assistantId:'daily',url:'https://feeds.example.org/rss',name:'External source'}),w=await f.create({kind:'rss',sourceIds:[s.id],channel:'fixture-qq'}),q=f.workflows.manual(w.id,{requestId:'external-rss-commit'}),save=f.store.save.bind(f.store);let failed=false;
  f.store.save=()=>{if(!failed&&f.store.state.workflowRuns.some(r=>r.id===q.run.id&&r.deliveryStatus==='accepted')&&f.store.state.rssDeliveryLedger?.length){failed=true;throw Error('synthetic accepted RSS final save failure')}return save()};
  await f.workflows.run(q.run.id);assert.equal(failed,true);assert.equal(f.deliveries.length,1);assert.equal(f.store.state.rssDeliveryLedger?.length||0,1,'known accepted RSS items must survive the error receipt save');
  const next=await f.rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],runId:'after-external-accepted'});assert.equal(next.items.length,0);await f.workflows.run(q.run.id);assert.equal(f.deliveries.length,1);assert.equal(JSON.parse(readFileSync(f.store.file)).rssDeliveryLedger.length,1);
});

test('RSS source failure cannot be recorded as an empty successful summary or sent message',async t=>{
  const f=fixture(t),s=await f.rss.create({assistantId:'daily',url:'https://feeds.example.org/rss',name:'Unavailable'});f.rss.fetcher=async()=>new Response('Unavailable',{status:503});const w=await f.create({kind:'rss',sourceIds:[s.id]}),q=f.workflows.manual(w.id,{requestId:'rss-fail'});
  await f.workflows.run(q.run.id);f.advance(30000);await f.workflows.run(q.run.id);assert.equal(f.store.state.workflowRuns[0].status,'failed');assert.match(f.store.state.workflowRuns[0].error,/全部读取失败/);assert.equal(f.executions.length,0);assert.equal(f.notices.length,0);assert.equal(f.store.state.rssDeliveryLedger?.length||0,0);
});

test('RSS retry keeps assistant queue order so a later run cannot deliver before an earlier snapshot retry',async t=>{
  let calls=0;const f=fixture(t,{execute:async()=>{if(++calls===1)throw Error('synthetic first RSS summary failure');return {text:'Recovered RSS summary'}}}),s=await f.rss.create({assistantId:'daily',url:'https://feeds.example.org/rss',name:'Shared source'});
  const a=await f.create({requestId:'rss-plan-a',title:'Earlier digest',kind:'rss',sourceIds:[s.id]}),b=await f.create({requestId:'rss-plan-b',title:'Later digest',kind:'rss',sourceIds:[s.id]});
  const qa=f.workflows.manual(a.id,{requestId:'rss-run-a'}),qb=f.workflows.manual(b.id,{requestId:'rss-run-b'}),get=id=>f.store.state.workflowRuns.find(r=>r.id===id);
  const settle=async predicate=>{for(let n=0;n<40&&!predicate();n++)await new Promise(setImmediate);assert.ok(predicate(),'offline execution should settle');};
  await f.workflows.tick();await settle(()=>get(qa.run.id).attempt===1&&get(qa.run.id).status==='queued');
  assert.equal(Date.parse(get(qa.run.id).retryAt),START+30000);await f.workflows.tick();await new Promise(setImmediate);assert.equal(get(qb.run.id).attempt,0);assert.equal(calls,1);
  f.advance(30000);await f.workflows.tick();await settle(()=>get(qa.run.id).status==='completed');assert.equal(f.store.state.rssDeliveryLedger.length,1);
  await f.workflows.tick();await settle(()=>get(qb.run.id).status==='completed');assert.equal(get(qb.run.id).noNewItems,true);assert.equal(calls,2,'later RSS run must observe the successful earlier acknowledgement');assert.equal(f.store.state.rssDeliveryLedger.length,1);
});

test('a restart marks in-flight generation interrupted and in-flight sends unknown instead of replaying them',async t=>{
  const f=fixture(t);const w=await f.create();f.store.state.workflowRuns.push({id:'generating',workflowId:w.id,ownerId:'local-user',status:'running',deliveryStatus:'not_started'},{id:'sending',workflowId:w.id,ownerId:'local-user',status:'running',deliveryStatus:'sending'});f.store.save();
  const restarted=new Store(f.root),next=new Workflows({store:restarted,runtime:f.runtime,rss:new RssSources({store:restarted}),execute:async()=>assert.fail('must not generate'),deliver:async()=>assert.fail('must not resend'),now:()=>START});t.after(()=>next.close());
  assert.equal(restarted.state.workflowRuns[0].status,'interrupted');assert.equal(restarted.state.workflowRuns[1].status,'delivery_unknown');await next.run('sending');assert.throws(()=>next.manual(w.id,{requestId:'after-restart'}),/不明/);
});

test('a failed queue persistence does not leave a memory-only pending run to execute later',async t=>{
  const f=fixture(t),w=await f.create(),save=f.store.save.bind(f.store);f.store.save=()=>{throw Error('synthetic queue persistence failure')};assert.throws(()=>f.workflows.manual(w.id,{requestId:'disk-full-queue'}),/persistence/);assert.equal(f.store.state.workflowRuns.length,0);f.store.save=save;
});

test('a missed one-shot becomes visible as missed and never queues an automatic replay',async t=>{
  const f=fixture(t),w=await f.create({schedule:{type:'once',runAt:new Date(START+60000).toISOString(),timezone:'Asia/Shanghai'}});
  f.advance(7*60000);await f.workflows.sync({force:true});const saved=f.workflows.owned(w.id);assert.equal(saved.status,'missed');assert.match(saved.lastError,/错过/);assert.equal(f.store.state.workflowRuns.length,0);await f.workflows.sync({force:true});assert.deepEqual(f.syncCalls.at(-1).jobs,[]);
  const manual=f.workflows.manual(w.id,{requestId:'reviewed-missed-once'});await f.workflows.run(manual.run.id);assert.equal(f.deliveries.length,0);assert.equal(f.workflows.list({assistantId:'daily'}).runs[0].status,'completed');
});

test('a notification receipt save failure cannot requeue an already committed inbox result',async t=>{
  const f=fixture(t,{onNotify:()=>{throw Error('synthetic push failure');}}),w=await f.create();const {run}=f.workflows.manual(w.id,{requestId:'push-receipt-failure'}),save=f.store.save.bind(f.store);let thrown=false;
  f.store.save=()=>{const row=f.store.state.workflowRuns.find(r=>r.id===run.id);if(row?.pushError&&!thrown){thrown=true;throw Error('synthetic receipt disk failure');}return save();};
  await f.workflows.run(run.id);const row=f.store.state.workflowRuns.find(r=>r.id===run.id);assert.equal(thrown,true);assert.equal(row.status,'completed');assert.equal(row.deliveryStatus,'inbox');assert.equal(f.store.state.notifications.length,1);assert.equal(f.executions.length,1);
});
