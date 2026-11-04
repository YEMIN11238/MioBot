import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import {startServer} from '../server/index.mjs';
import {Store} from '../server/store.mjs';
import {nextWorkflowRun} from '../server/workflows.mjs';

const tls={'X-Forwarded-Proto':'https'}; // Simulate the reverse proxy; no real phone or TLS service is contacted.
const daily={type:'daily',time:'08:15',timezone:'Asia/Shanghai'};
const definition=extra=>({requestId:randomUUID(),assistantId:'daily',title:'隔离测试安排',instruction:'整理我已经提供的计划',kind:'agent',schedule:daily,channel:'web',sourceIds:[],confirmed:true,...extra});
function subscription(label){const ec=createECDH('prime256v1');ec.generateKeys();return {endpoint:'https://push.example.org/'+label,expirationTime:null,keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};}

async function fixture(t){
  const directory=mkdtempSync(join(tmpdir(),'miobot-workflow-http-')),ownerToken=randomBytes(32).toString('base64url');
  const external=[],executions=[],syncs=[],pushes=[],feeds=[];let app,now=Date.now();
  app=await startServer({dataRoot:directory,port:0,sharingPort:0,cloudMode:true,cloudToken:ownerToken,
    fetcher:async input=>{external.push(String(input));throw Error('fixture rejects native, model and QQ requests');},
    workflowExecutor:async input=>{
      executions.push(structuredClone({workflow:input.workflow,run:input.run,feed:input.feed}));
      const chat=app.store.createChat(input.workflow.assistantId);Object.assign(chat,{origin:'workflow',workflowId:input.workflow.id,workflowRunId:input.run.id,runStatus:'idle'});
      return {text:input.feed?'隔离简报：仅使用注入的公开条目。':'隔离任务输出：计划已整理。',chatId:chat.id,sources:input.feed?.items.map(item=>({title:item.title,url:item.url}))||[]};
    },
    rssOptions:{now:()=>now,lookup:async()=>[{address:'1.1.1.1',family:4}],fetcher:async(url,options)=>{feeds.push({url,redirect:options.redirect});return new Response('<rss><channel/></rss>',{headers:{'content-type':'application/rss+xml'}});},parser:async()=>({items:[{id:'synthetic-article',title:'隔离公开条目',url:'https://news.example.org/article',summary:'仅供协议测试的资料'}]})},
    pushOptions:{now:()=>now,resolver:async()=>[{address:'1.1.1.1',family:4}],sender:async(sub,payload)=>{pushes.push({endpoint:sub.endpoint,payload:JSON.parse(payload)});return {statusCode:201};}},
  });
  app.runtime.status='ready';app.runtime.token='synthetic-runtime-token';app.runtime.syncWorkflows=async args=>{syncs.push(structuredClone(args));return {ready:true,jobs:args.jobs.map(job=>({id:job.id,nextRunAt:nextWorkflowRun(job.schedule,now)}))};};
  app.workflows.now=()=>now;
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});assert.deepEqual(external,[],'no native runtime, model, QQ or other provider may be called');assert.equal(app.runtime.child,null);});
  const request=(path,{method='GET',body,headers={}}={})=>new Promise((resolve,reject)=>{
    const payload=body===undefined?undefined:JSON.stringify(body);
    const req=httpRequest(new URL(path,app.url),{method,headers:{'X-Personal-Agent':'1','Content-Type':'application/json',...(payload!==undefined?{'Content-Length':Buffer.byteLength(payload)}:{}),...headers}},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,value:JSON.parse(Buffer.concat(chunks).toString()),cookie:res.headers['set-cookie']?.[0]});}catch(e){reject(e);}});});
    req.on('error',reject);req.setTimeout(10000,()=>req.destroy(Error('isolated HTTP request timed out')));req.end(payload);
  });
  const owner=(path,options={})=>request(path,{...options,headers:{Authorization:'Bearer '+ownerToken,...options.headers}});
  const pair=async label=>{
    const issued=await owner('/api/devices/pairings',{method:'POST',body:{label}});assert.equal(issued.status,201,JSON.stringify(issued.value));
    const joined=await request('/api/device-sessions',{method:'POST',body:{code:issued.value.code,label}});assert.equal(joined.status,201,JSON.stringify(joined.value));
    const cookie=joined.cookie.split(';')[0];return {device:joined.value.device,request:(path,options={})=>request(path,{...options,headers:{Cookie:cookie,...options.headers}})};
  };
  const execute=async runId=>{await app.workflows.run(runId);for(let attempts=0;app.workflows.running.has(runId)&&attempts<100;attempts++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(app.workflows.running.has(runId),false);};
  return {app,directory,owner,request,pair,executions,syncs,pushes,feeds,execute,advance:ms=>{now+=ms},clock:()=>now};
}

test('HTTP confirmed daily plans are idempotent, pause and resume, then persist manual output in chat and inbox',async t=>{
  const f=await fixture(t),phone=await f.pair('任务手机'),input=definition();
  const made=await phone.request('/api/workflows',{method:'POST',body:input});assert.equal(made.status,201,JSON.stringify(made.value));assert.equal(made.value.bindingStatus,'ready');assert.deepEqual(made.value.schedule,daily);
  const duplicate=await f.owner('/api/workflows',{method:'POST',body:input});assert.equal(duplicate.value.id,made.value.id);assert.equal(duplicate.value.duplicate,true);assert.equal(f.executions.length,0,'saving a plan does not call a model');assert.equal(f.syncs.at(-1).jobs[0].active,true);
  const reused=await phone.request('/api/workflows',{method:'POST',body:{...input,instruction:'不同的工作'}});assert.equal(reused.status,409);
  const rejected=await phone.request('/api/workflows',{method:'POST',body:definition({confirmed:false})});assert.equal(rejected.status,409);
  const endpoint='/api/workflows/'+made.value.id;
  assert.equal((await phone.request(endpoint,{method:'PATCH',body:{action:'pause',assistantId:'daily'}})).value.status,'paused');assert.equal(f.syncs.at(-1).jobs[0].active,false);
  assert.equal((await f.owner('/api/workflows?assistantId=daily')).value.items[0].status,'paused');
  assert.equal((await phone.request(endpoint,{method:'PATCH',body:{action:'resume',assistantId:'daily'}})).value.status,'active');
  const runInput={requestId:randomUUID(),assistantId:'daily'},queued=await phone.request(endpoint+'/run',{method:'POST',body:runInput});assert.equal(queued.status,202);assert.equal(queued.value.run.status,'queued');
  const repeated=await phone.request(endpoint+'/run',{method:'POST',body:runInput});assert.equal(repeated.value.run.id,queued.value.run.id);assert.equal(repeated.value.duplicate,true);
  await f.execute(queued.value.run.id);assert.equal(f.executions.length,1);
  const listed=await phone.request('/api/workflows?assistantId=daily');assert.equal(listed.value.runs[0].status,'completed');assert.equal(listed.value.runs[0].deliveryStatus,'inbox');assert.equal(listed.value.items[0].status,'active','a manual run keeps the daily plan');
  const state=(await phone.request('/api/state')).value,record=listed.value.runs[0];assert.ok(state.notifications.some(n=>n.runId===record.id&&!n.read));assert.equal(state.chats.find(c=>c.id===record.chatId).messages.find(m=>m.workflowRunId===record.id).text,record.result);
  const reloaded=new Store(f.directory);assert.equal(reloaded.state.workflowRuns.find(r=>r.id===record.id).result,'隔离任务输出：计划已整理。');assert.ok(reloaded.state.notifications.some(n=>n.runId===record.id));
  assert.equal((await phone.request('/api/chats/'+record.chatId+'/messages',{method:'POST',body:{text:'不能在执行记录里继续聊天',requestId:randomUUID()}})).status,400);
  assert.equal((await phone.request(endpoint,{method:'PATCH',body:{action:'cancel',assistantId:'daily'}})).value.status,'cancelled');
});

test('HTTP private phone subscriptions enforce HTTPS and their own identity; owner revocation removes saved push endpoints',async t=>{
  const f=await fixture(t),one=await f.pair('通知手机一'),two=await f.pair('通知手机二'),first=subscription('phone-one'),second=subscription('phone-two'),ownerSub=subscription('owner');
  const initial=await one.request('/api/push');assert.equal(initial.status,200);assert.equal(initial.value.status,'needs_https');assert.equal(initial.value.subscribed,false);
  const insecure=await one.request('/api/push/subscription',{method:'POST',body:{subscription:first}});assert.equal(insecure.status,409);assert.equal(insecure.value.code,'PUSH_HTTPS_REQUIRED');
  assert.equal((await one.request('/api/push/test',{method:'POST',body:{}})).value.code,'PUSH_HTTPS_REQUIRED');
  assert.equal((await one.request('/api/push/subscription',{method:'POST',headers:tls,body:{subscription:subscription('bad'),deviceId:two.device.id}})).status,400);
  assert.equal((await one.request('/api/push/subscription',{method:'POST',headers:tls,body:{subscription:first}})).status,201);
  assert.equal((await two.request('/api/push/subscription',{method:'POST',headers:tls,body:{subscription:second}})).status,201);
  assert.equal((await f.owner('/api/push/subscription',{method:'POST',headers:tls,body:{subscription:ownerSub}})).status,201);
  assert.equal((await one.request('/api/push/subscription',{method:'POST',headers:tls,body:{subscription:second}})).status,409,'cannot overwrite the other phone endpoint');
  assert.equal((await one.request('/api/push/subscription',{method:'DELETE',body:{deviceId:two.device.id}})).status,400);
  assert.equal((await one.request('/api/push/test',{method:'POST',headers:tls,body:{}})).value.accepted,1);assert.deepEqual(f.pushes.map(p=>p.endpoint),[first.endpoint]);assert.equal(f.pushes[0].payload.title,'MioBot');assert.equal(Object.hasOwn(f.pushes[0].payload,'delivered'),false);
  const state=JSON.stringify((await one.request('/api/state')).value);for(const privateValue of [first.endpoint,second.endpoint,ownerSub.endpoint,first.keys.auth,f.app.store.secrets.webPush.vapid.privateKey])assert.equal(state.includes(privateValue),false);
  assert.equal((await one.request('/api/devices/'+two.device.id,{method:'DELETE'})).status,403);
  assert.equal((await f.owner('/api/devices/'+one.device.id,{method:'DELETE'})).status,200);assert.equal((await one.request('/api/push',{headers:tls})).status,401);
  assert.equal(f.app.store.secrets.webPush.subscriptions.some(s=>s.scope==='device:'+one.device.id),false);assert.equal((await two.request('/api/push',{headers:tls})).value.subscribed,true);assert.equal((await f.owner('/api/push',{headers:tls})).value.subscribed,true);
  assert.equal((await two.request('/api/push/subscription',{method:'DELETE',body:{}})).status,200);assert.equal((await two.request('/api/push',{headers:tls})).value.subscribed,false);assert.equal((await f.owner('/api/push',{headers:tls})).value.subscribed,true);
});

test('internal native trigger needs the bridge token and a current exact occurrence, and cannot enqueue duplicate sends',async t=>{
  const f=await fixture(t),runAt=new Date(f.clock()+60000).toISOString(),made=await f.owner('/api/workflows',{method:'POST',body:definition({schedule:{type:'once',runAt,timezone:'Asia/Shanghai'}})});assert.equal(made.status,201);
  f.advance(60000);const trigger={workflowId:made.value.id,revision:made.value.revision,scheduledAt:runAt},path='/internal/workflows/trigger';
  for(const headers of [{},{'X-MioBot-Tool-Token':'wrong'},{Authorization:'Bearer '+f.app.runtime.toolBridge.token},{'X-MioBot-Tool-Token':f.app.runtime.toolBridge.token,Origin:f.app.url}])assert.equal((await f.request(path,{method:'POST',headers,body:trigger})).status,403);
  assert.equal(f.app.store.state.workflowRuns.length,0);
  const headers={'X-MioBot-Tool-Token':f.app.runtime.toolBridge.token},accepted=await f.request(path,{method:'POST',headers,body:trigger});assert.equal(accepted.status,200);assert.equal(accepted.value.run.status,'queued');
  const duplicate=await f.request(path,{method:'POST',headers,body:trigger});assert.equal(duplicate.value.duplicate,true);assert.equal(duplicate.value.run.id,accepted.value.run.id);
  assert.equal((await f.request(path,{method:'POST',headers,body:{...trigger,revision:trigger.revision+1}})).status,409);
  await f.execute(accepted.value.run.id);assert.equal(f.executions.length,1);const listed=(await f.owner('/api/workflows?assistantId=daily')).value;assert.equal(listed.items[0].status,'completed');assert.equal(listed.runs[0].deliveryStatus,'inbox');assert.equal(f.app.store.state.notifications.length,1);
});

test('paired RSS sources feed scheduled work only on execution; committed articles are not generated or pushed twice',async t=>{
  const f=await fixture(t),phone=await f.pair('资讯手机');
  const rejected=await phone.request('/api/rss/sources',{method:'POST',body:{assistantId:'daily',name:'内网地址',url:'https://127.0.0.1/feed'}});assert.equal(rejected.status,400);assert.equal(rejected.value.code,'UNSAFE_FEED_URL');
  const source=await phone.request('/api/rss/sources',{method:'POST',body:{requestId:randomUUID(),assistantId:'daily',name:'隔离信息源',url:'https://news.example.org/feed'}});assert.equal(source.status,201);assert.equal(f.feeds.length,0);
  assert.equal((await phone.request('/api/rss/sources?assistantId=daily')).value.items[0].id,source.value.id);
  assert.equal((await phone.request('/api/push/subscription',{method:'POST',headers:tls,body:{subscription:subscription('rss-phone')}})).status,201);
  const made=await phone.request('/api/workflows',{method:'POST',body:definition({kind:'rss',instruction:'整理这条公开订阅并保留原文链接',sourceIds:[source.value.id]})});assert.equal(made.status,201);assert.equal(f.executions.length,0);
  const run=await phone.request('/api/workflows/'+made.value.id+'/run',{method:'POST',body:{requestId:randomUUID()}});await f.execute(run.value.run.id);assert.equal(f.feeds.length,1);assert.equal(f.feeds[0].redirect,'manual');assert.equal(f.executions[0].feed.contentTrust,'untrusted_source_material');assert.equal(f.executions[0].feed.items[0].url,'https://news.example.org/article');
  const listed=(await phone.request('/api/workflows?assistantId=daily')).value;assert.equal(listed.runs[0].status,'completed');assert.equal(listed.runs[0].sources[0].url,'https://news.example.org/article');assert.equal(f.app.store.state.rssDeliveryLedger.length,1);assert.equal(f.pushes.length,1);assert.equal(f.pushes[0].payload.title,'MioBot');assert.equal(f.pushes[0].payload.notificationId,'workflow-'+run.value.run.id);assert.equal(f.pushes[0].payload.body.includes('隔离简报'),false);
  const second=await phone.request('/api/workflows/'+made.value.id+'/run',{method:'POST',body:{requestId:randomUUID()}});await f.execute(second.value.run.id);assert.equal(f.executions.length,1,'already delivered RSS articles do not call the executor again');assert.equal(f.app.store.state.workflowRuns.find(r=>r.id===second.value.run.id).noNewItems,true);assert.equal(f.pushes.length,1,'no new RSS articles do not create a second lock-screen push');
  assert.equal((await phone.request('/api/rss/sources/'+source.value.id+'?assistantId=game',{method:'DELETE'})).status,404);assert.equal((await phone.request('/api/rss/sources/'+source.value.id+'?assistantId=daily',{method:'DELETE'})).status,200);
  const disk=JSON.parse(readFileSync(f.app.store.file,'utf8'));assert.equal(disk.rssDeliveryLedger.length,1);assert.equal(disk.workflowRuns.length,2);
});
