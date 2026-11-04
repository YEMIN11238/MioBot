/** Mobile presentation helpers; all dates use the assistant's Beijing timezone. */
export const MOBILE_TASK_STATUSES={draft:'待确认',pending:'待提醒',sending:'发送中',paused:'已暂停',done:'已投递',cancelled:'已取消',failed:'未送达',overdue:'已过期'};
const parts=value=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).map(p=>[p.type,p.value]));
export function beijingInput(value=Date.now()){const p=parts(value);return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
export function reminderISO(value){if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw Error('请选择有效的提醒时间');const date=new Date(value+':00+08:00');if(!Number.isFinite(date.getTime())||beijingInput(date)!==value)throw Error('请选择有效的提醒时间');return date.toISOString();}
export function mobileTime(value){return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value));}
export function mobileDate(value){return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric'}).format(new Date(value));}
export function groupMobileTasks(tasks,assistantId,{now=Date.now(),includeFinished=false}={}){
  const today=beijingInput(now).slice(0,10),tomorrow=beijingInput(now+86400000).slice(0,10),groups=new Map();
  for(const task of tasks.filter(t=>t.assistantId===assistantId&&(includeFinished||!['done','cancelled'].includes(t.status))).sort((a,b)=>Date.parse(a.dueAt)-Date.parse(b.dueAt))){
    if(!Number.isFinite(Date.parse(task.dueAt)))continue;
    const day=beijingInput(task.dueAt).slice(0,10),label=['done','cancelled'].includes(task.status)?'已结束':day<today?'需要处理':day===today?'今天':day===tomorrow?'明天':mobileDate(task.dueAt);
    if(!groups.has(label))groups.set(label,[]);groups.get(label).push(task);
  }
  return [...groups].map(([label,items])=>({label,items}));
}
export function pendingSubmissionState(data,pending){
  if(!pending)return {status:'none'};
  if(data?.instanceId!==pending.instanceId)return {status:'other-instance'};
  const chat=data.chats?.find(c=>c.id===pending.chatId),user=chat?.messages?.find(m=>m.role==='user'&&m.requestId===pending.requestId);
  if(!user)return {status:'unknown'};
  const reply=chat.messages.findLast(m=>m.role==='assistant'&&m.replyTo===user.id);
  return {status:'accepted',userId:user.id,replyId:reply?.id,finished:!!reply&&['complete','error','cancelled'].includes(reply.status)};
}

/** An acknowledgement may arrive after the user has started a different draft. */
export function clearAcknowledgedDraft(drafts,pending){
  if(!pending?.instanceId||!pending.assistantId)return drafts;
  const key=pending.instanceId+':'+pending.assistantId,original=pending.draftText??pending.text;
  if(typeof original!=='string'||drafts[key]!==original)return drafts;
  return {...drafts,[key]:''};
}

/** A queued POST is never portable between backend instances. */
export function submissionBelongsToBackend(submission,instanceId){return !!submission&&typeof instanceId==='string'&&!!instanceId&&submission.instanceId===instanceId;}
