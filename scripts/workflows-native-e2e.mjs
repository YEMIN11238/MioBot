// Real native agent + CronJobManager + RSSHub parser. Only local deterministic
// model/search/feed fixtures; no provider balance or production account is used.
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {startServer} from '../server/index.mjs';
const root=resolve(import.meta.dirname,'..'),data=mkdtempSync(join(tmpdir(),'miobot-workflow-e2e-')),artifact=join(root,'artifacts/workflows-integration-20261105');
const calls=[],searches=[],checks=[];let app,failure,report;
const instruction='每天早上8点搜索Minecraft最新消息并整理简报';
const text=v=>typeof v==='string'?v:Array.isArray(v)?v.map(p=>p.text||'').join(''):'';
const model=createServer(async(req,res)=>{try{
  let raw='';for await(const chunk of req)raw+=chunk;const input=raw?JSON.parse(raw):{};
  if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'workflow-fixture'}]}));}
  assert.equal(req.url,'/v1/chat/completions');
  const messages=input.messages||[],system=messages.filter(m=>m.role==='system').map(m=>text(m.content)).join('\n'),user=text(messages.findLast(m=>m.role==='user')?.content),result=messages.findLast(m=>m.role==='tool'),tools=(input.tools||[]).map(t=>t.function.name);
  let content,tool;
  if(system.includes('You are a conversation title generator.')){content='定时工作验收';calls.push({kind:'auxiliary_title'});}
  else if(user.includes('<untrusted_source_material>')){assert.deepEqual(tools,[]);content='订阅简报：测试公告已发布。来源 https://news.example.org/item1';calls.push({kind:'rss',tools});}
  else if(user.includes('执行主人已经确认的这一次定时工作')){
    assert.deepEqual(tools,['miobot_search_web']);calls.push({kind:'scheduled_agent',tools,hasToolResult:!!result});
    if(!result)tool={id:'search-e2e',type:'function',function:{name:'miobot_search_web',arguments:JSON.stringify({query:'Minecraft 最新消息',max_results:3})}};
    else{const parsed=JSON.parse(text(result.content));assert.equal(parsed.ok,true);assert.ok(parsed.results.length);content='已查到测试公告。来源 https://news.example.org/minecraft';}
  }else{
    assert.ok(tools.includes('miobot_schedule_workflow'));calls.push({kind:'normal_chat',tools,hasToolResult:!!result});
    if(!result)tool={id:'schedule-e2e',type:'function',function:{name:'miobot_schedule_workflow',arguments:JSON.stringify({title:'游戏简报',instruction,schedule_json:JSON.stringify({type:'daily',time:'08:00',timezone:'Asia/Shanghai'})})}};
    else{assert.equal(JSON.parse(text(result.content)).ok,true);content='好，每天早上8点整理给你。';}
  }
  if(input.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta:tool?{tool_calls:[{index:0,...tool}]}:{content},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');}
  else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',object:'chat.completion',model:'workflow-fixture',choices:[{index:0,message:{role:'assistant',content:content||null,...(tool?{tool_calls:[tool]}:{})},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));}
}catch(error){failure=error;res.statusCode=500;res.end(JSON.stringify({error:{message:'Local workflow fixture assertion failed'}}));}});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const picker=createServer();await new Promise(r=>picker.listen(0,'127.0.0.1',r));const nativePort=picker.address().port;await new Promise(r=>picker.close(r));
async function api(path,method='GET',body){const r=await fetch(app.url+path,{method,headers:{'Content-Type':'application/json','X-Personal-Agent':'1'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(90000)});const value=await r.json();if(failure)throw failure;assert.ok(r.ok,JSON.stringify({path,status:r.status,value}));return value;}
async function until(check,ms=45000){const until=Date.now()+ms;while(Date.now()<until){if(failure)throw failure;const result=check();if(result)return result;await new Promise(r=>setTimeout(r,250));}throw Error('Workflow fixture timed out: '+JSON.stringify(app.store.state.workflowRuns));}
try{
  const seed=new Store(data);seed.state.settings.runtimeUrl='http://127.0.0.1:'+nativePort;seed.save();
  mkdirSync(join(data,'astrbot/data'),{recursive:true});cpSync(join(root,'.runtime/native-runtime/astrbot/astrbot/dashboard/dist'),join(data,'astrbot/data/dist'),{recursive:true});
  app=await startServer({root,dataRoot:data,port:0,sharingPort:0,
    fetcher:(url,options)=>{assert.equal(new URL(url).hostname,'127.0.0.1');return fetch(url,options);},
    researchOptions:{lookup:async()=>[{address:'1.1.1.1',family:4}],fetcher:async(url)=>{assert.equal(url,'https://api.tavily.com/search');searches.push({fixture:true});return Response.json({results:[{title:'Minecraft测试公告',url:'https://news.example.org/minecraft',content:'这是本地确定性搜索测试资料。'}]});}},
    rssOptions:{lookup:async()=>[{address:'1.1.1.1',family:4}],fetcher:async()=>new Response('<rss version="2.0"><channel><title>测试源</title><item><guid>fixture1</guid><title>测试公告</title><link>https://news.example.org/item1</link><description>仅用于离线验收。</description></item></channel></rss>',{headers:{'content-type':'application/rss+xml'}})},
  });
  await app.runtime.start();
  await api('/api/model-connections','POST',{name:'Local workflow fixture',template:'openai',type:'openai_chat_completion',provider:'openai',apiBase:'http://127.0.0.1:'+model.address().port+'/v1',model:'workflow-fixture',key:'offline-fixture-not-a-provider-key'});
  app.store.state.extensionConfig.web={provider:'tavily'};app.store.secrets.extensions.web={key:'offline-search-fixture'};app.store.save();
  const chat=await api('/api/chats','POST',{assistantId:'daily'});
  const answer=await api('/api/chats/'+chat.id+'/messages','POST',{text:instruction,requestId:'create-daily-workflow'});
  assert.equal(answer.status,'complete');assert.ok(answer.toolCalls.some(t=>t.name==='schedule_workflow'&&t.ok));
  const plan=app.store.state.workflows.find(w=>w.title==='游戏简报');assert.ok(plan);assert.equal(plan.bindingStatus,'ready');checks.push('normal native model tool saved and bound an actual daily job');
  const queued=await api('/api/workflows/'+plan.id+'/run','POST',{requestId:'manual-agent',assistantId:'daily'});
  const agent=await until(()=>app.store.state.workflowRuns.find(r=>r.id===queued.run.id&&r.status==='completed'));assert.equal(agent.deliveryStatus,'inbox');assert.equal(searches.length,1);assert.ok(agent.sources.length);checks.push('native agent called actual host search bridge; result and sources persisted');
  const source=await api('/api/rss/sources','POST',{assistantId:'daily',url:'https://news.example.org/feed',name:'测试信息源',requestId:'source-e2e'});
  const rssPlan=await api('/api/workflows','POST',{assistantId:'daily',title:'RSS简报',instruction:'整理新条目并提供来源',kind:'rss',sourceIds:[source.id],schedule:{type:'once',runAt:new Date(Date.now()+4000).toISOString(),timezone:'Asia/Shanghai'},channel:'web',requestId:'rss-e2e',confirmed:true});assert.equal(rssPlan.bindingStatus,'ready');
  const rss=await until(()=>app.store.state.workflowRuns.find(r=>r.workflowId===rssPlan.id&&r.status==='completed'));assert.equal(rss.manual,false);assert.equal(rss.deliveryStatus,'inbox');assert.ok(app.store.state.rssDeliveryLedger.length);checks.push('native date trigger executed RSSHub parser and model summary without an open browser');
  const before=calls.length,repeat=await api('/api/workflows/'+rssPlan.id+'/run','POST',{requestId:'rss-no-new',assistantId:'daily'});
  const empty=await until(()=>app.store.state.workflowRuns.find(r=>r.id===repeat.run.id&&r.status==='completed'));assert.equal(empty.noNewItems,true);assert.equal(calls.length,before);checks.push('second feed scan deduplicated accepted items and made zero model calls');
  const disk=new Store(data);assert.equal(disk.state.workflowRuns.filter(r=>r.status==='completed').length,3);assert.equal(disk.state.notifications.filter(n=>n.runId).length,3);
  report={success:true,actualNativeRuntime:true,actualNativeCron:true,actualRssHubParser:true,checks,completedRuns:3,modelRequests:calls,searchFixtureCalls:searches.length,paidCalls:0,realQQMessages:0,physicalPhonePushTested:false,productionDataRead:false};
  console.log(JSON.stringify(report,null,2));
}catch(error){report={success:false,error:String(failure?.stack||error.stack),checks,calls,paidCalls:0,productionDataRead:false};console.error(JSON.stringify(report,null,2));process.exitCode=1;}
finally{const child=app?.runtime.child;if(app)await app.close();if(child&&child.exitCode===null)await new Promise(r=>{const t=setTimeout(()=>{child.kill('SIGKILL');r();},5000);child.once('exit',()=>{clearTimeout(t);r();});});model.closeAllConnections();await new Promise(r=>model.close(r));rmSync(data,{recursive:true,force:true});mkdirSync(artifact,{recursive:true});writeFileSync(join(artifact,'native-e2e.json'),JSON.stringify(report,null,2)+'\n');}
