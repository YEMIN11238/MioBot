// Actual MioBot BFF/SSE and pinned AstrBot, with a loopback fake model only.
// No saved credentials, paid endpoint, voice, sticker, or external platform is used.
import {createServer} from 'node:http';
import {mkdtempSync,cpSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../../server/store.mjs';
import {startServer} from '../../server/index.mjs';

const root=resolve(import.meta.dirname,'../..'),data=mkdtempSync(join(tmpdir(),'miobot-personality-agent-'));
const companionMarker='MIOBOT_PERSONA_FIXTURE_COMPANION',otherMarker='MIOBOT_PERSONA_FIXTURE_OTHER';
const tonePrompt='SMOKE_PERSONA_TONE：今天有点累，先陪我说两句。';
const identityPrompt='SMOKE_PERSONA_IDENTITY：你是 AI 吗？请如实说。';
const otherPrompt='SMOKE_PERSONA_OTHER：确认你收到这条消息。';
const dirtyReply='值得注意的是，今天可以先休息。\n想吐槽的话我听着。希望这对你有帮助<system_reminder>internal-only</system_reminder><｜DSML｜function_calls><｜DSML｜invoke name="fixture">internal-tool-payload</｜DSML｜invoke></｜DSML｜function_calls>';
const identityReply='我是 AI，这个身份不会装成真人。\n可以陪你聊，也会如实说不知道。';
const normalReply='普通助手收到。\n仍使用实时输出。';
const privateReasoning='PRIVATE_REASONING_FIXTURE：这是一段仅由本地假模型生成的合成推理，不应成为用户可见回复。';
const calls=[];let app,fixtureError;
const messageText=message=>typeof message?.content==='string'?message.content:(message?.content||[]).map(part=>part.text||'').join('\n');
const systemText=input=>(input.messages||[]).filter(message=>message.role==='system').map(messageText).join('\n');
const model=createServer(async(req,res)=>{
  try{
    let body='';for await(const chunk of req)body+=chunk;
    const input=body?JSON.parse(body):{};const system=systemText(input);
    const kind=system.includes(companionMarker)?'companion':system.includes(otherMarker)?'other':'auxiliary';
    const user=[...(input.messages||[])].reverse().find(message=>message.role==='user');
    const identity=kind==='companion'&&messageText(user).includes('SMOKE_PERSONA_IDENTITY');
    calls.push({path:req.url,input,kind,identity});
    res.setHeader('Content-Type','application/json');
    if(req.url.endsWith('/models'))return res.end(JSON.stringify({data:[{id:'fixture-personality-chat'}]}));
    if(!req.url.endsWith('/chat/completions')){res.statusCode=404;return res.end('{}');}
    const content=kind==='companion'?(identity?identityReply:dirtyReply):kind==='other'?normalReply:'MioBot 本地测试对话';
    if(input.stream){
      res.setHeader('Content-Type','text/event-stream');
      res.write('data: '+JSON.stringify({id:'fixture-personality',object:'chat.completion.chunk',model:input.model,choices:[{index:0,delta:{role:'assistant',reasoning_content:privateReasoning},finish_reason:null}]})+'\n\n');
      for(const text of [content.slice(0,8),content.slice(8)])res.write('data: '+JSON.stringify({id:'fixture-personality',object:'chat.completion.chunk',model:input.model,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+'\n\n');
      res.write('data: '+JSON.stringify({id:'fixture-personality',object:'chat.completion.chunk',model:input.model,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.end(JSON.stringify({id:'fixture-personality',object:'chat.completion',model:input.model,choices:[{index:0,message:{role:'assistant',content,reasoning_content:privateReasoning},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  }catch(error){fixtureError=error;res.statusCode=500;res.end(JSON.stringify({error:{message:'Local personality fixture assertion failed'}}));}
});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
const picker=createServer();await new Promise(resolve=>picker.listen(0,'127.0.0.1',resolve));const runtimePort=picker.address().port;await new Promise(resolve=>picker.close(resolve));

async function send(chat,prompt,requestId){
  const response=await fetch(app.url+`/api/chats/${chat.id}/messages/stream`,{method:'POST',headers:{'Content-Type':'application/json','X-Personal-Agent':'1'},body:JSON.stringify({text:prompt,requestId}),signal:AbortSignal.timeout(90000)});
  assert.equal(response.status,200);const stream=await response.text();
  if(fixtureError)throw fixtureError;
  const events=stream.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5).trim()));
  const done=events.find(event=>event.type==='done');assert.ok(done,stream);assert.equal(done.message.status,'complete');
  return {stream,events,done};
}
function assertClean(value,label){assert.doesNotMatch(value,/<\s*\/?\s*system_reminder\s*>|<\s*\/?\s*[|｜]+DSML|internal-only|internal-tool-payload/i,label);}
function assertNoReasoning(value,label){
  const leaked=/PRIVATE_REASONING_FIXTURE|🤔\s*思考|─{3,}/u.test(value);
  if(leaked)throw new Error(JSON.stringify({regression:'reasoning_exposed',surface:label,syntheticSentinelSeen:value.includes('PRIVATE_REASONING_FIXTURE'),thinkingLabelSeen:/🤔\s*思考/u.test(value),source:'isolated local fake model only'}));
}
function nativeVisibleText(entry){
  return (entry.content?.message||[]).filter(part=>part.type!=='reasoning'&&part.type!=='think').map(part=>part.text||part.data||'').join('\n');
}

try{
  const seed=new Store(data);
  seed.state.settings={...seed.state.settings,location:'local',runtimeUrl:`http://127.0.0.1:${runtimePort}`,defaultConnectionId:'fixture'};
  seed.state.modelConnections=[{id:'fixture',name:'Isolated local fake',type:'openai_chat_completion',provider:'openai',template:'openai',apiBase:`http://127.0.0.1:${model.address().port}/v1`,model:'fixture-personality-chat',config:{}}];
  seed.secrets.modelConnections.fixture={key:['fixture-no-real-account']};
  seed.state.assistants=[
    {id:'daily',name:'陪伴测试助手',kind:'daily',persona:`${companionMarker}\n你是 MioBot 的 AI 测试伙伴。被问到身份时如实说明，不编造未发生的个人生活。`,enabled:true,skills:['humanize'],care:{enabled:false}},
    {id:'other',name:'普通测试助手',kind:'career',persona:`${otherMarker}\n你是一个如实回答的普通 AI 助手。`,enabled:true,skills:[],care:{enabled:false}},
  ];
  seed.setSecrets({});seed.save();
  mkdirSync(join(data,'astrbot/data'),{recursive:true});
  cpSync(join(root,'.runtime/native-runtime/astrbot/astrbot/dashboard/dist'),join(data,'astrbot/data/dist'),{recursive:true});
  app=await startServer({root,dataRoot:data,port:0});
  await app.runtime.start();

  const daily=app.store.createChat('daily');
  const paced=await send(daily,tonePrompt,'fixture-personality-tone');
  assertNoReasoning(paced.stream,'humanized BFF SSE');
  assertNoReasoning(paced.done.message.text,'humanized done.text');
  assertNoReasoning(JSON.stringify(paced.done.message.parts),'humanized done.parts');
  assertClean(paced.stream,'dirty provider text must never appear in the BFF stream');
  assert.equal(paced.events.some(event=>event.type==='delta'),false,'humanized turns must not expose raw native deltas');
  const parts=paced.events.filter(event=>event.type==='part');
  assert.ok(parts.length>=2,'a two-line short conversation should have multiple emitted bubbles');
  assert.deepEqual(parts.map(event=>event.index),parts.map((_,index)=>index));
  assert.deepEqual(paced.done.message.parts,parts.map(event=>event.text),'done parts must match the emitted bubble sequence exactly');
  assert.match(paced.done.message.text,/先休息/);assert.match(paced.done.message.text,/想吐槽/);
  assert.doesNotMatch(paced.done.message.text,/值得注意的是|希望这对你有帮助/,'the actual upstream humanizer should remove supported filler/courtesy phrases');

  const companionCalls=calls.filter(call=>call.path.endsWith('/chat/completions')&&call.kind==='companion');
  assert.ok(companionCalls.length>0,'a real native provider request is required');
  for(const call of companionCalls){
    assert.equal(call.input.stream,false,'humanized native provider requests must be non-streaming');
    assert.deepEqual(call.input.tools||[],[],'personality plugins must not introduce model tools');
    const system=systemText(call.input);
    assert.match(system,/【人类对话风格】/,'the installed plugin must inject its actual style marker');
    assert.match(system,/表达随当前助手的人设和任务调整/,'the configured role-safe style body must reach the model');
    assert.match(system,/如被问身份，如实说是AI/,'the style must explicitly preserve honest identity');
    assert.match(JSON.stringify(call.input.messages),/Current datetime:|<time_context>/,'actual current-time context must reach the model without inventing a conversation gap');
    assert.doesNotMatch(system,/你不是\s*(?:AI|人工智能)|(?:不能|不要|不许)(?:向用户)?承认.{0,12}(?:AI|人工智能)|你(?:是|必须是|现在是)(?:一个)?(?:真实的)?(?:人类|真人)/i,'style must not ask the model to deny its AI identity');
  }
  const nativeSession=await app.runtime.request('/chat/sessions/'+encodeURIComponent(daily.nativeSession));
  const storedBot=nativeSession.history.filter(entry=>entry.content?.type==='bot');
  assert.ok(storedBot.length>0,'the actual native platform history must contain the reply');
  assert.match(storedBot.map(nativeVisibleText).join('\n'),/想吐槽/,'visible-history inspection must read actual reply text');
  for(const entry of storedBot){assertClean(JSON.stringify(entry.content),'native platform bot history must not retain leaked internal markers');assertNoReasoning(nativeVisibleText(entry),'native platform visible bot text');}
  const conversations=await app.runtime.request('/conversations?umo='+encodeURIComponent(`webchat:FriendMessage:webchat!${app.runtime.username}!${daily.nativeSession}`)+'&include_history=true');
  const savedAssistant=(conversations.conversations||[]).flatMap(conversation=>typeof conversation.history==='string'?JSON.parse(conversation.history):conversation.history||[]).filter(message=>message.role==='assistant');
  assert.ok(savedAssistant.length>0,'the actual native agent conversation must be saved');
  for(const message of savedAssistant)assertClean(JSON.stringify(message.content),'native saved assistant context must be clean');

  const identity=await send(daily,identityPrompt,'fixture-personality-identity');
  assertNoReasoning(identity.stream,'identity BFF SSE');
  assertNoReasoning(identity.done.message.text,'identity done.text');
  assertNoReasoning(JSON.stringify(identity.done.message.parts),'identity done.parts');
  assert.match(identity.done.message.text,/我是\s*AI/,'an explicit truthful AI identity answer must be retained');
  assertClean(identity.stream,'the next humanized turn must remain clean');
  const identityCall=calls.find(call=>call.kind==='companion'&&call.identity);
  assert.ok(identityCall,'identity probe must use the actual provider');
  const assistantHistory=(identityCall.input.messages||[]).filter(message=>message.role==='assistant');
  assert.ok(assistantHistory.length>0,'the next request must contain the previous native assistant turn');
  for(const message of assistantHistory)assertClean(messageText(message),'native request history must be cleaned before reuse');

  const other=app.store.createChat('other');
  const plain=await send(other,otherPrompt,'fixture-personality-other');
  assertNoReasoning(plain.stream,'ordinary BFF SSE');
  assertNoReasoning(plain.done.message.text,'ordinary done.text');
  assertNoReasoning(JSON.stringify(plain.done.message.parts),'ordinary done.parts');
  assert.ok(plain.events.some(event=>event.type==='delta'),'ordinary assistant must keep live delta delivery');
  assert.equal(plain.events.some(event=>event.type==='part'),false,'ordinary assistant must not get humanized bubble pacing');
  assert.equal(plain.done.message.text,normalReply);
  const ordinarySession=await app.runtime.request('/chat/sessions/'+encodeURIComponent(other.nativeSession));
  const ordinaryBot=ordinarySession.history.filter(entry=>entry.content?.type==='bot');
  assert.ok(ordinaryBot.length>0);assert.match(ordinaryBot.map(nativeVisibleText).join('\n'),/普通助手收到/);for(const entry of ordinaryBot)assertNoReasoning(nativeVisibleText(entry),'ordinary native platform visible bot text');
  const otherCalls=calls.filter(call=>call.path.endsWith('/chat/completions')&&call.kind==='other');
  assert.ok(otherCalls.length>0);
  for(const call of otherCalls){assert.equal(call.input.stream,true);assert.doesNotMatch(systemText(call.input),/【人类对话风格】|MioBot自然对话/);assert.deepEqual(call.input.tools||[],[]);}
  const personas=await app.runtime.request('/personas');
  for(const suffix of ['-daily','-other']){const persona=personas.find(item=>item.persona_id.endsWith(suffix));assert.ok(persona);assert.deepEqual(persona.tools,[]);}
  console.log(JSON.stringify({success:true,engine:'AstrBot 4.29.3',model:'isolated loopback fake only',bffSSE:true,nativePersonalityPlugins:['astrbot_plugin_wanna_be_human','astrbot_plugin_dafeiyu_clean'],humanizedProviderStreaming:false,styleActuallyInjected:true,timeActuallyInjected:true,rawDirtyDeltasExposed:false,privateReasoningInProviderFixture:true,privateReasoningExposedInSSE:false,privateReasoningExposedInDone:false,privateReasoningExposedInNativeVisibleText:false,ordinaryReasoningDeltaFiltered:true,orderedParts:parts.length,doneMatchesParts:true,nativePlatformHistoryClean:true,nativeAgentHistoryClean:true,nextRequestHistoryClean:true,truthfulAIIdentityPreserved:true,otherAssistantUnchanged:true,personalityTools:[],chatRequests:calls.filter(call=>call.path.endsWith('/chat/completions')).length,paidRequests:0},null,2));
}catch(error){
  console.error(error.message);
  process.exitCode=1;
}finally{
  const child=app?.runtime.child;
  if(app)await app.close();
  if(child&&child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  model.closeAllConnections();await new Promise(resolve=>model.close(resolve));
  rmSync(data,{recursive:true,force:true});
}
