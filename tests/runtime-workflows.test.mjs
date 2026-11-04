import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {AstrBot} from '../server/astrbot.mjs';
import {assistantNativeCapabilities,patchManagedRuntime,stageBundledCapabilities,WORKFLOW_PLUGIN,RESEARCH_PLUGIN} from '../server/assistant-runtime.mjs';
import {nativeFixture} from './helpers/native-fixture.mjs';

function fixture(){
  const native=nativeFixture(),assistant={id:'daily',kind:'daily',enabled:true,persona:'保留用户原来的熟人语气。',skills:['memory','reminders','workflows','web','files','humanize','long_memory','voice','stickers']};
  const connection={id:'fixture',type:'openai_chat_completion',provider:'openai',model:'fixture-model',apiBase:'http://127.0.0.1:2/v1',config:{}};
  const store={state:{instanceId:'workflow-fixture',assistants:[assistant],settings:{runtimeUrl:'http://127.0.0.1:1',defaultConnectionId:connection.id},modelConnections:[connection],extensions:{memory:true,reminders:true,workflows:true,web:true,files:true,voice:true,stickers:true},capabilities:{memory:{status:'ready',embeddingProviderId:'fixture-embedding'}},tasks:[],memories:[{id:'private',assistantId:'daily',content:'喜欢蓝色小屋',updatedAt:'2026-11-01T00:00:00Z'},{id:'other',assistantId:'other',content:'另一位助手的私密资料'}]},secrets:{modelConnections:{fixture:{key:['synthetic-not-a-real-key']}}},save(){},assistant:id=>{assert.equal(id,assistant.id);return assistant;},connection:id=>{assert.equal(id,connection.id);return connection;},selectedConnection:()=>connection};
  const runtime=new AstrBot({root:'/tmp/unused',store,fetcher:native.fetcher});return {native,assistant,connection,store,runtime};
}

test('scheduled capabilities can only expose the explicitly permitted read-only research tools',()=>{
  const assistant={skills:['long_memory','memory','reminders','workflows','minecraft','humanize','voice','stickers','web','files']};
  const unsafe=['miobot_search_web','miobot_read_file','memorize_long_term_memory','miobot_schedule_workflow','send_message_to_user','astrbot_execute_shell'];
  assert.deepEqual(assistantNativeCapabilities(assistant,{purpose:'workflow',allowedTools:unsafe}),{plugins:[RESEARCH_PLUGIN],tools:['miobot_search_web','miobot_read_file'],skills:[]});
  assert.deepEqual(assistantNativeCapabilities(assistant,{purpose:'workflow',allowedTools:[]}),{plugins:[],tools:[],skills:[]});
  assert.deepEqual(assistantNativeCapabilities(assistant,{purpose:'workflow'}),{plugins:[],tools:[],skills:[]});
  assert.deepEqual(assistantNativeCapabilities({skills:['workflows']}),{plugins:[WORKFLOW_PLUGIN],tools:['miobot_schedule_workflow','miobot_list_workflows','miobot_cancel_workflow'],skills:[]});
});

test('workflow profiles preserve user personality while isolating chat, RSS, tools and automatic memory hooks',async()=>{
  const {runtime,native,assistant,store}=fixture(),original=structuredClone(assistant);
  const ordinary=await runtime.sync(assistant);
  const ordinaryPersona=structuredClone(native.personas.get('pa-workflow-fixture-daily'));
  const readonly=await runtime.sync(assistant,undefined,{purpose:'workflow',allowedTools:['miobot_search_web','miobot_read_file'],query:'小屋'});
  const rss=await runtime.sync(assistant,undefined,{purpose:'workflow',allowedTools:[],query:'小屋'});
  assert.equal(new Set([ordinary,readonly,rss]).size,3);
  const config=native.profiles.get(readonly).config,persona=native.personas.get(config.agent_runner.config.persona.persona_id);
  assert.match(persona.persona_id,/-workflow-/);assert.ok(persona.system_prompt.startsWith(assistant.persona));assert.ok(persona.system_prompt.includes('喜欢蓝色小屋'));assert.ok(!persona.system_prompt.includes('另一位助手的私密资料'));
  assert.deepEqual(config.plugin_set,[RESEARCH_PLUGIN]);assert.deepEqual(persona.tools,['miobot_search_web','miobot_read_file']);assert.deepEqual(persona.skills,[]);
  assert.equal(config.agent_runner.config.misc.max_steps,12);assert.equal(config.provider_settings.proactive_capability.add_cron_tools,false);assert.equal(config.provider_settings.computer_use_runtime,'none');assert.equal(config.subagent_orchestrator.main_enable,false);
  const rssConfig=native.profiles.get(rss).config,rssPersona=native.personas.get(rssConfig.agent_runner.config.persona.persona_id);
  assert.deepEqual(rssConfig.plugin_set,[]);assert.deepEqual(rssPersona.tools,[]);assert.ok(!rssPersona.system_prompt.includes('喜欢蓝色小屋'));
  assert.deepEqual(native.personas.get('pa-workflow-fixture-daily'),ordinaryPersona);assert.deepEqual(assistant,original);assert.equal(store.state.memories.length,2);
});

test('workflow chat keeps its real session on the host chat and never reuses ordinary or differently scoped sessions',async()=>{
  const {runtime,native,store}=fixture(),chat={id:'scheduled-chat',assistantId:'daily',nativeSession:'ordinary-session'};
  await runtime.chat(chat,'查小屋资料',{purpose:'workflow',allowedTools:['miobot_search_web']});
  const first=chat.nativeSession;assert.notEqual(first,'ordinary-session');assert.equal(chat.nativePurpose,'workflow');
  const request=native.calls.findLast(call=>call.path==='/chat');assert.equal(request.body.session_id,first);assert.ok(native.routes.has(`webchat:FriendMessage:webchat!personal-agent!${first}`));
  await runtime.chat(chat,'只总结这些订阅条目',{purpose:'workflow',allowedTools:[]});assert.notEqual(chat.nativeSession,first);const rssSession=chat.nativeSession;
  await runtime.chat(chat,'普通聊天');assert.notEqual(chat.nativeSession,rssSession);assert.equal(chat.nativePurpose,'chat');assert.equal(store.state.memories.length,2);
  await assert.rejects(()=>runtime.chat(chat,'bad',{purpose:'unknown'}),/无效/);
});

test('native scheduler sync uses the authenticated plugin endpoint and propagates failure',async()=>{
  const {runtime}=fixture(),body={namespace:'fixture',jobs:[]};let authenticated=false;
  runtime.authenticate=async()=>{authenticated=true;};runtime.request=async(path,options)=>{assert.ok(authenticated);assert.equal(path,'/plugins/extensions/astrbot_plugin_miobot_workflows/sync');assert.equal(options.method,'POST');assert.equal(options.body,body);return {ready:true,jobs:[]};};
  assert.deepEqual(await runtime.syncWorkflows(body),{ready:true,jobs:[]});runtime.request=async()=>{throw Error('offline');};await assert.rejects(()=>runtime.syncWorkflows(body),/offline/);
});

test('managed workflow patch upgrades an old outbound-only patch, is atomic and enforces the final allowlist',()=>{
  const directory=mkdtempSync(join(tmpdir(),'miobot-workflow-patch-')),file=join(directory,'astrbot/core/astr_main_agent.py');
  const outbound='    if (\n        event.platform_meta.support_proactive_message\n        and os.environ.get("MIOBOT_DISABLE_NATIVE_OUTBOUND_TOOLS") != "1"\n    ):\n        pass\n';
  try{
    mkdirSync(join(directory,'astrbot/core'),{recursive:true});writeFileSync(file,outbound+'    fallback_providers = _get_fallback_chat_providers(\n');
    assert.throws(()=>patchManagedRuntime(directory,{allowWrite:false}),/权限补丁/);assert.equal(readFileSync(file,'utf8'),outbound+'    fallback_providers = _get_fallback_chat_providers(\n');
    patchManagedRuntime(directory);const patched=readFileSync(file,'utf8');assert.match(patched,/allowed_workflow_tools/);patchManagedRuntime(directory,{allowWrite:false});assert.equal(readFileSync(file,'utf8'),patched);
    const snippet=patched.slice(patched.indexOf('    # MioBot managed workflow:'),patched.indexOf('    fallback_providers = ')).split('\n').map(line=>line.slice(4)).join('\n');
    const program=`import os\nfrom types import SimpleNamespace\nclass ToolSet(list):\n def add_tool(self,t): self.append(t)\nclass Event:\n def get_extra(self,k): return self.persona\nclass Manager:\n def get_persona_v3_by_id(self,p): return {'tools':['miobot_search_web','send_message_to_user','astrbot_execute_shell']}\nevent=Event()\nplugin_context=SimpleNamespace(persona_manager=Manager())\nos.environ['MIOBOT_MANAGED_WORKFLOWS']='1'\nfor persona,expected in [('pa-test-workflow-123',['miobot_search_web']),('pa-test-normal',['miobot_search_web','send_message_to_user','astrbot_execute_shell','transfer_to_other'])]:\n event.persona=persona\n req=SimpleNamespace(func_tool=ToolSet(SimpleNamespace(name=n) for n in ['miobot_search_web','send_message_to_user','astrbot_execute_shell','transfer_to_other']))\n exec(${JSON.stringify(snippet)})\n assert [t.name for t in req.func_tool]==expected\n`;
    const python=spawnSync('python3',['-c',program],{encoding:'utf8'});assert.equal(python.status,0,python.stderr);
    writeFileSync(file,outbound+'unknown changed core');assert.throws(()=>patchManagedRuntime(directory),/版本/);assert.equal(readFileSync(file,'utf8'),outbound+'unknown changed core');
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('workflows plugin is staged for every managed instance and parser pins ship in clean installs',()=>{
  const directory=mkdtempSync(join(tmpdir(),'miobot-workflow-stage-')),root=resolve(import.meta.dirname,'..');
  try{const result=stageBundledCapabilities({root,runtimeRoot:directory,instanceId:'fixture'});assert.equal(result.find(item=>item.id===WORKFLOW_PLUGIN)?.status,'staged');assert.match(readFileSync(join(directory,'data/plugins',WORKFLOW_PLUGIN,'main.py'),'utf8'),/cron_manager/);
    for(const path of ['deploy/Dockerfile','安装引擎.command'])assert.match(readFileSync(join(root,path),'utf8'),/--no-deps[^\n]*feedparser==6\.0\.14 feedparser-sgmllib==2\.1\.0/);
    assert.match(readFileSync(join(root,'server/astrbot.mjs'),'utf8'),/MIOBOT_MANAGED_WORKFLOWS:'1'/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
