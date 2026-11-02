// Read-only diagnostic of the real native/BFF rendering boundary. The model,
// reasoning strings, users, tool results, data root and ports are fixtures.
// --assert-clean makes any reproduced reasoning leak fail the process.
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {startServer} from '../server/index.mjs';

const root=resolve(import.meta.dirname,'..'),data=mkdtempSync(join(tmpdir(),'miobot-reasoning-native-'));
const modes=['plain','humanized'],cases=['structured-tool-loop','body-think','body-thinking','body-reasoning','framework-wrapper','ordinary-thinking','literal-thinking-header','code-wrapper-example'];
const secret=kind=>'MIOBOT_SYNTH_REASON_'+kind.toUpperCase().replaceAll('-','_');
const leaked=value=>/MIOBOT_SYNTH_REASON_[A-Z_]+/.test(value);
const textOf=value=>typeof value==='string'?value:Array.isArray(value)?value.map(part=>part?.text||'').join('\n'):'';
const marker=mode=>'MIOBOT_REASONING_NATIVE_'+mode.toUpperCase();
const records=[],providerCalls=[],nativeFlags=[];let app,active,fixtureError;
function body(kind){
  if(kind==='body-think')return `<think>${secret(kind)}</think>给你留的是正式回答。`;
  if(kind==='body-thinking')return `<thinking>${secret(kind)}</thinking>给你留的是正式回答。`;
  if(kind==='body-reasoning')return `<reasoning>${secret(kind)}</reasoning>给你留的是正式回答。`;
  if(kind==='framework-wrapper')return `🤔 思考: ${secret(kind)}\n\n────\n\n给你留的是正式回答。`;
  if(kind==='ordinary-thinking')return '我在思考这个方案，先把可行的两条路线理一理。';
  if(kind==='literal-thinking-header')return '🤔 思考：这一步要怎么做？';
  if(kind==='code-wrapper-example')return '示例代码：\n```text\n🤔 思考: 这是一段代码示例\n────\n```';
  return '列表已查完，当前没有提醒。';
}
async function wire(res,event){
  const bytes=Buffer.from('data: '+JSON.stringify(event)+'\n\n');let offset=0;
  for(const n of [1,3,7,19,47]){if(offset>=bytes.length)break;res.write(bytes.subarray(offset,offset+n));offset+=n;}
  if(offset<bytes.length)res.write(bytes.subarray(offset));await new Promise(r=>setTimeout(r,1));
}
async function completion(res,input,{content,reasoning,toolCall}){
  if(!input.stream){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({id:'reasoning-fixture',object:'chat.completion',created:1,model:input.model,choices:[{index:0,message:{role:'assistant',content:content??null,...(reasoning?{reasoning_content:reasoning}:{}),...(toolCall?{tool_calls:[toolCall]}:{})},finish_reason:toolCall?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk=delta=>({id:'reasoning-fixture',object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,delta,finish_reason:null}]});
  if(reasoning){await wire(res,chunk({role:'assistant',reasoning_content:reasoning.slice(0,11)}));await wire(res,chunk({reasoning_content:reasoning.slice(11)}));}
  if(toolCall){const args=toolCall.function.arguments;await wire(res,chunk({tool_calls:[{index:0,id:toolCall.id,type:'function',function:{name:toolCall.function.name,arguments:args.slice(0,1)}}]}));await wire(res,chunk({tool_calls:[{index:0,function:{arguments:args.slice(1)}}]}));}
  else{const characters=[...(content||'')];for(let i=0;i<characters.length;i+=3)await wire(res,chunk({role:'assistant',content:characters.slice(i,i+3).join('')}));}
  await wire(res,{id:'reasoning-fixture',object:'chat.completion.chunk',created:1,model:input.model,choices:[{index:0,delta:{},finish_reason:toolCall?'tool_calls':'stop'}]});res.end('data: [DONE]\n\n');
}
const model=createServer(async(req,res)=>{
  try{
    let raw='';for await(const chunk of req)raw+=chunk;const input=raw?JSON.parse(raw):{};
    if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'deepseek-flash'}]}));}
    assert.equal(req.url,'/v1/chat/completions');const system=(input.messages||[]).filter(message=>message.role==='system').map(message=>textOf(message.content)).join('\n'),mode=modes.find(name=>system.includes(marker(name)));
    if(!mode)return completion(res,input,{content:'本地验收标题'});
    assert.equal(mode,active.mode);assert.equal(input.stream,mode==='plain');
    const toolResult=[...(input.messages||[])].reverse().find(message=>message.role==='tool');providerCalls.push({mode,kind:active.kind,stream:input.stream===true,thinkingType:input.thinking?.type||null,toolResult:!!toolResult,styleInjected:system.includes('【人类对话风格】')});
    if(mode==='humanized')assert.ok(system.includes('【人类对话风格】'),'the actual humanizer must be selected');
    if(active.kind==='structured-tool-loop'&&!toolResult){assert.ok(input.tools?.some(tool=>tool.function?.name==='miobot_list_reminders'));active.toolRequested=true;return completion(res,input,{reasoning:secret('typed-before-tool'),toolCall:{id:'reasoning-tool-'+mode,type:'function',function:{name:'miobot_list_reminders',arguments:'{}'}}});}
    if(active.kind==='structured-tool-loop'){const result=JSON.parse(textOf(toolResult?.content));assert.equal(result.ok,true,JSON.stringify(result));assert.ok(Array.isArray(result.tasks));active.toolResultVerified=true;return completion(res,input,{content:body(active.kind),reasoning:secret('typed-after-tool')});}
    return completion(res,input,{content:body(active.kind),reasoning:secret('typed-channel')});
  }catch(error){fixtureError=error;res.statusCode=500;res.end(JSON.stringify({error:{message:'Isolated reasoning fixture assertion failed'}}));}
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));const picker=createServer();await new Promise(r=>picker.listen(0,'127.0.0.1',r));const nativePort=picker.address().port;await new Promise(r=>picker.close(r));

try{
  const seed=new Store(data);seed.state.settings={...seed.state.settings,location:'local',runtimeUrl:'http://127.0.0.1:'+nativePort,defaultConnectionId:'fixture'};
  seed.state.modelConnections=[{id:'fixture',name:'Isolated reasoning fixture',template:'deepseek',type:'openai_chat_completion',provider:'openai',apiBase:'http://127.0.0.1:'+model.address().port+'/v1',model:'deepseek-flash',config:{custom_extra_body:{thinking:{type:'enabled'}}}}];seed.secrets.modelConnections.fixture={key:['offline-fixture-not-a-real-provider-key']};
  seed.state.assistants=modes.map(mode=>({id:'reasoning-'+mode,name:'本地'+mode+'验收',kind:'career',persona:marker(mode)+'\n你是测试助手，只根据真实工具结果回答。',enabled:true,skills:['reminders',...(mode==='humanized'?['humanize']:[])],care:{enabled:false,deliveryChannel:'web'}}));seed.state.extensions={memory:false,reminders:true,web:false,files:false,voice:false,stickers:false};seed.setSecrets({});seed.save();mkdirSync(join(data,'astrbot/data'),{recursive:true});cpSync(join(root,'.runtime/native-runtime/astrbot/astrbot/dashboard/dist'),join(data,'astrbot/data/dist'),{recursive:true});
  app=await startServer({root,dataRoot:data,port:0,fetcher:async(url,options)=>{
    assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname));const response=await fetch(url,options);
    if(new URL(url).pathname!=='/api/v1/chat')return response;
    const sent=JSON.parse(options.body);nativeFlags.push({mode:active.mode,kind:active.kind,enableReasoning:sent.enable_reasoning,flagsEnableReasoning:sent.flags?.enable_reasoning});
    // Re-chunk the *real* native SSE body; no events or results are fabricated.
    const reader=response.body.getReader();return new Response(new ReadableStream({async pull(controller){const value=await reader.read();if(value.done)return controller.close();for(let i=0;i<value.value.length;i+=7)controller.enqueue(value.value.subarray(i,i+7));},cancel:reason=>reader.cancel(reason)}),{status:response.status,headers:response.headers});
  }});await app.runtime.start();
  for(const mode of modes)for(const kind of cases){
    const chat=app.store.createChat('reasoning-'+mode);active={mode,kind};const response=await fetch(app.url+`/api/chats/${chat.id}/messages/stream`,{method:'POST',headers:{'X-Personal-Agent':'1','Content-Type':'application/json'},body:JSON.stringify({text:'进行一次本地显示验收：'+kind,requestId:'reasoning-'+mode+'-'+kind}),signal:AbortSignal.timeout(90000)}),raw=await response.text();if(fixtureError)throw fixtureError;assert.equal(response.status,200);
    const events=raw.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5).trim())),done=events.find(event=>event.type==='done');assert.ok(done,'native fixture should finish without a pipeline failure');assert.equal(done.message.status,'complete');
    const state=await fetch(app.url+'/api/state',{headers:{'X-Personal-Agent':'1'}}).then(r=>r.json()),snapshot=state.chats.find(item=>item.id===chat.id).messages.find(message=>message.id===done.message.id),profile=(await app.runtime.request('/config-profiles/'+encodeURIComponent(app.runtime.profileIds.get('reasoning-'+mode+':fixture')))).config;
    const live=events.filter(event=>['delta','part'].includes(event.type)).map(event=>event.text||'').join(''),natural=['ordinary-thinking','literal-thinking-header','code-wrapper-example'].includes(kind),expected=natural?body(kind):kind==='structured-tool-loop'?body(kind):'给你留的是正式回答。';
    if(kind==='structured-tool-loop'){assert.equal(active.toolRequested,true);assert.equal(active.toolResultVerified,true);assert.ok(done.message.toolCalls?.some(call=>call.name==='list_reminders'&&call.ok));}
    const calls=providerCalls.filter(call=>call.mode===mode&&call.kind===kind);assert.ok(calls.length);assert.ok(calls.every(call=>call.thinkingType==='enabled'),'UI reasoning flags must not be confused with provider thinking control');
    records.push({mode,kind,providerStream:calls[0].stream,providerThinkingType:calls[0].thinkingType,profileDisplayReasoning:profile.provider_settings.display_reasoning_text,nativeFlagsOff:nativeFlags.filter(flag=>flag.mode===mode&&flag.kind===kind).every(flag=>flag.enableReasoning===false&&flag.flagsEnableReasoning===false),nativeSSERechunked:true,structuredReasoningSent:true,actualToolRoundTrip:kind==='structured-tool-loop'?active.toolResultVerified:undefined,liveLeaked:leaked(live),doneLeaked:leaked(JSON.stringify(done.message)),snapshotLeaked:leaked(JSON.stringify(snapshot)),expectedAnswerRetained:done.message.text.includes(expected),naturalTextPreserved:natural?done.message.text===expected:undefined,partCount:events.filter(event=>event.type==='part').length,deltaCount:events.filter(event=>event.type==='delta').length});
  }
  const leaks=records.filter(record=>record.liveLeaked||record.doneLeaked||record.snapshotLeaked),lost=records.filter(record=>!record.expectedAnswerRetained||record.naturalTextPreserved===false),structured=records.filter(record=>record.kind==='structured-tool-loop');
  console.log(JSON.stringify({diagnosticComplete:true,success:leaks.length===0&&lost.length===0,regressionReproduced:leaks.length>0,cases:records,leakingCases:leaks.map(record=>({mode:record.mode,kind:record.kind,live:record.liveLeaked,done:record.doneLeaked,snapshot:record.snapshotLeaked})),contentLossCases:lost.map(record=>({mode:record.mode,kind:record.kind})),structuredToolLoopSafe:structured.every(record=>!record.liveLeaked&&!record.doneLeaked&&!record.snapshotLeaked&&record.actualToolRoundTrip),modelFixtureCalls:providerCalls.length,nativeRequests:nativeFlags.length,realProviderKeysUsed:0,productionChatsRead:false,paidCalls:0},null,2));
  if(process.argv.includes('--assert-clean')&&(leaks.length||lost.length))process.exitCode=1;
}catch(error){console.error(JSON.stringify({diagnosticComplete:false,error:fixtureError?.message||error.message,completedCases:records,paidCalls:0,productionChatsRead:false},null,2));process.exitCode=1;}
finally{const child=app?.runtime.child;if(app)await app.close();if(child&&child.exitCode===null)await new Promise(r=>{const timer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');r();},5000);child.once('exit',()=>{clearTimeout(timer);r();});});model.closeAllConnections();await new Promise(r=>model.close(r));rmSync(data,{recursive:true,force:true});}
