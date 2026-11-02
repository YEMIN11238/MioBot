import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { boundedText } from './store.mjs';
import {productTemplateDefaults} from '../shared/product-text.mjs';

const bundled=JSON.parse(readFileSync(new URL('./catalog.json',import.meta.url),'utf8'));
export const STRUCTURAL_CONFIG_FIELDS=new Set(['type','provider','provider_type','provider_source_id']);
const secretName=k=>/(^|_)(key|keys|token|secret|password|authorization|credentials?|cookie)(_|$)/i.test(k.replace(/([a-z])([A-Z])/g,'$1_$2').replace(/[-.]/g,'_'));
const fieldsFor=(config,items={})=>Object.fromEntries(Object.keys(config).map(key=>[key,{...(items[key]||{description:key,type:typeof config[key]==='boolean'?'bool':typeof config[key]==='number'?'int':Array.isArray(config[key])?'list':config[key]&&typeof config[key]==='object'?'object':'string'}),...(secretName(key)?{secret:true}:{})}]));
export function splitConfig(config={},schema={}){
  const safe={},secrets={};
  for(const [key,value] of Object.entries(config)){
    if(['__proto__','constructor','prototype'].includes(key))throw new Error('配置字段无效');
    if(schema[key]?.secret||schema[key]?.password||(schema[key]?.invisible&&!STRUCTURAL_CONFIG_FIELDS.has(key))||['password','secret'].includes(schema[key]?.type)||secretName(key)){if(value!==''&&value!==null&&value!==undefined&&!(Array.isArray(value)&&!value.some(Boolean)))secrets[key]=value;continue;}
    if(Array.isArray(value)){let sensitive=false;for(const item of value)if(item&&typeof item==='object'){const parts=splitConfig(item,schema[key]?.items||{});if(Object.keys(parts.secrets).length)sensitive=true;}if(sensitive)secrets[key]=value;else safe[key]=value;continue;}
    if(value&&typeof value==='object'&&!Array.isArray(value)){const parts=splitConfig(value,schema[key]?.items||{});safe[key]=parts.safe;if(Object.keys(parts.secrets).length)secrets[key]=parts.secrets;}
    else safe[key]=value;
  }
  return {safe,secrets};
}
export function mergeConfig(a={},b={}){const out=structuredClone(a);for(const [k,v]of Object.entries(b)){if(['__proto__','constructor','prototype'].includes(k))throw new Error('配置字段无效');out[k]=v&&typeof v==='object'&&!Array.isArray(v)?mergeConfig(out[k]&&typeof out[k]==='object'?out[k]:{},v):v;}return out;}
export class Connections {
  constructor(store,runtime){this.store=store;this.runtime=runtime;}
  async models(){
    let schema=bundled.provider,source='bundled';
    try{await this.runtime.authenticate();const raw=await this.runtime.request('/providers/schema');schema=raw.config_schema?.provider||raw.provider||schema;source='astrbot';}catch{}
    const templates=Object.entries(schema.config_template||{}).filter(([,v])=>v.provider_type==='chat_completion').map(([name,v])=>({id:v.id||name,name,type:v.type,provider:v.provider,apiBase:v.api_base||'',config:splitConfig(productTemplateDefaults(v)).safe,schema:fieldsFor(v,schema.items)}));
    if(!templates.some(x=>x.id==='qwen'))templates.push({id:'qwen',name:'千问 / 阿里云百炼（OpenAI兼容）',type:'openai_chat_completion',provider:'openai',apiBase:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen-plus',config:{},schema:templates.find(x=>x.id==='openai')?.schema||{}});
    this.modelCatalog={templates,source,schema:{items:schema.items||{}}};return this.modelCatalog;
  }
  async channels(){
    let types=Object.entries(bundled.platform.config_template).map(([name,v])=>({type:v.type,name,config:splitConfig(productTemplateDefaults(v)).safe,schema:fieldsFor(v,bundled.platform.items),supportProactive:false,supportStreaming:false,registryLoaded:false})),source='bundled';
    try{await this.runtime.authenticate();const raw=await this.runtime.request('/bot-types');for(const v of raw.bot_types||[]){const index=types.findIndex(x=>x.type===v.type),fallback=types[index],config=v.default_config||fallback?.config||{},schema=v.schema?.items||v.schema||{};const entry={type:v.type,name:v.display_name||v.description||fallback?.name||v.type,config:splitConfig(productTemplateDefaults(config)).safe,schema:Object.keys(schema).length?schema:mergeConfig(fallback?.schema||{},fieldsFor(config,bundled.platform.items)),supportProactive:v.support_proactive_message===true,supportStreaming:v.support_streaming_message===true,registryLoaded:true};if(index<0)types.push(entry);else types[index]=entry;}source='astrbot';}catch{}
    this.channelCatalog={types,source};return this.channelCatalog;
  }
  async saveModel(body,id){
    const catalog=this.modelCatalog||await this.models(),old=id?this.store.connection(id):null;
    const template=catalog.templates.find(x=>x.id===(body.template||old?.template)||x.name===(body.template||old?.template));
    const config=mergeConfig(mergeConfig(template?.config||{},old?.config||{}),body.config||{}),parts=splitConfig(config,template?.schema||{});
    const value={...(old||{}),id:old?.id||randomUUID(),name:boundedText(body.name??old?.name??template?.name,'连接名称',60),template:body.template??old?.template??template?.id??'custom',type:body.type||old?.type||template?.type||'openai_chat_completion',provider:body.provider||old?.provider||template?.provider||'openai',apiBase:body.apiBase??old?.apiBase??template?.apiBase??'',model:boundedText(body.model??old?.model??template?.model??'deepseek-chat','模型名称',150),config:parts.safe,validation:{status:'untested'}};
    if(!catalog.templates.some(x=>x.type===value.type))throw new Error('请选择支持的模型连接方式');
    if(value.apiBase){const u=new URL(value.apiBase);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('模型地址须为有效 HTTP(S) 地址');}
    const secrets=mergeConfig(this.store.secrets.modelConnections[value.id]||{},parts.secrets);
    // Older versions mistakenly stored hidden protocol metadata as credentials.
    for(const field of STRUCTURAL_CONFIG_FIELDS)delete secrets[field];
    if(typeof body.key==='string'&&body.key.trim())secrets.key=[body.key.trim()];else if(Array.isArray(body.key)&&body.key.some(Boolean))secrets.key=body.key.filter(Boolean);
    this.store.secrets.modelConnections[value.id]=secrets;this.store.setSecrets({});
    if(old)Object.assign(old,value);else this.store.state.modelConnections.push(value);
    if(!this.store.state.settings.defaultConnectionId)this.store.state.settings.defaultConnectionId=value.id;this.store.save();const affected=this.store.state.assistants.filter(a=>(a.defaultConnectionId||this.store.state.settings.defaultConnectionId)===value.id).map(a=>a.id),syncWarnings=await this.refreshBindings(affected);return {...value,hasKey:!!secrets.key?.length,syncWarnings};
  }
  async saveChannel(body,id){
    const catalog=this.channelCatalog||await this.channels(),old=id?this.store.channel(id):null,type=body.type||old?.type,template=catalog.types.find(x=>x.type===type);if(!template)throw new Error('请选择支持的消息渠道');
    const parts=splitConfig(mergeConfig(mergeConfig(template.config||{},old?.config||{}),body.config||{}),template.schema),extra=splitConfig(body.secrets||{});const secret=mergeConfig(mergeConfig(this.store.secrets.channels[old?.id]||{},parts.secrets),mergeConfig(extra.safe,extra.secrets));
    const assistantId=body.assistantId??old?.assistantId??'daily';this.store.assistant(assistantId);
    const value={...(old||{}),id:old?.id||randomUUID(),name:boundedText(body.name??old?.name??template.name,'渠道名称',60),type,config:parts.safe,assistantId,target:body.target??old?.target??'',enabled:body.enabled??old?.enabled??false,supportProactive:catalog.source==='astrbot'&&template.supportProactive,supportStreaming:template.supportStreaming,status:'saved'};
    if(value.target&&(!/^[^:]+:(FriendMessage|GroupMessage):.+$/.test(value.target)||value.target.length>500))throw new Error('接收对象需填写统一会话地址，例如 telegram:FriendMessage:用户ID');
    delete value.verifiedAt;delete value.lastSentAt;delete value.lastError;this.store.secrets.channels[value.id]=secret;this.store.setSecrets({});
    if(old){delete old.verifiedAt;delete old.lastSentAt;delete old.lastError;Object.assign(old,value);}else this.store.state.channels.push(value);this.store.save();return {...value,secretFields:Object.keys(secret)};
  }
  async connect(id){const channel=this.store.channel(id),priorStatus=channel.status;try{await this.runtime.syncChannel(channel);const catalog=await this.channels(),type=catalog.types.find(x=>x.type===channel.type);channel.supportProactive=type?.supportProactive===true;channel.supportStreaming=type?.supportStreaming===true;channel.status=['verified','sent'].includes(priorStatus)?priorStatus:'configured';delete channel.lastError;}catch(e){channel.status='error';channel.lastError=this.runtime.safeError(e);this.store.save();throw e;}this.store.save();return channel;}
  async refreshBindings(assistantIds=null){const warnings=[];for(const c of this.store.state.channels){if(!c.nativeId||assistantIds&&!assistantIds.includes(c.assistantId))continue;try{await this.connect(c.id);}catch(e){c.status='error';c.lastError='配置已保存，但后台同步失败：'+this.runtime.safeError(e);warnings.push(c.name+'：'+c.lastError);this.store.save();}}return warnings;}
  async send(id,text,{test=false}={}){const c=this.store.channel(id);try{if(!c.enabled)throw new Error('请先启用并连接这个渠道');if(!c.target)throw new Error('请先指定接收对象');const catalog=await this.channels(),type=catalog.types.find(x=>x.type===c.type);if(catalog.source!=='astrbot'||!type?.supportProactive)throw new Error('该渠道适配器尚未确认支持主动发送');await this.runtime.sendChannel(c,boundedText(text,'消息',4000));const at=new Date().toISOString();if(test){c.status='sent';c.lastSentAt=at;delete c.verifiedAt;}else c.lastDeliveryAt=at;delete c.lastError;this.store.save();return {status:'accepted',message:'渠道接口已接受发送，实际收到情况需本人确认。',channel:c};}catch(e){c.status='error';c.lastError=this.runtime.safeError(e);this.store.save();throw e;}}
}
