import {cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {stageCloudPluginBundles} from './cloud-plugin-bundles.mjs';

export const MEMORY_PLUGIN='astrbot_plugin_livingmemory';
export const TASK_PLUGIN='astrbot_plugin_miobot_tasks';
export const WORKFLOW_PLUGIN='astrbot_plugin_miobot_workflows';
export const PROACTIVE_PLUGIN='astrbot_plugin_miobot_proactive';
export const RESEARCH_PLUGIN='astrbot_plugin_miobot_research';
export const MEDIA_PLUGIN='astrbot_plugin_miobot_media';
export const GAME_PLUGIN='astrbot_plugin_miobot_games';
export const HUMAN_PLUGIN='astrbot_plugin_wanna_be_human';
export const CLEAN_PLUGIN='astrbot_plugin_dafeiyu_clean';
export const MEMORY_VERSION='2.8.2';
export const MEMORY_COST_NOTICE='长期记忆会额外调用向量模型，并用所选聊天模型整理摘要；按模型服务商的实际用量计费。';
export const NATIVE_POLICY_PATCH='miobot-managed-outbound-tools-v2';

/** A narrowly scoped, reproducible change to the pinned runtime. The original
 * standalone AstrBot behavior is retained unless MioBot supplies this env flag. */
export function patchManagedRuntime(source,{allowWrite=true}={}){
  const file=join(source,'astrbot/core/astr_main_agent.py'),text=readFileSync(file,'utf8');let updated=text;
  const original='    if event.platform_meta.support_proactive_message:\n';
  const patched='    if (\n        event.platform_meta.support_proactive_message\n        and os.environ.get("MIOBOT_DISABLE_NATIVE_OUTBOUND_TOOLS") != "1"\n    ):\n';
  if(!updated.includes(patched)){
    if(updated.split(original).length!==2)throw new Error('AstrBot 版本与 MioBot 固定补丁不匹配，未修改后台源码。');
    updated=updated.replace(original,patched);
  }
  const anchor='    fallback_providers = _get_fallback_chat_providers(\n';
  const workflowPatch='    # MioBot managed workflow: narrow the final toolset after native additions.\n'+
    '    workflow_persona = event.get_extra("_trace_persona_id")\n'+
    '    if (\n        os.environ.get("MIOBOT_MANAGED_WORKFLOWS") == "1"\n'+
    '        and isinstance(workflow_persona, str)\n        and "-workflow-" in workflow_persona\n    ):\n'+
    '        workflow_role = plugin_context.persona_manager.get_persona_v3_by_id(workflow_persona)\n'+
    '        workflow_tools = workflow_role.get("tools", []) if workflow_role else []\n'+
    '        allowed_workflow_tools = set(workflow_tools or []) & {"miobot_search_web", "miobot_read_file"}\n'+
    '        narrowed_tools = ToolSet()\n'+
    '        for workflow_tool in list(req.func_tool or []):\n'+
    '            if workflow_tool.name in allowed_workflow_tools:\n                narrowed_tools.add_tool(workflow_tool)\n'+
    '        req.func_tool = narrowed_tools\n\n';
  if(!updated.includes(workflowPatch)){
    if(updated.split(anchor).length!==2)throw new Error('AstrBot 版本与 MioBot 定时权限补丁不匹配，未修改后台源码。');
    updated=updated.replace(anchor,workflowPatch+anchor);
  }
  if(updated!==text){if(!allowWrite)throw new Error('内置后台缺少 MioBot 消息发送或定时权限补丁，请重新安装最新打包版本。');writeFileSync(file,updated);}
  return {id:NATIVE_POLICY_PATCH,applied:true,workflowsApplied:true};
}

export function personaId(instanceId,assistantId){return `pa-${instanceId}-${assistantId}`;}
export function memoryProviderIds(instanceId){return {embeddingProviderId:`pa-${instanceId}-memory-embedding`,summaryProviderId:`pa-${instanceId}-memory-summary`};}

/** Native hooks, model tools and Skills are separate capabilities: deny by default. */
export function assistantNativeCapabilities(assistant,{purpose='chat',allowedTools=[]}={}){
  const enabled=new Set(assistant.skills||[]),plugins=[],tools=[],skills=[];
  if(purpose==='workflow'){
    const allowed=new Set(Array.isArray(allowedTools)?allowedTools:[]);
    if(enabled.has('web')&&(allowed.has('miobot_search_web')||allowed.has('web')))tools.push('miobot_search_web');
    if(enabled.has('files')&&(allowed.has('miobot_read_file')||allowed.has('files')))tools.push('miobot_read_file');
    if(tools.length)plugins.push(RESEARCH_PLUGIN);
    return {plugins,tools,skills};
  }
  if(enabled.has('long_memory')){plugins.push(MEMORY_PLUGIN);tools.push('recall_long_term_memory','memorize_long_term_memory');}
  if(enabled.has('minecraft')){plugins.push(GAME_PLUGIN);tools.push('miobot_mc_item','miobot_mc_recipe','miobot_mc_guide');skills.push('minecraft-guide');}
  if(enabled.has('reminders')){plugins.push(TASK_PLUGIN);tools.push('miobot_schedule_reminder','miobot_list_reminders','miobot_cancel_reminder');}
  if(enabled.has('workflows')){plugins.push(WORKFLOW_PLUGIN);tools.push('miobot_schedule_workflow','miobot_list_workflows','miobot_cancel_workflow');}
  if(enabled.has('web')||enabled.has('files')){plugins.push(RESEARCH_PLUGIN);if(enabled.has('web'))tools.push('miobot_search_web');if(enabled.has('files'))tools.push('miobot_read_file');}
  if(enabled.has('voice')||enabled.has('stickers')){plugins.push(MEDIA_PLUGIN);if(enabled.has('voice'))tools.push('miobot_voice_reply');if(enabled.has('stickers'))tools.push('miobot_send_sticker');}
  if(enabled.has('humanize'))plugins.push(HUMAN_PLUGIN,CLEAN_PLUGIN);
  return {plugins,tools,skills};
}

export function assertModelToolCompatibility(connection,tools=[],config=connection.config||{}){
  const effort=config.custom_extra_body?.reasoning_effort;
  if(tools.length&&connection.type==='openai_chat_completion'&&connection.model==='gpt-6-sol'&&effort!==undefined&&effort!=='none'){
    throw new Error('GPT-6 Sol 通过当前 Chat Completions 接口调用工具，需要在模型高级参数 custom_extra_body 中设置 {"reasoning_effort":"none"}。请保存后重试；当前模型和你的推理设置均未被自动替换。');
  }
}

export function toolModelOverrides(connection,config=connection.config||{},toolUse=false){
  if(!toolUse||connection.type!=='openai_chat_completion'||connection.model!=='gpt-6-sol')return {};
  assertModelToolCompatibility(connection,['tool'],config);
  return {custom_extra_body:{...config.custom_extra_body,reasoning_effort:'none'}};
}

export function livingMemoryConfig(instanceId,{embeddingProviderId,summaryProviderId}={}){
  const ids=memoryProviderIds(instanceId);
  return {
    bot_language:'zh',
    provider_settings:{embedding_provider_id:embeddingProviderId||ids.embeddingProviderId,llm_provider_id:summaryProviderId||ids.summaryProviderId,llm_stream_mode:'auto'},
    access_control:{whitelist_enabled:false,allowed_ids:'',identity_aliases:''},
    filtering_settings:{memory_scope_mode:'user',use_persona_filtering:true,use_session_filtering:true,isolated_sessions:''},
    session_manager:{enable_full_group_capture:false,context_window_size:30,max_messages_per_session:500},
    reflection_engine:{summary_trigger_rounds:6,max_segments_per_run:2,window_split_by_day:true,window_split_gap_minutes:180},
    agent_tools:{enable_recall_tool:true,enable_memorize_tool:true,enable_forget_tool:false,enable_agentic_recall_beta:false},
    graph_memory:{enabled:false},
    memory_consolidation:{enabled:false},
    forgetting_agent:{auto_cleanup_enabled:true,auto_archived_enabled:true,cleanup_days_threshold:30,cleanup_importance_threshold:0.3},
    backup_settings:{enabled:true,keep_days:7},
  };
}

function schemaDefaults(schema){const config={};for(const [key,value] of Object.entries(schema)){if(value.type==='object')config[key]=schemaDefaults(value.items||{});else if(Object.hasOwn(value,'default'))config[key]=structuredClone(value.default);}return config;}
export function deepMerge(base,patch){const result=structuredClone(base);for(const [key,value] of Object.entries(patch)){result[key]=value&&typeof value==='object'&&!Array.isArray(value)?deepMerge(result[key]&&typeof result[key]==='object'?result[key]:{},value):structuredClone(value);}return result;}

function directoryFingerprint(root){const hash=createHash('sha256');const visit=(directory,prefix='')=>{for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name==='__pycache__'||entry.name.endsWith('.pyc')||entry.name==='.miobot-bundle.json')continue;const name=prefix+entry.name,path=join(directory,entry.name);if(entry.isDirectory())visit(path,name+'/');else if(entry.isFile()){hash.update(name+'\0');hash.update(readFileSync(path));}}};visit(root);return hash.digest('hex');}

function stageDirectory(source,target,{bundleId,version}){
  if(!existsSync(source))return {id:bundleId,version,status:'missing'};
  const marker=join(target,'.miobot-bundle.json');
  if(existsSync(target)&&!existsSync(marker))throw new Error(`插件目录 ${bundleId} 已存在且不是 MioBot 内置版本，请先在扩展中检查，避免覆盖自装插件。`);
  const fingerprint=directoryFingerprint(source);
  if(existsSync(marker)){
    const previous=JSON.parse(readFileSync(marker,'utf8'));
    if(previous.fingerprint&&directoryFingerprint(target)!==previous.fingerprint)throw new Error(`内置插件 ${bundleId} 已被手动修改或更新，MioBot 没有覆盖它。请在扩展中检查版本。`);
    if(previous.fingerprint===fingerprint)return {id:bundleId,version,status:'staged'};
  }
  mkdirSync(target,{recursive:true});
  cpSync(source,target,{recursive:true,filter:path=>!path.includes('__pycache__')&&!path.endsWith('.pyc')});
  writeFileSync(marker,JSON.stringify({bundleId,version,fingerprint},null,2)+'\n',{mode:0o600});
  return {id:bundleId,version,status:'staged'};
}

/** Only the managed instance's data tree is written. User databases are never copied. */
export function stageBundledCapabilities({root,runtimeRoot,instanceId,store}){
  const plugins=join(runtimeRoot,'data/plugins'),configDir=join(runtimeRoot,'data/config');
  mkdirSync(plugins,{recursive:true,mode:0o700});mkdirSync(configDir,{recursive:true,mode:0o700});
  const memorySource=join(root,'integrations/livingmemory',MEMORY_PLUGIN);
  const installed=[stageDirectory(memorySource,join(plugins,MEMORY_PLUGIN),{bundleId:MEMORY_PLUGIN,version:MEMORY_VERSION})];
  if(installed[0].status==='staged'){
    const file=join(configDir,MEMORY_PLUGIN+'_config.json');
    if(!existsSync(file)){
      const schema=JSON.parse(readFileSync(join(memorySource,'_conf_schema.json'),'utf8'));
      writeFileSync(file,JSON.stringify(deepMerge(schemaDefaults(schema),livingMemoryConfig(instanceId)),null,2)+'\n',{mode:0o600});
    }
  }
  const gameSource=join(root,'integrations/plugins',GAME_PLUGIN);
  if(existsSync(gameSource))installed.push(stageDirectory(gameSource,join(plugins,GAME_PLUGIN),{bundleId:GAME_PLUGIN,version:'0.1.0'}));
  for(const id of [TASK_PLUGIN,WORKFLOW_PLUGIN,RESEARCH_PLUGIN,MEDIA_PLUGIN]){const source=join(root,'integrations/plugins',id);if(existsSync(source))installed.push(stageDirectory(source,join(plugins,id),{bundleId:id,version:'0.1.0'}));}
  const proactiveSource=join(root,'integrations/proactive',PROACTIVE_PLUGIN);if(existsSync(proactiveSource))installed.push(stageDirectory(proactiveSource,join(plugins,PROACTIVE_PLUGIN),{bundleId:PROACTIVE_PLUGIN,version:'0.1.0'}));
  const skillSource=join(root,'integrations/skills/minecraft-guide');
  if(existsSync(skillSource))stageDirectory(skillSource,join(runtimeRoot,'data/skills/minecraft-guide'),{bundleId:'minecraft-guide',version:'0.1.0'});
  for(const [folder,id,version] of [['humanizer',HUMAN_PLUGIN,'4.1.9-miobot.1'],['dafeiyu-clean',CLEAN_PLUGIN,'0.1.1-miobot']]){
    const source=join(root,'integrations',folder,id);
    if(!existsSync(source))continue;
    installed.push(stageDirectory(source,join(plugins,id),{bundleId:id,version}));
    const schemaFile=join(source,'_conf_schema.json'),file=join(configDir,id+'_config.json');
    if(!existsSync(file)&&existsSync(schemaFile)){
      const schema=JSON.parse(readFileSync(schemaFile,'utf8')),patchFile=join(root,'integrations',folder,'MIOBOT_DEFAULTS.json');
      const patch=existsSync(patchFile)?JSON.parse(readFileSync(patchFile,'utf8')):{};
      writeFileSync(file,JSON.stringify(deepMerge(schemaDefaults(schema),patch),null,2)+'\n',{mode:0o600});
    }
  }
  if(store)installed.push(...stageCloudPluginBundles({root,runtimeRoot,store}));
  return installed;
}

/** Internal credential access stays in the runtime; none of the returned data contains a key. */
export function embeddingConnection(store,id){
  const connections=store.state.modelConnections||[];
  const candidates=id?connections.filter(c=>c.id===id):connections.filter(c=>c.type==='openai_chat_completion'&&(c.provider==='openai'||c.template==='openai'));
  return candidates.find(c=>c.apiBase&&store.secrets.modelConnections?.[c.id]?.key?.some(k=>typeof k==='string'&&k));
}

export function summaryConnection(store,id){
  const selected=id||store.state.settings.defaultConnectionId;
  return (store.state.modelConnections||[]).find(c=>c.id===selected)||(store.state.modelConnections||[])[0];
}
