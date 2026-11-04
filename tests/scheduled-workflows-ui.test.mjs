import test from 'node:test';
import assert from 'node:assert/strict';
import {freshWorkflowDraft,workflowPayload,workflowView,workflowChannels,workflowDate,workflowSchedule,canRunWorkflow,workflowRuns,publicSourceLink,rssSourcePayload} from '../src/scheduled-workflows-state.mjs';

const now=Date.parse('2026-11-05T00:00:00Z'),scope={assistantId:'daily',requestId:'synthetic-ui-request',now};
const draft=()=>({...freshWorkflowDraft(now),title:'晨间简报',instruction:'整理三条资讯并保留来源。'});
test('one-time task input uses Beijing time even when the device timezone differs',()=>{
  const value=workflowPayload({...draft(),scheduleType:'once',runAt:'2026-11-06T08:30'},scope);
  assert.equal(value.schedule.runAt,'2026-11-06T00:30:00.000Z');assert.equal(value.schedule.timezone,'Asia/Shanghai');assert.equal(value.confirmed,true);
  assert.match(workflowSchedule(value.schedule),/8:30|08:30/);assert.throws(()=>workflowPayload({...draft(),scheduleType:'once',runAt:'2026-02-30T08:30'},scope));
  assert.throws(()=>workflowPayload({...draft(),scheduleType:'once',runAt:'2026-11-04T08:30'},scope),/未来/);
});
test('recurring tasks have explicit valid local time and one-based weekdays',()=>{
  const value=workflowPayload({...draft(),scheduleType:'weekly',time:'23:15',weekdays:[7,1,1]},scope);
  assert.deepEqual(value.schedule.weekdays,[1,7]);assert.equal(workflowSchedule(value.schedule),'周一、周日 23:15');
  assert.throws(()=>workflowPayload({...draft(),scheduleType:'weekly',weekdays:[]},scope),/至少/);assert.throws(()=>workflowPayload({...draft(),scheduleType:'weekly',weekdays:[0]},scope));assert.throws(()=>workflowPayload({...draft(),time:'24:00'},scope));
});
test('only a verified proactive channel belonging to the current assistant can be selected',()=>{
  const channel={id:'one',assistantId:'daily',enabled:true,status:'verified',supportProactive:true,target:'fixture:FriendMessage:10001'};
  const channels=[channel,{...channel,id:'unverified',status:'configured'},{...channel,id:'other',assistantId:'game'},{...channel,id:'passive',supportProactive:false},{...channel,id:'disabled',enabled:false}];
  assert.deepEqual(workflowChannels(channels,'daily').map(c=>c.id),['one']);
  assert.equal(workflowPayload({...draft(),channel:'one'},{...scope,channels}).channel,'one');assert.throws(()=>workflowPayload({...draft(),channel:'unverified'},{...scope,channels}),/已验证/);
});
test('RSS tasks require current-assistant source selection and cannot silently adopt another source',()=>{
  const sources=[{id:'own',assistantId:'daily'},{id:'other',assistantId:'game'}];
  assert.throws(()=>workflowPayload({...draft(),kind:'rss',sourceIds:[]},{...scope,sources}),/至少/);
  assert.throws(()=>workflowPayload({...draft(),kind:'rss',sourceIds:['other']},{...scope,sources}),/当前助手/);
  const value=workflowPayload({...draft(),kind:'rss',sourceIds:['own','own']},{...scope,sources});assert.deepEqual(value.sourceIds,['own']);
});
test('read results never display another assistant workflow, run, or source',()=>{
  const value=workflowView({items:[{id:'one',assistantId:'daily'},{id:'two',assistantId:'game'}],runs:[{id:'run1',workflowId:'one'},{id:'run2',workflowId:'two'}],sources:[{id:'s1',assistantId:'daily'},{id:'s2',assistantId:'game'}]},'daily');
  assert.deepEqual(value.items.map(i=>i.id),['one']);assert.deepEqual(value.runs.map(i=>i.id),['run1']);assert.deepEqual(value.sources.map(i=>i.id),['s1']);assert.deepEqual(workflowView(null,'daily'),{items:[],runs:[],sources:[],scheduler:null});
});
test('uncertain delivery and in-flight executions disable manual duplicate execution',()=>{
  const item={status:'active'};for(const status of ['queued','running','delivery_unknown'])assert.equal(canRunWorkflow(item,{status}),false);
  assert.equal(canRunWorkflow(item,{status:'failed',deliveryStatus:'unknown'}),false);assert.equal(canRunWorkflow({status:'paused'},{status:'failed'}),true);assert.equal(canRunWorkflow({status:'completed'},{status:'completed'}),false);assert.equal(canRunWorkflow({...item,bindingStatus:'needs_runtime'},{status:'failed'}),false);assert.equal(canRunWorkflow(item,{status:'failed'}),true);
  const runs=workflowRuns([{id:'old',workflowId:'one',startedAt:'2026-11-04T00:00:00Z'},{id:'queue',workflowId:'one',createdAt:'2026-11-05T00:00:00Z'},{id:'foreign',workflowId:'two',createdAt:'2026-11-06T00:00:00Z'}],'one');assert.deepEqual(runs.map(r=>r.id),['queue','old']);
});
test('source links and new subscriptions reject executable URLs or URL credentials',()=>{
  assert.equal(publicSourceLink('javascript:alert(1)'), '');assert.equal(publicSourceLink('https://user:secret@example.com/feed'),'');assert.equal(publicSourceLink('/relative'),'');
  assert.throws(()=>rssSourcePayload({url:'http://example.com/feed'},scope),/HTTPS/);assert.throws(()=>rssSourcePayload({url:'https://user:secret@example.com/feed'},scope));
  assert.deepEqual(rssSourcePayload({url:'https://example.com/feed',name:''},scope),{assistantId:'daily',requestId:'synthetic-ui-request',url:'https://example.com/feed',name:'example.com'});assert.equal(workflowDate('invalid'),'待确认');
});
