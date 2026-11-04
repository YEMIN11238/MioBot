import {beijingInput,reminderISO} from './mobile-state.mjs';

export const WORKFLOW_STATUS={draft:'待确认',active:'进行中',paused:'已暂停',cancelled:'已取消',completed:'已完成',missed:'已错过'};
export const WORKFLOW_RUN_STATUS={queued:'等待执行',running:'正在处理',completed:'处理完成',failed:'执行未完成',delivery_unknown:'送达待核对',interrupted:'执行被中断'};
const weekdays=['','周一','周二','周三','周四','周五','周六','周日'];
export function workflowDate(value){if(!value||!Number.isFinite(Date.parse(value)))return '待确认';return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));}
export function workflowSchedule(schedule){
  if(schedule?.type==='once')return workflowDate(schedule.runAt)+' · 一次';
  if(schedule?.type==='daily')return '每天 '+(schedule.time||'待确认');
  if(schedule?.type==='weekly')return (schedule.weekdays||[]).map(n=>weekdays[n]).filter(Boolean).join('、')+' '+(schedule.time||'待确认');
  return '待确认时间';
}
export function workflowChannels(channels,assistantId){return (Array.isArray(channels)?channels:[]).filter(c=>c.assistantId===assistantId&&c.enabled===true&&c.status==='verified'&&c.supportProactive===true&&!!c.target);}
export function workflowView(payload,assistantId){
  const items=(Array.isArray(payload?.items)?payload.items:[]).filter(i=>i.assistantId===assistantId),ids=new Set(items.map(i=>i.id));
  return {items,runs:(Array.isArray(payload?.runs)?payload.runs:[]).filter(run=>ids.has(run.workflowId)),sources:(Array.isArray(payload?.sources)?payload.sources:[]).filter(s=>s.assistantId===assistantId),scheduler:payload?.scheduler&&['ready','needs_runtime','error'].includes(payload.scheduler.status)?{status:payload.scheduler.status,error:typeof payload.scheduler.error==='string'?payload.scheduler.error:''}:null};
}
export function freshWorkflowDraft(now=Date.now()){return {title:'',instruction:'',kind:'agent',scheduleType:'daily',runAt:beijingInput(now+3600000),time:'08:00',weekdays:[1,2,3,4,5],channel:'web',sourceIds:[]};}
export function workflowPayload(draft,{assistantId,requestId,channels=[],sources=[],now=Date.now()}={}){
  if(!assistantId||!requestId)throw Error('当前助手或请求信息不完整，请刷新页面。');
  const title=String(draft.title||'').trim(),instruction=String(draft.instruction||'').trim();
  if(!title||title.length>100)throw Error('请给任务起一个不超过100字的名字。');
  if(!instruction||instruction.length>3000)throw Error('请写清希望助手做什么，最多3000字。');
  if(!['agent','rss'].includes(draft.kind))throw Error('请选择任务类型。');
  const schedule={type:draft.scheduleType,timezone:'Asia/Shanghai'};
  if(schedule.type==='once'){
    schedule.runAt=reminderISO(draft.runAt);if(Date.parse(schedule.runAt)<=now)throw Error('请选择未来的执行时间。');
  }else if(['daily','weekly'].includes(schedule.type)){
    if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time||''))throw Error('请选择有效的执行时刻。');schedule.time=draft.time;
    if(schedule.type==='weekly'){if(!Array.isArray(draft.weekdays)||!draft.weekdays.length||draft.weekdays.some(d=>!Number.isInteger(d)||d<1||d>7))throw Error('请至少选择一周中的一天。');schedule.weekdays=[...new Set(draft.weekdays)].sort((a,b)=>a-b);}
  }else throw Error('请选择一次、每天或每周执行。');
  const channel=draft.channel||'web';if(channel!=='web'&&!workflowChannels(channels,assistantId).some(c=>c.id===channel))throw Error('请选择这位助手已验证的接收位置。');
  const sourceIds=[...new Set(Array.isArray(draft.sourceIds)?draft.sourceIds:[])];
  if(draft.kind==='rss'&&(!sourceIds.length||sourceIds.some(id=>!sources.some(s=>s.id===id&&s.assistantId===assistantId))))throw Error('请至少选择一个属于当前助手的订阅来源。');
  return {requestId,assistantId,title,instruction,kind:draft.kind,schedule,channel,confirmed:true,...(draft.kind==='rss'?{sourceIds}:{})};
}
export function workflowBindingReady(item){return !item?.bindingStatus||['ready','bound'].includes(item.bindingStatus);}
export function canRunWorkflow(item,run){return ['active','paused','missed'].includes(item?.status)&&workflowBindingReady(item)&&!['queued','running','delivery_unknown'].includes(run?.status)&&run?.deliveryStatus!=='unknown';}
export function workflowRuns(runs,workflowId){return (Array.isArray(runs)?runs:[]).filter(r=>r.workflowId===workflowId).sort((a,b)=>(Date.parse(b.startedAt||b.createdAt)||0)-(Date.parse(a.startedAt||a.createdAt)||0));}
export function publicSourceLink(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:'';}catch{return '';}}
export function rssSourcePayload({url,name},{assistantId,requestId}){
  let parsed;try{parsed=new URL(String(url||'').trim());}catch{throw Error('请填写完整的公开 HTTPS 订阅地址。');}
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||!parsed.hostname)throw Error('请使用不含账号密码的公开 HTTPS 订阅地址。');
  const label=String(name||parsed.hostname).trim();if(!label||label.length>100)throw Error('来源名称最多100字。');
  return {assistantId,requestId,url:parsed.href,name:label};
}
