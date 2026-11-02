import {createHash,randomUUID} from 'node:crypto';

export const TASK_TOOL_NAMES=['schedule_reminder','list_reminders','cancel_reminder'];
export const TASK_MODEL_TOOLS=TASK_TOOL_NAMES.map(name=>'miobot_'+name);
const DAY=86400000,ZONE='Asia/Shanghai';
const failure=(code,message,extra={})=>({ok:false,error:{code,message,...extra}});
const fail=(code,message,extra={})=>{throw Object.assign(new Error(message),{code,extra});};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const digits={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
function number(value){if(/^\d+(?:\.\d+)?$/.test(value))return Number(value);if(value==='半')return .5;if(value.includes('十')){const [t,u]=value.split('十');return (t?digits[t]:1)*10+(u?digits[u]:0);}return [...value].every(c=>Object.hasOwn(digits,c))?Number([...value].map(c=>digits[c]).join('')):NaN;}
const dateParts=now=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now)).map(p=>[p.type,p.value]));
function validDate(y,m,d){const dt=new Date(Date.UTC(y,m-1,d));return dt.getUTCFullYear()===y&&dt.getUTCMonth()===m-1&&dt.getUTCDate()===d;}
function parseISO(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|\+08:00)$/.test(value))fail('INVALID_TIME_FORMAT','执行时间需要带明确时区的 ISO 格式，例如 2026-11-03T07:00:00+08:00。');
  const [y,m,d,h,min,sec]=value.match(/\d+/g).map(Number);
  if(!validDate(y,m,d)||h>23||min>59||(sec||0)>59||!Number.isFinite(Date.parse(value)))fail('INVALID_TIME_FORMAT','执行时间不是有效日期或时刻。');
  return Date.parse(value);
}
const reminderIntent=text=>/(提醒(?:我)?|叫醒(?:我)?|叫我|喊我|通知我|闹钟|定时)/.test(text);
const cancelledIntent=text=>/(取消|删除.{0,8}提醒|别(?:再)?(?:提醒|叫|喊|通知)|不要(?:再)?(?:提醒|叫醒|叫我|喊我)|不用(?:再)?(?:提醒|叫醒|叫我|喊我))/.test(text);
const hasTime=text=>/\d{1,2}[:：]\d{2}|(?:\d+|[零〇一二两三四五六七八九十]+)点|(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十半]+)(?:秒|分钟|小时|天)后/.test(text);
function userRequest(chat){
  const users=chat.messages.filter(m=>m.role==='user');const user=users.at(-1);
  if(!user||typeof user.text!=='string')fail('NO_USER_REQUEST','当前没有可核对的用户提醒请求。');
  let text=user.text,referenceAt=user.createdAt;
  if(!reminderIntent(text)&&hasTime(text)&&users.length>1){
    const at=chat.messages.findLastIndex(m=>m.id===user.id),previous=chat.messages.slice(0,at).findLast(m=>m.role==='assistant');
    const prior=users.at(-2);
    if(previous&&/(几点|什么时间|什么时候|具体时间|哪天|哪一天)/.test(previous.text||'')&&reminderIntent(prior.text)&&!cancelledIntent(prior.text)){text=prior.text+' '+text;referenceAt=prior.createdAt;}
  }
  return {user,text,referenceAt};
}
/** Derive the requested one-time timestamp from the real user message, not a model assertion. */
export function requestedReminderTime(text,{now=Date.now(),requestedAt=now}={}){
  const lead=text.split(/提醒我|叫醒我|叫我|喊我|通知我/)[0];
  if(/每(?:天|日|周|星期|月|年|早|晚)|每隔|工作日|循环|重复/.test(lead)||/提醒我\s*每(?:天|日|周|星期|月|年)/.test(text))return failure('RECURRENCE_NOT_SUPPORTED','当前只支持一次性提醒，不能把重复提醒当作一次性任务创建。');
  const iso=text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|\+08:00)/);
  if(iso){try{return {ok:true,at:parseISO(iso[0]),relative:false};}catch(e){return failure(e.code,e.message);}}
  const relative=text.match(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十半]+)\s*(秒|分钟|小时|天)后/);
  if(relative){const n=number(relative[1]),duration=n*{秒:1000,分钟:60000,小时:3600000,天:DAY}[relative[2]];return Number.isFinite(duration)&&duration>0&&duration<=365*DAY?{ok:true,at:requestedAt+duration,relative:true}:failure('INVALID_TIME','提醒间隔需要大于零，且不超过365天。');}
  const time=text.match(/(\d{1,2}|[零〇一二两三四五六七八九十]+)\s*(?:[:：](\d{2})|点(?:(半|一刻|三刻|\d{1,2}|[零〇一二两三四五六七八九十]+)分?)?)/);
  if(!time)return failure('NEEDS_TIME','你希望具体几点提醒？请先确认时刻，例如“明天早上7点”，我不会自行猜测。');
  let hour=number(time[1]),minute=time[2]?Number(time[2]):time[3]==='半'?30:time[3]==='一刻'?15:time[3]==='三刻'?45:time[3]?number(time[3]):0;
  if(!Number.isInteger(hour)||!Number.isInteger(minute)||hour<0||hour>23||minute<0||minute>59)return failure('INVALID_TIME','请提供有效的小时和分钟。');
  if(/下午|晚上|傍晚|今晚|明晚/.test(text)&&hour<12)hour+=12;
  if(/凌晨/.test(text)&&hour===12)hour=0;
  const today=dateParts(requestedAt);let y=Number(today.year),m=Number(today.month),d=Number(today.day),dayOffset=0;
  const date=text.match(/(?:(\d{4})[年/-])?(\d{1,2})[月/-](\d{1,2})(?:日|号)?/);
  if(date){y=date[1]?Number(date[1]):y;m=Number(date[2]);d=Number(date[3]);if(!validDate(y,m,d))return failure('INVALID_TIME','请确认提醒日期。');}
  else if(/后天/.test(text))dayOffset=2;
  else if(/明天|明早|明晚/.test(text))dayOffset=1;
  else if(!/今天|今晚|今早|今日/.test(text))return failure('NEEDS_DATE','请确认是哪一天，例如“明天早上7点”，避免把提醒安排错日期。');
  return {ok:true,at:Date.UTC(y,m-1,d,hour,minute)-8*3600000+dayOffset*DAY,relative:false};
}
function context(store,scope){
  if(!object(scope)||typeof scope.assistantId!=='string'||typeof scope.chatId!=='string')fail('NO_CONTEXT','定时工具缺少已认证的当前会话。');
  const assistant=store.assistant(scope.assistantId),chat=store.chat(scope.chatId);
  if(chat.assistantId!==assistant.id||!assistant.enabled||!assistant.skills?.includes('reminders'))fail('FORBIDDEN','当前助手没有定时提醒权限。');
  const owner=typeof scope.ownerId==='string'&&scope.ownerId?scope.ownerId:'chat:'+chat.id;
  return {assistant,chat,owner};
}
const owns=(task,scope,owner)=>task.assistantId===scope.assistantId&&(task.ownerId?task.ownerId===owner:task.chatId===scope.chatId);
const publicTask=task=>({...Object.fromEntries(['id','title','dueAt','status','channel','assistantId','createdAt','confirmedAt','deliveredAt'].filter(key=>task[key]!==undefined).map(key=>[key,task[key]])),...(task.error?{error:'提醒未能投递，请在任务页查看执行记录。'}:{})});
function assertArgs(args,keys){if(!object(args)||Object.keys(args).some(key=>!keys.includes(key)))fail('INVALID_ARGUMENTS','定时工具参数无效；接收对象和助手由当前会话确定，不能由模型指定。');}
function target(store,scope,text){
  const id=scope.channel||'web';
  const wantsQQ=/(?:在|用|通过|发到|发送到|发去|到)\s*QQ|QQ(?:上|里|私聊)(?:提醒|叫|发|通知)|^\s*QQ(?:提醒|叫)/i.test(text)&&!/(?:不要|别|不用).{0,3}QQ/i.test(text);
  if(id==='web'){if(wantsQQ)fail('CHANNEL_NOT_CONNECTED','你要求通过QQ提醒，但当前会话没有绑定已验证的QQ接收位置；提醒还没有创建。');return id;}
  const channel=store.state.channels.find(c=>c.id===id);
  if(!channel||channel.assistantId!==scope.assistantId||!channel.enabled||!channel.supportProactive||channel.status!=='verified'||!channel.target)fail('CHANNEL_NOT_CONNECTED','接收渠道还没有通过实际送达验证；提醒还没有创建，请先完成渠道连接。');
  if(wantsQQ&&!/qq|aiocqhttp/i.test(channel.type||''))fail('CHANNEL_NOT_CONNECTED','你要求QQ提醒，但已绑定的接收位置不是QQ；提醒还没有创建。');
  return id;
}

/** Pure application action; all identity/delivery scope must come from a trusted bridge. */
export function handleTaskTool(store,scope,name,args={}, {now=Date.now()}={}){
  try{
    name=typeof name==='string'?name.replace(/^miobot_/,''):name;if(!TASK_TOOL_NAMES.includes(name))fail('UNKNOWN_TOOL','未知的定时工具。');
    const {chat,owner}=context(store,scope);
    if(name==='list_reminders'){
      assertArgs(args,['includeCompleted']);if(args.includeCompleted!==undefined&&typeof args.includeCompleted!=='boolean')fail('INVALID_ARGUMENTS','includeCompleted需要布尔值。');
      const tasks=store.state.tasks.filter(t=>owns(t,scope,owner)&&(args.includeCompleted||!['done','cancelled'].includes(t.status))).sort((a,b)=>Date.parse(a.dueAt)-Date.parse(b.dueAt));
      return {ok:true,timeZone:ZONE,tasks:tasks.slice(0,50).map(publicTask),total:tasks.length,truncated:tasks.length>50};
    }
    const request=userRequest(chat);
    if(name==='cancel_reminder'){
      assertArgs(args,['taskId']);if(typeof args.taskId!=='string'||!args.taskId||args.taskId.length>128)fail('INVALID_ARGUMENTS','请提供有效任务编号。');
      if(!cancelledIntent(request.user.text))fail('NEEDS_AUTHORIZATION','当前用户还没有要求取消提醒。');
      const task=store.state.tasks.find(t=>t.id===args.taskId&&owns(t,scope,owner));if(!task)fail('NOT_FOUND','当前助手没有找到这条提醒。');
      if(task.status==='sending')fail('IN_PROGRESS','消息已经交给渠道处理，当前不能保证撤回。');if(task.status==='done')fail('ALREADY_SENT','这条提醒已经投递，不能撤回已发送消息。');
      if(task.status==='cancelled')return {ok:true,alreadyCancelled:true,task:publicTask(task)};
      task.status='cancelled';task.logs||=[];task.logs.push({at:new Date(now).toISOString(),text:'用户在聊天中要求取消，已停止等待执行。'});store.save();return {ok:true,task:publicTask(task)};
    }
    assertArgs(args,['title','dueAt','explicitTime']);
    if(!store.state.extensions.reminders)fail('DISABLED','定时提醒已关闭，请先启用这项能力。');
    if(typeof args.title!=='string'||!args.title.trim()||args.title.length>100)fail('INVALID_ARGUMENTS','提醒内容需要1到100个字。');
    if(!reminderIntent(request.text)||cancelledIntent(request.user.text))fail('NEEDS_AUTHORIZATION','当前用户没有明确要求创建提醒。');
    if(args.explicitTime!==undefined&&args.explicitTime!==true)fail('NEEDS_TIME','请先向用户确认具体提醒时间。');
    const expected=requestedReminderTime(request.text,{now,requestedAt:Date.parse(request.referenceAt)||now});if(!expected.ok)return expected;
    const supplied=parseISO(args.dueAt);if(Math.abs(supplied-expected.at)>(expected.relative?30000:1000))fail('TIME_MISMATCH','解析出的时间与用户原话不一致，请核对北京时间后重试。',{expectedDueAt:new Date(expected.at).toISOString()});
    if(expected.at<=now)fail('TIME_PAST','这个时间已经过去，请向用户确认新的提醒时间。');if(expected.at-now>365*DAY)fail('TIME_TOO_FAR','当前只支持未来365天内的一次性提醒。');
    const channel=target(store,scope,request.text),dueAt=new Date(expected.at).toISOString();
    const key=createHash('sha256').update(JSON.stringify([scope.assistantId,owner,request.user.id,dueAt,channel])).digest('hex');
    const existing=store.state.tasks.find(t=>t.idempotencyKey===key&&owns(t,scope,owner));if(existing){if(existing.status==='cancelled')fail('REQUEST_CANCELLED','这条请求已经取消；需要重新安排时，请用户发送新的提醒指令。');return {ok:true,duplicate:true,task:publicTask(existing),timeZone:ZONE};}
    const at=new Date(now).toISOString(),task={id:randomUUID(),assistantId:scope.assistantId,chatId:scope.chatId,ownerId:owner,title:args.title.trim(),dueAt,channel,status:'pending',source:'natural_language',timeZone:ZONE,requestMessageId:request.user.id,idempotencyKey:key,createdAt:at,confirmedAt:at,logs:[{at,text:'用户在聊天中明确指定时间与内容，已授权创建一次性提醒。'}]};
    store.state.tasks.unshift(task);store.save();return {ok:true,task:publicTask(task),timeZone:ZONE,deliveryNotice:channel==='web'?'到时写入本应用收件箱；需要后台持续运行。':'到时交给已验证的接收渠道；接口接受发送不代表用户已读。'};
  }catch(error){return failure(error.code||'TASK_UNAVAILABLE',error.code?error.message:'定时工具当前无法执行，请稍后重试。',error.extra);}
}
