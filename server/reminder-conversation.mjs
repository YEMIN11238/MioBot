import {requestedReminderTime} from './scheduled-tools.mjs';

const RECIPIENT=/(提醒我|叫醒我|叫我|喊我|通知我)/;
const HAS_TIME=/\d{1,2}[:：]\d{2}|(?:\d{1,2}|[零〇一二两三四五六七八九十]+)\s*点|(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十半]+)\s*(?:秒|分钟|小时|天)后/;
const WHEN=/今天|今日|今晚|今早|明天|明早|明晚|后天|\d{1,2}月\d{1,2}[日号]?/;
const CLOCK_ONLY=/^(?:(?:早上|上午|中午|下午|傍晚|晚上|凌晨)\s*)?(?:\d{1,2}|[零〇一二两三四五六七八九十]+)\s*(?:[:：]\d{2}|点(?:(?:半|一刻|三刻|\d{1,2}|[零〇一二两三四五六七八九十]+)分?)?)(?:吧|就行|就好)?[。！!？?]*$/;
const PREFIX=/^(?:(?:所以|那就|那|好|对了|哦|嗯|麻烦你|麻烦|请你|请|帮我|你能不能|你可不可以|你可以|你能|你|能不能|可不可以|可以|能)\s*[，,]?\s*)+/;
const usable=message=>message&&['user','assistant'].includes(message.role)&&typeof message.text==='string'&&message.text.trim()&&!['error','cancelled','streaming'].includes(message.status);
function excluded(text){
  const recipient=text.search(RECIPIENT),lead=recipient<0?text:text.slice(0,recipient);
  return /取消|删除/.test(lead)||/(?:不要|不用|别)(?:再)?/.test(lead)||/每(?:天|日|周|星期|月|年|早|晚)|每隔|工作日|循环|重复/.test(lead)||/(?:提醒我|叫醒我|叫我|喊我|通知我)\s*每(?:天|日|周|星期|月|年)/.test(text);
}
function requestIntent(text){
  if(excluded(text)||/什么意思|怎么实现|实现原理|教程|代码/.test(text))return false;
  const short=text.trim().replace(PREFIX,'');
  if(!RECIPIENT.test(short)&&!/(?:设置?|定)(?:一个)?闹钟/.test(short))return false;
  // Only a direct command or an addressed request, not a third-party anecdote.
  const direct=/^(?:提醒我|叫醒我|叫我|喊我|通知我|(?:设置?|定)(?:一个)?闹钟)/.test(short);
  const dated=/^(?:今天|今日|今晚|今早|明天|明早|明晚|后天|\d{1,2}月\d{1,2}[日号]?)/.test(short)&&WHEN.test(short);
  if(!direct&&!dated)return false;
  return dated||!/[吗么][？?]*$/.test(short);
}
function question(text){
  const time=/几点|什么时间|什么时候|具体(?:的)?时间|哪天|哪一天/.test(text);
  return time&&(/叫你|叫醒你|喊你|提醒|闹钟/.test(text)||/^(?:那|你想|要)?(?:明早|明天|今早|今天|今晚|后天)?(?:具体)?几点(?:呢|呀|啊)?[？?。]*$/.test(text.trim()));
}
function ask(text){
  const action=/叫醒我|叫我|喊我/.test(text)?'叫你':'提醒你';
  const day=/明天早上|明天上午|明早/.test(text)?'明早':/后天/.test(text)?'后天':/明天/.test(text)?'明天':/今晚/.test(text)?'今晚':/今天|今日|今早/.test(text)?'今天':'';
  return day?`${day}几点${action}？`:`想让我哪天、几点${action}？`;
}
const reference=message=>({text:message.text,referenceAt:message.createdAt,sourceMessageIds:[message.id]});
const needsTime=(message,text=ask(message.text))=>({type:'NEEDS_TIME',text,request:reference(message)});
function capability(text){
  return /^(?:你|你们|这个助手|这个bot|MioBot)?(?:有|支持|能不能|会不会|可以|能).{0,20}(?:定时(?:提醒)?|提醒我?|闹钟|叫醒我?)[吗么呢？?。]*$/i.test(text)||/^(?:游戏(?:助手)?|你|这个助手|这个bot|MioBot)?(?:该|要)?(?:怎么|如何)(?:使用|设置|用)?(?:定时(?:提醒)?|提醒|闹钟)(?:功能)?[吗么呢？?。]*$/i.test(text)||/^(?:定时提醒|提醒|闹钟)(?:功能)?(?:怎么用|怎么设置|有吗|支持吗)[？?。]*$/.test(text);
}
function taskReceipt(message){
  return typeof message.taskId==='string'&&message.taskId&&(message.source==='reminder'||message.toolCalls?.some(call=>['schedule_reminder','miobot_schedule_reminder'].includes(call.name)&&call.ok===true));
}

/**
 * Pure conversation routing only. The host checks actual assistant/global
 * permissions and task state, and the normal task tool still verifies consent
 * and time. A READY result contains real historical text, never a fake user.
 */
export function recognizeReminderConversation(chat,user,{now=Date.now()}={}){
  if(!Array.isArray(chat?.messages)||typeof user?.id!=='string')return null;
  const index=chat.messages.findLastIndex(message=>message.id===user.id&&message.role==='user');
  const current=chat.messages[index];
  if(index<0||!usable(current)||current.text!==user.text||chat.messages.findLast(message=>message.role==='user')?.id!==user.id)return null;
  const text=current.text.trim();
  if(excluded(text))return null;
  const history=chat.messages.slice(0,index).filter(message=>message&&['user','assistant'].includes(message.role)&&typeof message.text==='string'&&message.text.trim()),previous=history.at(-1);
  const prior=previous?.role==='assistant'?history.slice(0,-1).findLast(message=>message.role==='user'):null;
  const clarification=previous?.role==='assistant'&&usable(previous)&&usable(prior)&&requestIntent(prior.text)&&!HAS_TIME.test(prior.text)&&question(previous.text);

  if(/^[？?]+$/.test(text)){
    if(clarification)return needsTime(prior);
    if(previous?.role==='assistant'&&usable(previous)&&taskReceipt(previous))return {type:'TASK_REFERENCE',taskId:previous.taskId,text:'你是想改刚才那条提醒的时间，还是问我到时怎么提醒你？'};
    return null;
  }
  if(clarification&&CLOCK_ONLY.test(text)){
    const combined=prior.text+' '+current.text,requestedAt=Date.parse(prior.createdAt);
    if(!Number.isFinite(requestedAt))return null;
    const parsed=requestedReminderTime(combined,{now,requestedAt});
    if(!parsed.ok&&!['NEEDS_DATE'].includes(parsed.error?.code))return null;
    return {type:'READY',request:{text:combined,referenceAt:prior.createdAt,sourceMessageIds:[prior.id,current.id]}};
  }
  if(requestIntent(text))return HAS_TIME.test(text)?null:needsTime(current);
  return capability(text)?{type:'CAPABILITY'}:null;
}
