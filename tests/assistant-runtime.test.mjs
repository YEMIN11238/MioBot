import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {assistantNativeCapabilities,assertModelToolCompatibility,toolModelOverrides,stageBundledCapabilities,livingMemoryConfig,patchManagedRuntime,HUMAN_PLUGIN,CLEAN_PLUGIN,MEMORY_PLUGIN,TASK_PLUGIN} from '../server/assistant-runtime.mjs';
import {AstrBot} from '../server/astrbot.mjs';

test('each assistant gets only explicitly enabled native plugins, tools and Skills',()=>{
  assert.deepEqual(assistantNativeCapabilities({skills:['memory','reminders']}),{plugins:[TASK_PLUGIN],tools:['miobot_schedule_reminder','miobot_list_reminders','miobot_cancel_reminder'],skills:[]});
  assert.deepEqual(assistantNativeCapabilities({skills:['memory','reminders','humanize']}),{plugins:[TASK_PLUGIN,HUMAN_PLUGIN,CLEAN_PLUGIN],tools:['miobot_schedule_reminder','miobot_list_reminders','miobot_cancel_reminder'],skills:[]});
  const companion=assistantNativeCapabilities({skills:['long_memory','humanize']});
  assert.deepEqual(companion.plugins,[MEMORY_PLUGIN,HUMAN_PLUGIN,CLEAN_PLUGIN]);assert.ok(companion.tools.includes('memorize_long_term_memory'));assert.ok(!companion.tools.includes('miobot_mc_item'));
  const game=assistantNativeCapabilities({skills:['minecraft']});
  assert.deepEqual(game.skills,['minecraft-guide']);assert.deepEqual(game.tools,['miobot_mc_item','miobot_mc_recipe','miobot_mc_guide']);assert.ok(!game.plugins.includes(MEMORY_PLUGIN));
  const config=livingMemoryConfig('fixture');
  assert.equal(config.filtering_settings.memory_scope_mode,'user');assert.equal(config.filtering_settings.use_persona_filtering,true);assert.equal(config.session_manager.enable_full_group_capture,false);
});

test('GPT-6 Sol Chat Completions tool mode requires an explicit supported reasoning setting and does not rewrite the connection',()=>{
  const connection={type:'openai_chat_completion',model:'gpt-6-sol',config:{custom_extra_body:{reasoning_effort:'medium'}}},before=structuredClone(connection);
  assert.throws(()=>assertModelToolCompatibility(connection,['miobot_mc_item']),/reasoning_effort/);assert.deepEqual(connection,before);
  assert.doesNotThrow(()=>assertModelToolCompatibility(connection,[]));assert.doesNotThrow(()=>assertModelToolCompatibility(connection,['miobot_mc_item'],{custom_extra_body:{reasoning_effort:'none'}}));
  assert.deepEqual(toolModelOverrides(connection,{},true),{custom_extra_body:{reasoning_effort:'none'}});assert.deepEqual(toolModelOverrides(connection,{},false),{});
  assert.doesNotThrow(()=>assertModelToolCompatibility({...connection,model:'deepseek-v4-flash'},['miobot_mc_item']));
});

test('humanized profiles refuse to claim working plugins when one required plugin is disabled',async()=>{
  const runtime=new AstrBot({root:'/tmp/unused',store:{state:{capabilities:{}},save(){}}});runtime.authenticate=async()=>{};
  runtime.request=async path=>{assert.equal(path,'/plugins');return [{name:HUMAN_PLUGIN,activated:true,version:'4.1.9'},{name:CLEAN_PLUGIN,activated:false,version:'fixture'}];};
  const health=await runtime.personalityHealth();assert.equal(health.status,'error');assert.match(health.error,/拟人聊天插件/);
  await assert.rejects(()=>runtime.sync({skills:['humanize']},{type:'openai_chat_completion',model:'fixture',config:{}}),/拟人聊天插件/);
});

test('bundled plugin staging retains license and does not overwrite user config or unowned plugins',()=>{
  const runtimeRoot=mkdtempSync(join(tmpdir(),'miobot-stage-'));
  try{
    const options={root:resolve(import.meta.dirname,'..'),runtimeRoot,instanceId:'fixture'};
    const staged=stageBundledCapabilities(options);assert.equal(staged[0].status,'staged');
    assert.ok(existsSync(join(runtimeRoot,'data/plugins',MEMORY_PLUGIN,'LICENSE')));
    const personality=JSON.parse(readFileSync(join(runtimeRoot,'data/config',HUMAN_PLUGIN+'_config.json'),'utf8'));
    assert.equal(personality.proactive.enable_proactive,false);assert.equal(personality.time.enable_life,false);
    assert.equal(personality.style.auto_build_default,false);assert.equal(personality.style.create_kb,false);assert.equal(personality.style.enable_retrieval,false);
    const file=join(runtimeRoot,'data/config',MEMORY_PLUGIN+'_config.json'),config=JSON.parse(readFileSync(file,'utf8'));
    assert.equal(config.filtering_settings.use_persona_filtering,true);assert.equal(config.provider_settings.embedding_provider_id,'pa-fixture-memory-embedding');
    config.reflection_engine.summary_trigger_rounds=20;writeFileSync(file,JSON.stringify(config));stageBundledCapabilities(options);
    assert.equal(JSON.parse(readFileSync(file,'utf8')).reflection_engine.summary_trigger_rounds,20);
    const unowned=mkdtempSync(join(tmpdir(),'miobot-stage-unowned-'));
    try{mkdirSync(join(unowned,'data/plugins',MEMORY_PLUGIN),{recursive:true});assert.throws(()=>stageBundledCapabilities({...options,runtimeRoot:unowned}),/不是 MioBot 内置/);}finally{rmSync(unowned,{recursive:true,force:true});}
  }finally{rmSync(runtimeRoot,{recursive:true,force:true});}
});

test('capability setup provisions isolated native embedding and summary references without returning credentials or calling paid test endpoints',async()=>{
  const calls=[],store={root:'/tmp/fixture-not-used',state:{instanceId:'fixture',settings:{location:'local',runtimeUrl:'http://127.0.0.1:1',defaultConnectionId:'chat'},modelConnections:[{id:'chat',type:'openai_chat_completion',provider:'openai',template:'openai',apiBase:'http://127.0.0.1:2/v1',model:'fixture-chat',config:{}}]},secrets:{modelConnections:{chat:{key:['fixture-private-key']}}}};
  const runtime=new AstrBot({root:'/tmp/unused',store});runtime.child={};runtime.nativeToolPolicy={applied:true};runtime.authenticate=async()=>({status:'ready'});runtime.syncConnection=async()=>({providerId:'fixture-summary'});
  runtime.request=async(path,options={})=>{calls.push({path,...options});if(path==='/providers')return [];if(path.startsWith('/plugins/config?'))return {config:{graph_memory:{enabled:true}}};return {};};
  const result=await runtime.setupCapabilities();
  assert.equal(result.memory.status,'configured');assert.equal(result.memory.summaryProviderId,'fixture-summary');assert.ok(!JSON.stringify(result).includes('fixture-private-key'));
  const provider=calls.find(c=>c.path==='/providers'&&c.method==='POST').body;
  assert.equal(provider.type,'openai_embedding');assert.equal(provider.embedding_api_key,'fixture-private-key');assert.equal(provider.embedding_dimensions,1536);
  assert.ok(!calls.some(c=>c.path.includes('/test')),'setup must not spend a model test request');
  const config=calls.find(c=>c.path==='/plugins/config'&&c.method==='PUT').body.config;
  assert.equal(config.filtering_settings.memory_scope_mode,'user');assert.equal(config.provider_settings.llm_provider_id,'fixture-summary');
  assert.ok(!calls.some(c=>c.path==='/tools/send_message_to_user/enabled'),'builtin toggle API is unsupported in pinned AstrBot');
});

test('managed-only native patch is narrow, idempotent and refuses an unknown source version',()=>{
  const root=mkdtempSync(join(tmpdir(),'miobot-native-patch-')),file=join(root,'astrbot/core/astr_main_agent.py');
  try{mkdirSync(join(root,'astrbot/core'),{recursive:true});writeFileSync(file,'import os\n    if event.platform_meta.support_proactive_message:\n        pass\n    fallback_providers = _get_fallback_chat_providers(\n');
    assert.equal(patchManagedRuntime(root).applied,true);const patched=readFileSync(file,'utf8');assert.match(patched,/MIOBOT_DISABLE_NATIVE_OUTBOUND_TOOLS/);patchManagedRuntime(root);assert.equal(readFileSync(file,'utf8'),patched);
    writeFileSync(file,'unknown future source');assert.throws(()=>patchManagedRuntime(root),/版本/);assert.equal(readFileSync(file,'utf8'),'unknown future source');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('long-term memory management filters every page and rejects another persona or username before deleting',async()=>{
  const persona='pa-fixture-companion',session='livingmemory:user:webchat:fixture-user',deleted=[];
  const store={state:{instanceId:'fixture'},assistant:id=>({id})},runtime=new AstrBot({root:'/tmp/unused',store});runtime.username='fixture-user';runtime.authenticate=async()=>{};
  const own=id=>({id,text:'fixture memory',metadata:{persona_id:persona,session_id:session}});
  runtime.request=async(path,options={})=>{
    if(path.includes('/detail?'))return {metadata:{persona_id:path.endsWith('99')?'pa-fixture-other':persona,session_id:path.endsWith('98')?'livingmemory:user:webchat:other-user':session}};
    if(path.endsWith('/batch-delete')){deleted.push(options.body.memory_ids);return {deleted_count:1};}
    const page=new URL('http://localhost'+path).searchParams.get('page');
    return page==='1'?{items:[own(1),{id:99,metadata:{persona_id:'pa-fixture-other',session_id:session}}],has_more:true}:{items:[own(2),{id:98,metadata:{persona_id:persona,session_id:'other-user'}}],has_more:false};
  };
  const result=await runtime.listLongMemories('companion');assert.deepEqual(result.items.map(m=>m.id),[1,2]);assert.equal(result.total,2);
  await assert.rejects(()=>runtime.deleteLongMemory('companion',99),/不属于/);await assert.rejects(()=>runtime.deleteLongMemory('companion',98),/不属于/);assert.equal(deleted.length,0);
  assert.equal((await runtime.deleteLongMemory('companion',1)).deleted,true);assert.deepEqual(deleted,[[1]]);
});
