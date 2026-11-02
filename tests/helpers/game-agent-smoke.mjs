// Real pinned AstrBot and MioBot BFF, with an isolated local fake model only.
// No game, account, saved credentials or paid model endpoint is accessed.
import {createServer} from 'node:http';
import {mkdtempSync,cpSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../../server/store.mjs';
import {startServer} from '../../server/index.mjs';

const root=resolve(import.meta.dirname,'../..'),data=mkdtempSync(join(tmpdir(),'miobot-game-agent-'));
const calls=[];let fixtureError,app,guideBodyRead=false;
const model=createServer(async(req,res)=>{
  try{
    let body='';for await(const part of req)body+=part;
    const input=body?JSON.parse(body):{};calls.push({path:req.url,input});
    res.setHeader('Content-Type','application/json');
    if(req.url.endsWith('/models'))return res.end(JSON.stringify({data:[{id:'fixture-game-chat'}]}));
    if(!req.url.endsWith('/chat/completions')){res.statusCode=404;return res.end('{}');}
    const toolResult=[...(input.messages||[])].reverse().find(message=>message.role==='tool');
    let toolCall,content;
    if(!toolResult&&input.tools?.some(tool=>tool.function?.name==='miobot_mc_recipe')){
      assert.ok(!input.tools?.some(tool=>tool.function?.name==='memorize_long_term_memory'),'unselected memory tool must not be offered');
      assert.ok(input.tools.some(tool=>tool.function?.name==='miobot_mc_guide'),'the native guide-reading tool must be offered');
      toolCall={id:'fixture-guide-call',type:'function',function:{name:'miobot_mc_guide',arguments:'{}'}};
    }else if(toolResult){
      const raw=typeof toolResult.content==='string'?toolResult.content:toolResult.content.map(part=>part.text||'').join('');
      const result=JSON.parse(raw);
      assert.equal(result.ok,true,raw);
      if(result.skill==='minecraft-guide'){
        assert.equal(result.source.kind,'native_skill_file');assert.match(result.content,/没有连接游戏/);assert.match(result.content,/miobot_mc_recipe/);
        assert.equal(result.source.sha256,createHash('sha256').update(readFileSync(join(root,'integrations/skills/minecraft-guide/SKILL.md'))).digest('hex'));
        guideBodyRead=true;
        toolCall={id:'fixture-minecraft-call',type:'function',function:{name:'miobot_mc_recipe',arguments:JSON.stringify({query:'箱子',quantity:3})}};
      }else{
        assert.equal(result.version,'1.21.8');
        const recipe=result.recipes[0];assert.equal(recipe.ingredients[0].name,'oak_planks');assert.equal(recipe.ingredients[0].totalCount,24);assert.equal(recipe.requiresTable,true);
        content=`三个箱子需要 ${recipe.ingredients[0].totalCount} 块橡木板，在工作台摆成中间留空的一圈。资料版本：Minecraft Java ${result.version}，来源 PrismarineJS。`;
      }
    }else content='Minecraft 配方查询'; // Native title-generation calls do not receive agent tools.
    if(input.stream){
      res.setHeader('Content-Type','text/event-stream');
      const delta=toolCall?{role:'assistant',tool_calls:[{index:0,...toolCall}]}:{role:'assistant',content};
      res.write('data: '+JSON.stringify({id:'fixture-completion',object:'chat.completion.chunk',model:'fixture-game-chat',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
      res.write('data: '+JSON.stringify({id:'fixture-completion',object:'chat.completion.chunk',model:'fixture-game-chat',choices:[{index:0,delta:{},finish_reason:toolCall?'tool_calls':'stop'}]})+'\n\n');
      return res.end('data: [DONE]\n\n');
    }
    return res.end(JSON.stringify({id:'fixture-completion',object:'chat.completion',model:'fixture-game-chat',choices:[{index:0,message:{role:'assistant',content:content||null,...(toolCall?{tool_calls:[toolCall]}:{})},finish_reason:toolCall?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  }catch(error){fixtureError=error;res.statusCode=500;res.end(JSON.stringify({error:{message:'Local game fixture assertion failed'}}));}
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const picker=createServer();await new Promise(r=>picker.listen(0,'127.0.0.1',r));const runtimePort=picker.address().port;await new Promise(r=>picker.close(r));

try{
  const seed=new Store(data);
  seed.state.settings={...seed.state.settings,location:'local',runtimeUrl:`http://127.0.0.1:${runtimePort}`,defaultConnectionId:'fixture'};
  seed.state.modelConnections=[{id:'fixture',name:'Local fake',type:'openai_chat_completion',provider:'openai',template:'openai',apiBase:`http://127.0.0.1:${model.address().port}/v1`,model:'fixture-game-chat',config:{}}];
  seed.secrets.modelConnections.fixture={key:['fixture-no-real-account']};
  seed.state.assistants=[{id:'game',name:'Minecraft 游戏助手',kind:'game',persona:'你是 Minecraft 新手游戏助手。查询配方时调用已提供的真实工具。不能假装读取背包或执行游戏。',enabled:true,skills:['minecraft'],care:{enabled:false}}];
  seed.setSecrets({});seed.save();
  mkdirSync(join(data,'astrbot/data'),{recursive:true});
  cpSync(join(root,'.runtime/native-runtime/astrbot/astrbot/dashboard/dist'),join(data,'astrbot/data/dist'),{recursive:true});
  app=await startServer({root,dataRoot:data,port:0});
  await app.runtime.start();
  const nativeSkills=await app.runtime.request('/skills');
  assert.match(JSON.stringify(nativeSkills),/minecraft-guide/,'the Skill must be registered by the actual native runtime');
  const chat=app.store.createChat('game');
  const response=await fetch(app.url+`/api/chats/${chat.id}/messages/stream`,{method:'POST',headers:{'Content-Type':'application/json','X-Personal-Agent':'1'},body:JSON.stringify({text:'做三个箱子需要多少材料，要用工作台吗？',requestId:'fixture-game-request'}),signal:AbortSignal.timeout(90000)});
  assert.equal(response.status,200);const stream=await response.text();
  if(fixtureError)throw fixtureError;
  const events=stream.split('\n').filter(line=>line.startsWith('data:')).map(line=>JSON.parse(line.slice(5).trim()));
  const done=events.find(event=>event.type==='done');assert.ok(done,stream);
  assert.equal(done.message.status,'complete');assert.match(done.message.text,/24 块橡木板/);
  const trace=done.message.toolCalls?.find(call=>call.name==='recipe_lookup');assert.ok(trace,'BFF final assistant message must retain actual tool execution evidence');
  assert.equal(trace.ok,true);assert.equal(trace.version,'1.21.8');assert.equal(trace.args.quantity,3);assert.match(trace.source.url,/PrismarineJS/);
  const persona=(await app.runtime.request('/personas')).find(p=>p.persona_id.endsWith('-game'));
  assert.deepEqual(persona.tools,['miobot_mc_item','miobot_mc_recipe','miobot_mc_guide']);assert.deepEqual(persona.skills,['minecraft-guide']);assert.equal(guideBodyRead,true);
  const chatCalls=calls.filter(call=>call.path.endsWith('/chat/completions'));
  assert.ok(chatCalls.length>=2,'agent must call the fake model again with the actual tool result');
  const skillPromptPresent=chatCalls.some(call=>(call.input.messages||[]).some(message=>message.role==='system'&&JSON.stringify(message.content).includes('minecraft-guide')));
  const offeredTools=[...new Set(chatCalls.flatMap(call=>(call.input.tools||[]).map(tool=>tool.function?.name)))];
  assert.deepEqual([...offeredTools].sort(),['miobot_mc_guide','miobot_mc_item','miobot_mc_recipe'],'managed runtime must offer exactly the three game tools');
  console.log(JSON.stringify({success:true,engine:'AstrBot 4.29.3',model:'isolated local fake',bffStreaming:true,actualNativeToolCall:true,material:'oak_planks',materialCount:24,version:trace.version,toolTraceRetained:true,nativeSkillRegistered:true,nativeSkillInSystemPrompt:skillPromptPresent,nativeSkillBodyRead:guideBodyRead,guideReadMethod:'parameter-free tool reading only the registered minecraft-guide/SKILL.md',onlySelectedToolsOffered:true,nativeOutboundToolsAbsent:true,offeredTools,chatRequests:chatCalls.length,paidRequests:0,gameConnected:false},null,2));
}catch(error){
  console.error(error.message);try{console.error(readFileSync(join(data,'logs/astrbot.log'),'utf8').replace(/Initial password:.*$/gm,'Initial password: [fixture redacted]').slice(-10000));}catch{}process.exitCode=1;
}finally{
  const child=app?.runtime.child;
  if(app)await app.close();
  if(child&&child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});
  model.closeAllConnections();await new Promise(r=>model.close(r));
  rmSync(data,{recursive:true,force:true});
}
