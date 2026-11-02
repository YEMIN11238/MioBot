// Explicit integration smoke: real pinned AstrBot, fake local model + embedding,
// isolated temporary state. No existing credentials or cloud services are used.
import {createServer} from 'node:http';
import {mkdtempSync,cpSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../../server/store.mjs';
import {AstrBot} from '../../server/astrbot.mjs';

const root=resolve(import.meta.dirname,'../..'),data=mkdtempSync(join(tmpdir(),'miobot-native-memory-')),testModel=process.env.MIOBOT_SMOKE_GPT6==='1'?'gpt-6-sol':'fixture-chat';
const calls=[];
const model=createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;const input=body?JSON.parse(body):{};calls.push({path:req.url,input});
  res.setHeader('Content-Type','application/json');
  if(req.url.endsWith('/models'))return res.end(JSON.stringify({data:[{id:'fixture-chat'},{id:'text-embedding-3-small'}]}));
  if(req.url.endsWith('/embeddings')){
    const texts=Array.isArray(input.input)?input.input:[input.input];
    return res.end(JSON.stringify({object:'list',data:texts.map((_,index)=>({object:'embedding',index,embedding:[1,...Array(1535).fill(0)]})),model:input.model,usage:{prompt_tokens:1,total_tokens:1}}));
  }
  if(req.url.endsWith('/chat/completions')){
    const messages=input.messages||[],last=[...messages].reverse().find(m=>m.role==='user'),text=typeof last?.content==='string'?last.content:JSON.stringify(last?.content),alreadyTool=messages.at(-1)?.role==='tool';
    const remember=text.includes('请记住')&&!alreadyTool&&input.tools?.some(t=>t.function?.name==='memorize_long_term_memory');
    const remembered=messages.some(m=>JSON.stringify(m.content).includes('蓝鲸喝可乐'));
    const content=alreadyTool?'记住了，测试暗号是蓝鲸喝可乐。':text.includes('暗号')?(remembered?'你的测试暗号是蓝鲸喝可乐。':'当前助手没有这条记忆。'):'本地测试模型回复。';
    if(input.stream){
      res.setHeader('Content-Type','text/event-stream');
      const delta=remember?{role:'assistant',tool_calls:[{index:0,id:'fixture-memory-call',type:'function',function:{name:'memorize_long_term_memory',arguments:JSON.stringify({memory:'用户的测试暗号是蓝鲸喝可乐',key_facts:['测试暗号是蓝鲸喝可乐'],topics:['测试'],importance:0.8})}}]}:{role:'assistant',content};
      res.write('data: '+JSON.stringify({id:'fixture-completion',object:'chat.completion.chunk',model:'fixture-chat',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
      res.write('data: '+JSON.stringify({id:'fixture-completion',object:'chat.completion.chunk',model:'fixture-chat',choices:[{index:0,delta:{},finish_reason:remember?'tool_calls':'stop'}]})+'\n\n');
      return res.end('data: [DONE]\n\n');
    }
    return res.end(JSON.stringify({id:'fixture-completion',object:'chat.completion',model:'fixture-chat',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  }
  res.statusCode=404;res.end('{}');
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const portPicker=createServer();await new Promise(r=>portPicker.listen(0,'127.0.0.1',r));const runtimePort=portPicker.address().port;await new Promise(r=>portPicker.close(r));
const store=new Store(data);store.state.settings={...store.state.settings,location:'local',runtimeUrl:`http://127.0.0.1:${runtimePort}`,defaultConnectionId:'fixture'};
store.state.modelConnections=[{id:'fixture',name:'Local fake',type:'openai_chat_completion',provider:'openai',template:'openai',apiBase:`http://127.0.0.1:${model.address().port}/v1`,model:testModel,config:{}}];
store.secrets.modelConnections.fixture={key:['local-fake-no-real-account']};
store.state.assistants=[{id:'companion',name:'陪伴助手',persona:'你是一个测试陪伴助手。',enabled:true,skills:['long_memory']},{id:'other',name:'另一个助手',persona:'你是独立助手。',enabled:true,skills:['long_memory']}];store.save();
mkdirSync(join(data,'astrbot/data'),{recursive:true});cpSync(join(root,'.data/astrbot/data/dist'),join(data,'astrbot/data/dist'),{recursive:true});
const runtime=new AstrBot({root,store});
try{
  await runtime.start();const capabilities=await runtime.setupCapabilities();assert.equal(capabilities.memory.status,'configured',JSON.stringify(capabilities));
  const write=store.createChat('companion');const written=await runtime.chat(write,'请记住我的测试暗号是蓝鲸喝可乐');assert.match(written,/蓝鲸喝可乐/);
  const all=await runtime.request('/plugins/extensions/astrbot_plugin_livingmemory/page/memories?page_size=100');
  const items=all.items||all.memories||[];assert.ok(items.length>0,'native memory DB must contain the original plugin tool write');
  const fresh=store.createChat('companion'),recalled=await runtime.chat(fresh,'我的测试暗号是什么？');assert.match(recalled,/蓝鲸喝可乐/);
  const other=store.createChat('other'),isolated=await runtime.chat(other,'我的测试暗号是什么？');assert.match(isolated,/没有这条记忆/);
  const managed=await runtime.listLongMemories('companion');assert.equal(managed.total,1);assert.equal((await runtime.listLongMemories('other')).total,0);
  await assert.rejects(()=>runtime.deleteLongMemory('other',managed.items[0].id),/不属于/);
  const originalSession=write.nativeSession;await runtime.chat(write,'只打个招呼，不调用任何工具。',{background:true});assert.equal(write.nativeSession,originalSession);
  const carePersona=(await runtime.request('/personas')).find(p=>p.persona_id.endsWith('-companion-care'));assert.deepEqual(carePersona.tools,[]);assert.deepEqual(carePersona.skills,[]);
  const careRequests=calls.filter(c=>c.path.endsWith('/chat/completions')&&c.input.messages?.some(m=>JSON.stringify(m.content).includes('只打个招呼，不调用任何工具')));
  assert.ok(careRequests.length>0);for(const call of careRequests)assert.deepEqual(call.input.tools||[],[],'care must have no native auto-injected tools either');
  await runtime.deleteLongMemory('companion',managed.items[0].id);assert.equal((await runtime.listLongMemories('companion')).total,0);
  const nativePersona=await runtime.request('/personas');assert.ok(nativePersona.some(p=>p.persona_id.endsWith('-companion')&&p.tools.includes('memorize_long_term_memory')));
  if(testModel==='gpt-6-sol'){const toolCalls=calls.filter(c=>c.path.endsWith('/chat/completions')&&c.input.tools?.length);assert.ok(toolCalls.length>0);for(const call of toolCalls)assert.equal(call.input.reasoning_effort,'none');assert.deepEqual(store.state.modelConnections[0].config,{},'effective compatibility mode must not rewrite the saved connection');}
  const result={success:true,engine:'AstrBot 4.29.3',plugin:'LivingMemory 2.8.2',model:'local fake only',protocolModel:testModel,memoryCount:items.length,writeToolConfirmed:true,newSessionRecall:true,differentAssistantIsolated:true,scopedListAndDelete:true,backgroundToolsDisabled:true,toolModeCompatibility:testModel==='gpt-6-sol'?'reasoning_effort:none':'not-needed',embeddingRequests:calls.filter(c=>c.path.endsWith('/embeddings')).length,chatRequests:calls.filter(c=>c.path.endsWith('/chat/completions')).length};
  console.log(JSON.stringify(result,null,2));
}catch(error){
  console.error(error.message);try{console.error(readFileSync(join(data,'logs/astrbot.log'),'utf8').replace(/Initial password: [^\n]+/g,'Initial password: [test credential hidden]').slice(-18000));}catch{}process.exitCode=1;
}finally{runtime.stop();await new Promise(r=>setTimeout(r,1000));await new Promise(r=>model.close(r));if(process.exitCode!==1)rmSync(data,{recursive:true,force:true});else console.error('Isolated diagnostic state: '+data);}
