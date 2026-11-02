import {legacyReminderReply} from './reminder-presentation.mjs';
import { mkdirSync, chmodSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {visibleReply} from '../shared/reply-visibility.mjs';
import {ASSISTANT_PRESETS,DEFAULT_CARE,conversationalParts} from './assistant-profiles.mjs';
import {applyBundledCapabilities} from './bundled-capabilities.mjs';

export const templates = [
  {id:'daily',name:'日常助手',kind:'daily',description:'日常交流 · 提醒安排',persona:'你是一位亲切、清楚、有分寸的个人助手。回答自然简短，先理解用户真正想做的事。没有执行凭据时，不要声称已创建任务、已发送消息或已经联网。',enabled:true,skills:['memory','reminders']},
  {id:'game',name:'游戏助手',kind:'game',description:'游戏交流 · 计划安排',persona:'你是我的游戏个人助手。先了解游戏名称、版本、已有进度和可投入时间，再给出具体可执行的建议。没有搜索结果时不编造版本公告、活动日期和攻略来源，不自动操作游戏。',enabled:true,skills:['memory','reminders']},
  {id:'career',name:'求职助手',kind:'career',description:'公司调研 · 面试准备',persona:'你是我的求职助手。帮助梳理实际经历、公司资料和面试准备。严格区分事实与假设，不编造个人贡献、业务数据、访谈和项目成果。',enabled:false,skills:['memory']},
];
for(const template of templates)Object.assign(template,ASSISTANT_PRESETS[template.kind],{presetRevision:2,care:{...DEFAULT_CARE}});

export class Store {
  constructor(root){
    root=resolve(root);mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);this.root=root;this.file=join(root,'state.json');this.secretFile=join(root,'credentials.json');
    this.state=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):{schema:1,assistants:structuredClone(templates),chats:[],memories:[],tasks:[],notifications:[],settings:{location:'local',runtimeUrl:'http://127.0.0.1:26185',modelBase:'https://api.deepseek.com/v1',model:'deepseek-chat',timezone:'Asia/Shanghai',autoMemory:false},extensions:{memory:true,reminders:true}};
    this.state.instanceId||=randomUUID();this.secrets=existsSync(this.secretFile)?JSON.parse(readFileSync(this.secretFile,'utf8')):{};
    this.secrets.modelConnections||={};this.secrets.channels||={};this.state.channels||=[];
    if(!Array.isArray(this.state.modelConnections)){
      this.state.modelConnections=[];
      if(existsSync(this.file)&&this.secrets.modelKey){const id='default-model';this.state.modelConnections=[{id,name:'原有模型连接',template:'openai',type:'openai_chat_completion',provider:'openai',apiBase:this.state.settings.modelBase,model:this.state.settings.model,config:{},validation:{status:'untested'}}];this.secrets.modelConnections[id]={key:[this.secrets.modelKey]};this.state.settings.defaultConnectionId=id;}
    }
    this.state.extensions={memory:true,reminders:true,voice:false,stickers:false,web:false,files:false,...this.state.extensions};
    this.state.extensionConfig||={};this.secrets.extensions||={};
    this.state.files||=[];this.state.stickers||=[];this.state.mediaAudio||=[];
    this.state.schema=2;
    this.state.capabilities||={memory:{status:'not_configured'},game:{status:'not_configured',version:'1.21.8',tools:['miobot_mc_item','miobot_mc_recipe','miobot_mc_guide'],mode:'read_only'},plugins:[]};
    this.state.capabilities.personality||={status:'not_configured',modules:['style','time','continuity','emotion','reply_clean','paced_parts']};
    const originalPersonas={daily:'你是一位亲切、清楚、有分寸的个人助手。回答自然简短，先理解用户真正想做的事。没有执行凭据时，不要声称已创建任务、已发送消息或已经联网。',game:'你是我的游戏个人助手。先了解游戏名称、版本、已有进度和可投入时间，再给出具体可执行的建议。没有搜索结果时不编造版本公告、活动日期和攻略来源，不自动操作游戏。',career:'你是我的求职助手。帮助梳理实际经历、公司资料和面试准备。严格区分事实与假设，不编造个人贡献、业务数据、访谈和项目成果。'};
    for(const a of this.state.assistants){if(!a.presetRevision&&a.persona===originalPersonas[a.kind]){const preset=ASSISTANT_PRESETS[a.kind];a.persona=preset.persona;a.description=preset.description;a.skills=[...preset.skills];if(a.id==='daily'&&a.name==='日常助手')a.name='陪伴助手';}a.presetRevision||=2;a.care||={...DEFAULT_CARE};}
    for(const a of this.state.assistants)if(['daily','game','career'].includes(a.id)&&!a.personalCapabilitiesRevision){a.skills=[...new Set([...(a.skills||[]),'reminders','humanize'])];a.personalCapabilitiesRevision=1;}
    for(const a of this.state.assistants)if(a.id==='game'&&a.description==='版本资讯 · 游戏计划')a.description='游戏交流 · 计划安排';
    for(const c of this.state.chats){if(c.runStatus==='running')c.runStatus='idle';for(const m of c.messages)if(m.status==='streaming'){m.status='cancelled';m.error='应用重新启动，之前的回复已中断';}}
    applyBundledCapabilities(this);
    this.atomic(this.secretFile,this.secrets);
    this.save();
  }
  atomic(file,data){const tmp=file+'.'+randomUUID();writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,file);}
  save(){this.atomic(this.file,this.state);}
  setSecrets(values){Object.assign(this.secrets,values);if(values.modelKey){let connection=this.state.modelConnections.find(c=>c.id===this.state.settings.defaultConnectionId);if(!connection){connection={id:'default-model',name:'原有模型连接',template:'openai',type:'openai_chat_completion',provider:'openai',apiBase:this.state.settings.modelBase,model:this.state.settings.model,config:{},validation:{status:'untested'}};this.state.modelConnections.push(connection);this.state.settings.defaultConnectionId=connection.id;}connection.apiBase=this.state.settings.modelBase;connection.model=this.state.settings.model;connection.validation={status:'untested'};this.secrets.modelConnections[connection.id]={...this.secrets.modelConnections[connection.id],key:[values.modelKey]};}this.atomic(this.secretFile,this.secrets);}
  snapshot(){return {...structuredClone(this.state),chats:this.state.chats.map(c=>({...structuredClone(c),messages:c.messages.map(m=>{const copy=structuredClone(m);copy.text=legacyReminderReply(m);if(copy.text!==m.text)copy.parts=[copy.text];if(m.role==='assistant'&&['astrbot','care'].includes(m.source)){const text=visibleReply(m.text);if(text!==m.text){copy.text=text;copy.parts=conversationalParts(text,(m.parts?.length||0)>1);}}return copy;})})),files:this.state.files.map(({path,ownerId,text,...m})=>m),stickers:this.state.stickers.map(({path,ownerId,...m})=>m),mediaAudio:this.state.mediaAudio.map(({path,ownerId,requestKey,userMessageId,textSha256,...m})=>m),modelConnections:this.state.modelConnections.map(c=>({...structuredClone(c),hasKey:!!this.secrets.modelConnections[c.id]?.key?.length})),channels:this.state.channels.map(c=>({...structuredClone(c),secretFields:Object.keys(this.secrets.channels[c.id]||{})})),settings:{...this.state.settings,hasModelKey:!!this.secrets.modelKey||!!this.secrets.modelConnections[this.state.settings.defaultConnectionId]?.key?.length,hasRuntimeToken:!!this.secrets.runtimeToken},storage:{root:this.root,state:this.file,credentials:this.secretFile,runtime:join(this.root,'astrbot'),logs:join(this.root,'logs')}};}
  assistant(id){const a=this.state.assistants.find(x=>x.id===id);if(!a)throw new Error('找不到这个助手');return a;}
  chat(id){const c=this.state.chats.find(x=>x.id===id);if(!c)throw new Error('找不到这段对话');return c;}
  connection(id){const c=this.state.modelConnections.find(x=>x.id===id);if(!c)throw new Error('模型连接不存在');return c;}
  channel(id){const c=this.state.channels.find(x=>x.id===id);if(!c)throw new Error('消息渠道不存在');return c;}
  selectedConnection(chat){return this.connection(chat.connectionId||this.assistant(chat.assistantId).defaultConnectionId||this.state.settings.defaultConnectionId);}
  createChat(assistantId){this.assistant(assistantId);const c={id:randomUUID(),assistantId,title:'新对话',createdAt:new Date().toISOString(),messages:[]};this.state.chats.unshift(c);this.save();return c;}
  message(chatId,role,text,extra={}){const c=this.chat(chatId),m={id:randomUUID(),role,text,createdAt:new Date().toISOString(),...extra};c.messages.push(m);if(role==='user'&&c.title==='新对话')c.title=text.slice(0,22);this.save();return m;}
  invalidateSessions(){/* Persona and memory are refreshed in place; keep conversation continuity. */}
}

export function boundedText(value,label,max=10000){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${label}不能为空，且不能超过${max}字`);return value.trim();}

/** Parse only explicit, bounded reminder commands; other requests go to AstrBot. */
export function reminderDraft(text,now=Date.now()){
  const nums={'零':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
  const number=s=>/^\d+$/.test(s)?Number(s):s==='十'?10:s.includes('十')?(nums[s.split('十')[0]]||1)*10+(nums[s.split('十')[1]]||0):nums[s];
  let due;const relative=text.match(/^\s*(?:请你|请|帮我)?(\d+|[一二两三四五六七八九十]+)\s*(秒|分钟|小时|天)后.*?提醒我[，,：:\s]*(.+)/);
  const exact=text.match(/^\s*(?:请你|请|帮我)?(今天|今晚|明天|明晚)\s*(\d{1,2}|[零一二两三四五六七八九十]+)(?:[:：](\d{2})|点(?:(半|\d{1,2})分?)?).*?提醒我[，,：:\s]*(.+)/);
  let title;
  if(relative){const n=number(relative[1]);if(!n||n>365)return null;due=now+n*({'秒':1000,'分钟':60000,'小时':3600000,'天':86400000}[relative[2]]);title=relative[3];}
  else if(exact){let hour=number(exact[2]),minute=exact[3]?Number(exact[3]):exact[4]==='半'?30:Number(exact[4]||0);if(hour>23||minute>59)return null;if((exact[1]||'').includes('晚')&&hour<12)hour+=12;const day=new Date(now+((exact[1]||'').includes('明')?86400000:0));const ymd=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(day);due=Date.parse(`${ymd}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+08:00`);title=exact[5];}
  else return null;
  if(!Number.isFinite(due)||due<=now)return {error:'这个时间已经过去了，请说一个未来的时间。'};
  return {title:title.trim().slice(0,100),dueAt:new Date(due).toISOString(),channel:'web',status:'draft'};
}

export class Scheduler {
  constructor(store,{now=()=>Date.now(),onNotify=()=>{},deliver=null}={}){this.store=store;this.now=now;this.onNotify=onNotify;this.deliver=deliver;}
  recover(){let changed=false;for(const t of this.store.state.tasks){if(t.status==='sending'||t.status==='pending'&&Date.parse(t.dueAt)<this.now()-60000){t.status='overdue';t.logs.push({at:new Date(this.now()).toISOString(),text:'应用停止期间错过执行时间，等待你重新安排。'});changed=true;}}if(changed)this.store.save();}
  tick(){if(!this.store.state.extensions.reminders)return;for(const t of this.store.state.tasks){if(t.status!=='pending'||Date.parse(t.dueAt)>this.now())continue;const at=new Date(this.now()).toISOString();if(t.channel!=='web'){t.status='sending';this.store.save();Promise.resolve().then(()=>{if(!this.deliver)throw new Error('消息渠道尚未连接');return this.deliver(t);}).then(()=>{t.status='done';t.deliveredAt=new Date(this.now()).toISOString();t.logs.push({at:t.deliveredAt,text:'渠道接口已接受发送；不代表用户已收到或已读。'});this.store.save();}).catch(e=>{t.status='failed';t.error=e.message;t.logs.push({at:new Date(this.now()).toISOString(),text:e.message});this.store.save();});continue;}const n={id:randomUUID(),taskId:t.id,assistantId:t.assistantId,title:t.title,at,read:false};this.store.state.notifications.unshift(n);if(t.chatId){const chat=this.store.state.chats.find(c=>c.id===t.chatId&&c.assistantId===t.assistantId);if(chat&&!chat.messages.some(m=>m.taskId===t.id&&m.source==='reminder'))chat.messages.push({id:randomUUID(),role:'assistant',text:'提醒你：'+t.title,createdAt:at,status:'complete',source:'reminder',taskId:t.id});}t.status='done';t.deliveredAt=at;t.logs.push({at,text:'已送达本应用收件箱；不代表用户已读。'});this.store.save();this.onNotify(n);}}
}
