import {existsSync,readFileSync,readdirSync,mkdirSync,writeFileSync,cpSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

// Source-only bundles from the owner's deployed bot. No runtime data is shipped.
export const CLOUD_PLUGINS=Object.freeze([
  {id:'astrbot_plugin_seed_audio_tts',name:'豆包声音',version:'0.2.3-owner-control',description:'QQ 私聊语音，支持文字、单次和低概率模式。',tools:['set_voice_reply_mode']},
  {id:'astrbot_plugin_dafeiyu_sing',name:'唱歌',version:'0.2.1',description:'按主人的点歌请求生成并发送歌曲。',tools:['sing_song']},
  {id:'astrbot_plugin_qqprofile',name:'QQ 资料管理',version:'1.1.6-owner-avatar.2',description:'在 QQ 管理机器人的头像、昵称和状态。',tools:['qqprofile_set_avatar','qqprofile_set_signature','qqprofile_set_status','qqprofile_set_nickname']},
  {id:'astrbot_plugin_dafeiyu_signature',name:'QQ 个性签名',version:'0.1.3',description:'按主人的要求修改 QQ 签名。',tools:['set_signature']},
  {id:'astrbot_plugin_qzone',name:'QQ 空间',version:'3.1.3',description:'连接 QQ 空间；定时发布默认关闭。',tools:['llm_view_feed','llm_publish_feed']},
  {id:'meme_manager',name:'表情包管理与收集',version:'5.2.10-owner-stickers.1',description:'原生 QQ 图库、语义选图和主人私聊表情收集。',tools:['search_memes']},
  {id:'astrbot_plugin_bilibili_basic_stickers',name:'B站基础表情',version:'0.1.0',description:'收集固定 11 张公开基础表情，放入原生图库。',tools:['collect_bilibili_basic_stickers','send_bilibili_basic_sticker'],requires:['meme_manager']},
  {id:'astrbot_plugin_self_learning',name:'对话风格学习',version:'4.4.5',description:'学习指定主人会话的表达，自动学习默认关闭。',tools:[]},
  {id:'astrbot_sowing_discord',name:'指定群内容转发',version:'0.916',description:'原插件的 QQ 群转发能力；必须指定来源和目标。',tools:[]},
]);
const unsafe=new Set(['__proto__','prototype','constructor']);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const clone=x=>structuredClone(x);
const fail=message=>{throw Object.assign(new Error(message),{status:409});};
function merge(a,b){const out=clone(a);for(const [k,v] of Object.entries(b||{})){if(unsafe.has(k))fail('配置字段无效');out[k]=object(v)&&object(out[k])?merge(out[k],v):clone(v);}return out;}
function defaults(schema){const out={};for(const [k,v] of Object.entries(schema)){if(v.type==='object')out[k]=defaults(v.items||{});else if(Object.hasOwn(v,'default'))out[k]=clone(v.default);}return out;}
function check(value,schema,depth=0){
  if(!object(value)||depth>12)fail('组件配置需要有效对象');
  for(const [key,v] of Object.entries(value)){
    if(unsafe.has(key)||!Object.hasOwn(schema,key))fail('配置包含未知字段：'+key);
    const field=schema[key];
    if(v===null&&field.default===null)continue;
    if(field.type==='object'){check(v,field.items||{},depth+1);continue;}
    if(['string','text','password'].includes(field.type)&&typeof v!=='string'||field.type==='bool'&&typeof v!=='boolean'||['int','float'].includes(field.type)&&(typeof v!=='number'||!Number.isFinite(v)||field.type==='int'&&!Number.isInteger(v))||['list','dict'].includes(field.type)&&!(field.type==='list'?Array.isArray(v):object(v)))fail('配置类型不正确：'+key);
    if(Array.isArray(field.options)&&(Array.isArray(v)?v.some(x=>!field.options.includes(x)):!field.options.includes(v)))fail('请选择有效的配置选项：'+key);
    const bounds=field.slider||field;
    if(typeof v==='number'&&(v<(bounds.min??-1e9)||v>(bounds.max??1e9)))fail('配置超出允许范围：'+key);
    if(typeof v==='number'&&(!field.slider&&field.type==='float'&&/probability|(?:^|_)prob$/.test(key)&&(v<0||v>1)||key==='doubao_tries'&&(v<1||v>3)||/timeout/.test(key)&&(v<1||v>600)))fail('概率、重试或超时配置超出允许范围：'+key);
    if(typeof v==='string'&&v.length>20000||Array.isArray(v)&&v.length>500)fail('配置内容过长：'+key);
  }
  return value;
}
function secretPaths(schema,prefix=''){
  const out=[];
  for(const [key,field] of Object.entries(schema)){
    const path=prefix?prefix+'.'+key:key;
    if(field.type==='object')out.push(...secretPaths(field.items||{},path));
    else if(['string','text','password'].includes(field.type)&&(field._secret===true||field.type==='password'||/^(key|app_id)$|token|password|secret|api_?key|access_?key|cookie|credential/i.test(key)))out.push({path,label:field.description||key});
  }
  return out;
}
function get(o,path){return path.split('.').reduce((v,k)=>v?.[k],o);}
function put(o,path,value){const keys=path.split('.');let p=o;for(const k of keys.slice(0,-1)){if(unsafe.has(k))fail('配置字段无效');p[k]??={};p=p[k];}p[keys.at(-1)]=value;}
function digest(directory){const hash=createHash('sha256');function walk(dir,prefix=''){for(const x of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(x.name==='__pycache__'||x.name.endsWith('.pyc')||x.name==='.miobot-bundle.json')continue;const p=join(dir,x.name),name=prefix+x.name;if(x.isDirectory())walk(p,name+'/');else if(x.isFile()){hash.update(name+'\0');hash.update(readFileSync(p));}else fail('组件源码不能包含链接');}}walk(directory);return hash.digest('hex');}
function source(root,id){return join(root,'integrations/cloud-plugins',id);}
function schemaFor(root,id){return JSON.parse(readFileSync(join(source(root,id),'_conf_schema.json'),'utf8'));}
function bundleDefaults(root,id,schema=schemaFor(root,id)){const file=join(source(root,id),'MIOBOT_DEFAULTS.json');return merge(defaults(schema),existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{});}
export function cloudPluginNativeCapabilities(store,assistant,channel,{onlyIds=null}={}){
  if(!channel||channel.type!=='aiocqhttp'||channel.assistantId!==assistant.id||!channel.enabled||channel.status!=='verified')return {plugins:[],tools:[]};
  const plugins=[],tools=[];
  for(const p of CLOUD_PLUGINS){const selected=store.state.cloudPlugins?.[p.id];if(selected?.enabled&&selected.channelId===channel.id&&(!onlyIds||onlyIds.includes(p.id))){plugins.push(p.id);tools.push(...p.tools);}}
  return {plugins,tools};
}

function runtimeConfig(root,store,item,entry){
  const schema=schemaFor(root,item.id),value=merge(bundleDefaults(root,item.id,schema),entry.config||{});
  for(const {path} of secretPaths(schema))if(store.secrets.cloudPlugins?.[item.id]?.[path])put(value,path,store.secrets.cloudPlugins[item.id][path]);
  const channel=store.state.channels.find(c=>c.id===entry.channelId),owner=channel?.target?.match(/:FriendMessage:(\d+)$/)?.[1];
  const umo=owner?'pa-'+store.state.instanceId+'-'+channel.id+':FriendMessage:'+owner:'';
  // Owner identifiers are derived from the selected channel, never copied from the old bot.
  for(const key of ['owner_session','owner_umo','miobot_owner_umo'])if(Object.hasOwn(schema,key))value[key]=umo;
  if(Object.hasOwn(schema,'owner_qq'))value.owner_qq=owner||'';
  if(item.id==='meme_manager'){value.auto_collect??={};value.auto_collect.owner_qq=owner||'';value.auto_collect.owner_umo=umo;value.auto_collect.only_platform_stickers=true;}
  if(item.id==='astrbot_plugin_self_learning'){
    value.Target_Settings??={};value.Target_Settings.target_qq_list=owner?[owner]:[];
    value.Self_Learning_Basic??={};value.Self_Learning_Basic.enable_web_interface=false;
    // Never overwrite an application-owned persona from a second learning scheduler.
    for(const section of Object.values(value))if(object(section))for(const key of ['auto_apply_approved_persona','auto_apply_persona_updates','use_persona_manager_updates'])if(key in section)section[key]=false;
  }
  return value;
}

/** Runs before the managed engine starts. Only explicitly enabled bundles load. */
export function stageCloudPluginBundles({root,runtimeRoot,store}){
  const dir=join(runtimeRoot,'data/plugins'),parked=join(runtimeRoot,'data/miobot-disabled-plugins');mkdirSync(dir,{recursive:true});
  const result=[];
  for(const item of CLOUD_PLUGINS){
    const from=source(root,item.id);if(!existsSync(join(from,'main.py')))continue;
    const target=join(dir,item.id),marker=join(target,'.miobot-bundle.json'),entry=store.state.cloudPlugins?.[item.id];
    if(existsSync(target)){
      if(!existsSync(marker))fail('同名组件已由其他方式安装，未覆盖：'+item.name);
      const receipt=JSON.parse(readFileSync(marker,'utf8'));if(receipt.fingerprint!==digest(target))fail('组件源码已被手动修改，未覆盖：'+item.name);
    }
    if(!entry?.enabled){if(existsSync(target)){mkdirSync(parked,{recursive:true});renameSync(target,join(parked,item.id+'-'+Date.now()));}continue;}
    cpSync(from,target,{recursive:true,filter:p=>!p.includes('__pycache__')&&!p.endsWith('.pyc')});
    writeFileSync(marker,JSON.stringify({id:item.id,version:item.version,fingerprint:digest(target)}),{mode:0o600});
    const config=join(runtimeRoot,'data/config');mkdirSync(config,{recursive:true});writeFileSync(join(config,item.id+'_config.json'),JSON.stringify(runtimeConfig(root,store,item,entry),null,2)+'\n',{mode:0o600});
    result.push({id:item.id,version:item.version,status:'staged'});
  }
  return result;
}

export class CloudPluginBundles{
  constructor({root,store,runtime,isBusy=()=>false}){this.root=root;this.store=store;this.runtime=runtime;this.isBusy=isBusy;this.changing=false;}
  async list(){
    let active=[];if(this.runtime.status==='ready')try{const r=await this.runtime.request('/plugins');active=Array.isArray(r)?r:r.plugins||[];}catch{}
    return {items:CLOUD_PLUGINS.map(item=>{
      const present=existsSync(join(source(this.root,item.id),'main.py')),entry=this.store.state.cloudPlugins?.[item.id]||{},schema=present?schemaFor(this.root,item.id):{},config=merge(present?bundleDefaults(this.root,item.id,schema):{},entry.config||{}),fields=secretPaths(schema);
      for(const {path} of fields)put(config,path,'');
      const native=active.find(p=>p.name===item.id),status=!present?'missing':!entry.enabled?'bundled':native?.activated===true?'loaded':'needs_restart';
      return {...item,present,enabled:entry.enabled===true,channelId:entry.channelId||'',config,secretFields:fields.map(f=>({...f,saved:!!this.store.secrets.cloudPlugins?.[item.id]?.[f.path]})),status,verification:'not_tested',...(entry.lastError?{error:entry.lastError}:{})};
    }),note:'内置来源已核对。加载成功不等于QQ收发、语音或空间操作已经实测。'};
  }
  async patch(id,input){
    const item=CLOUD_PLUGINS.find(x=>x.id===id);if(!item)fail('找不到这个内置组件');
    if(!object(input)||Object.keys(input).some(k=>!['enabled','channelId','config','secrets'].includes(k)))fail('提交字段无效');
    if(this.changing||this.isBusy()||this.runtime.busy?.size)fail('请等当前回复或组件操作完成后再修改');
    if(this.store.state.settings.location!=='local')fail('请在 MioBot 托管后台中管理内置组件，外部引擎不会被自动修改');
    if(input.enabled!==undefined&&typeof input.enabled!=='boolean')fail('请选择是否启用组件');
    if(input.channelId!==undefined&&typeof input.channelId!=='string')fail('请选择消息渠道');
    const previous=clone(this.store.state.cloudPlugins?.[id]||{}),oldSecrets=clone(this.store.secrets.cloudPlugins||{}),schema=schemaFor(this.root,id),fields=secretPaths(schema);
    const next={enabled:false,channelId:'',config:{},...previous,...input};delete next.secrets;
    if(input.config!==undefined){check(input.config,schema);next.config=merge(previous.config||{},input.config);}
    const secrets=clone(oldSecrets[id]||{});
    for(const {path} of fields){const inline=get(next.config,path);if(typeof inline==='string'&&inline)secrets[path]=inline;put(next.config,path,'');}
    if(input.secrets!==undefined){if(!object(input.secrets))fail('服务凭据格式无效');for(const [path,value] of Object.entries(input.secrets)){if(!fields.some(f=>f.path===path)||typeof value!=='string'||value.length>20000)fail('服务凭据字段无效');if(value)secrets[path]=value;}}
    if(next.enabled){
      const channel=this.store.state.channels.find(c=>c.id===next.channelId);
      if(!channel||channel.type!=='aiocqhttp'||!channel.enabled||channel.status!=='verified'||!/:FriendMessage:\d+$/.test(channel.target||''))fail('先选择已验证的 QQ 主人私聊渠道，再启用这个组件');
      if(id==='astrbot_sowing_discord'&&['banshi_group_list','banshi_target_list'].some(key=>!Array.isArray(next.config[key])||!next.config[key].length||next.config[key].some(x=>typeof x!=='string'||!/^\d+$/.test(x))))fail('群转发需要明确的来源群和目标群白名单，留空不会转发');
      for(const dependency of item.requires||[]){const d=this.store.state.cloudPlugins?.[dependency];if(!d?.enabled||d.channelId!==next.channelId)fail('请先为同一渠道启用'+CLOUD_PLUGINS.find(p=>p.id===dependency).name);}
    }else for(const other of CLOUD_PLUGINS){const e=this.store.state.cloudPlugins?.[other.id];if(other.requires?.includes(id)&&e?.enabled)fail('请先停用依赖此组件的'+other.name);}
    this.changing=true;
    try{
      this.store.state.cloudPlugins??={};this.store.state.cloudPlugins[id]=next;this.store.setSecrets({cloudPlugins:{...oldSecrets,[id]:secrets}});this.store.save();
      if(next.enabled||previous.enabled){
        if(!this.runtime.child){await this.runtime.start();}else{this.runtime.stop();for(let i=0;i<100&&this.runtime.child;i++)await new Promise(r=>setTimeout(r,100));if(this.runtime.child)fail('后台尚未停止，请稍后重试');await this.runtime.start();}
        for(const c of this.store.state.channels.filter(c=>c.enabled))await this.runtime.syncChannel(c);
      }
      const result=await this.list(),record=result.items.find(p=>p.id===id);
      if(next.enabled&&record.status!=='loaded')fail('组件已保存，但没有加载成功，请查看组件状态');
      delete next.lastError;this.store.save();return {ok:true,item:record};
    }catch(e){
      const message=this.runtime.safeError(e);
      this.store.state.cloudPlugins[id]={...previous,lastError:message};this.store.setSecrets({cloudPlugins:oldSecrets});this.store.save();
      if(next.enabled||previous.enabled)try{
        if(this.runtime.child){this.runtime.stop();for(let i=0;i<100&&this.runtime.child;i++)await new Promise(r=>setTimeout(r,100));}
        if(this.runtime.child)throw new Error('恢复时后台未能停止');
        if(!this.runtime.child){await this.runtime.start();for(const c of this.store.state.channels.filter(c=>c.enabled))await this.runtime.syncChannel(c);}
      }catch(recovery){this.store.state.cloudPlugins[id].lastError=message+'；恢复后台失败：'+this.runtime.safeError(recovery);this.store.save();}
      throw Object.assign(new Error(message),{status:409});
    }finally{this.changing=false;}
  }
}
