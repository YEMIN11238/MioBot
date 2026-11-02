import {randomUUID} from 'node:crypto';
import {DEFAULT_CARE,conversationalParts} from './assistant-profiles.mjs';
import {proactiveDeliveryKey,PROACTIVE_SOURCE} from '../integrations/proactive/policy.mjs';

const clockParts=now=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(x=>[x.type,x.value]));
const dateKey=now=>{const p=clockParts(now);return `${p.year}-${p.month}-${p.day}`;};
const timestamp=value=>Number.isFinite(Date.parse(value))?Date.parse(value):0;
const successful=message=>message.source==='care'&&!['error','cancelled','streaming'].includes(message.status);
const activation=care=>typeof care.activationId==='string'?care.activationId:'';
const realMessages=chat=>chat.messages.filter(message=>['user','assistant'].includes(message.role)&&typeof message.text==='string'&&!['error','cancelled','streaming'].includes(message.status));
export function quietTime(now,care){care={...DEFAULT_CARE,...care};const hour=Number(clockParts(now).hour);return care.quietStart===care.quietEnd||care.quietStart<care.quietEnd?hour>=care.quietStart&&hour<care.quietEnd||care.quietStart===care.quietEnd:hour>=care.quietStart||hour<care.quietEnd;}

/** User-enabled check-ins. Native policy builds context; only this service schedules and delivers. */
export class CareScheduler{
  constructor(store,runtime,{now=()=>Date.now(),onNotify=()=>{},isBusy=()=>false,deliver=null}={}){
    this.store=store;this.runtime=runtime;this.now=now;this.onNotify=onNotify;this.isBusy=isBusy;this.deliver=deliver;this.running=new Set();this.controllers=new Map();this.closing=false;
    let recovered=false;
    for(const chat of store.state.chats)for(const attempt of chat.careDeliveries||[])if(attempt.status==='sending'){
      attempt.status='uncertain';attempt.error='应用在渠道发送期间停止，接收结果未确认，不会自动重发。';attempt.completedAt=new Date(now()).toISOString();
      attempt.logs||=[];attempt.logs.push({at:attempt.completedAt,text:attempt.error});
      chat.careError=attempt.error;chat.careDeliveryBlock={userMessageId:attempt.userMessageId,activationId:attempt.activationId||'',channelId:attempt.channelId,attemptId:attempt.id};delete chat.careRetryAt;recovered=true;
    }
    if(recovered)store.save();
  }
  safeError(error){return typeof this.runtime.safeError==='function'?this.runtime.safeError(error):'主动关心暂时未能完成，请检查后台与接收渠道。';}
  chats(assistant){return this.store.state.chats.filter(chat=>chat.assistantId===assistant.id);}
  lastCare(assistant){
    const values=this.chats(assistant).flatMap(chat=>[...chat.messages.filter(successful).map(message=>message.createdAt),...(chat.careDeliveries||[]).filter(attempt=>attempt.status==='accepted').map(attempt=>attempt.completedAt||attempt.attemptedAt)]).filter(value=>timestamp(value));
    return values.sort((a,b)=>timestamp(b)-timestamp(a))[0];
  }
  sentToday(assistant){
    const today=dateKey(this.now());return this.chats(assistant).reduce((count,chat)=>count+chat.messages.filter(message=>successful(message)&&timestamp(message.createdAt)&&dateKey(timestamp(message.createdAt))===today).length+(chat.careDeliveries||[]).filter(attempt=>['sending','uncertain','accepted'].includes(attempt.status)&&!attempt.messageId&&!chat.messages.some(message=>message.delivery?.attemptId===attempt.id)&&timestamp(attempt.attemptedAt)&&dateKey(timestamp(attempt.attemptedAt))===today).length,0);
  }
  channel(assistant,care){
    const id=care.deliveryChannel||'web';if(id==='web')return null;
    const channel=this.store.state.channels.find(item=>item.id===id);
    if(!channel||channel.assistantId!==assistant.id||channel.status!=='verified'||channel.enabled!==true||channel.supportProactive!==true||typeof channel.target!=='string'||!channel.target.trim())throw Error('主动关心接收渠道尚未验证、已停用，或不属于当前助手。');
    if(typeof this.deliver!=='function')throw Error('主动关心尚未连接实际渠道投递服务。');
    return channel;
  }
  retry(chat,user,care,delay){chat.careRetryAt=new Date(this.now()+delay).toISOString();chat.careRetryUserId=user.id;chat.careRetryActivationId=activation(care);}
  clearRetry(chat){delete chat.careRetryAt;delete chat.careRetryUserId;delete chat.careRetryActivationId;}
  sameTurn(assistant,chat,user,care,checkQuota=true){
    const latest=realMessages(chat).findLast(message=>message.role==='user'),current={...DEFAULT_CARE,...assistant.care};
    const newest=Math.max(...this.chats(assistant).flatMap(other=>realMessages(other).filter(message=>message.role==='user').map(message=>timestamp(message.createdAt))));
    return !this.closing&&this.runtime.status==='ready'&&assistant.enabled&&current.enabled&&latest?.id===user.id&&newest<=timestamp(user.createdAt)&&!this.chats(assistant).some(other=>this.isBusy(other.id)||other.runStatus==='running')&&!quietTime(this.now(),current)&&this.now()-timestamp(user.createdAt)>=current.idleMinutes*60000&&current.deliveryChannel===care.deliveryChannel&&activation(current)===activation(care)&&(!checkQuota||this.sentToday(assistant)<current.maxPerDay);
  }
  async tick(){
    if(this.closing||this.runtime.status!=='ready')return;
    for(const assistant of this.store.state.assistants){
      const care={...DEFAULT_CARE,...assistant.care};
      if(!assistant.enabled||!care.enabled||this.running.has(assistant.id)||quietTime(this.now(),care))continue;
      const eligible=this.chats(assistant).map(chat=>({chat,user:realMessages(chat).findLast(message=>message.role==='user')})).filter(item=>item.user&&timestamp(item.user.createdAt)).sort((a,b)=>timestamp(b.user.createdAt)-timestamp(a.user.createdAt));
      if(!eligible.length)continue;const {chat,user}=eligible[0];
      if(this.isBusy(chat.id)||chat.runStatus==='running'||this.chats(assistant).some(other=>this.isBusy(other.id)||other.runStatus==='running'))continue;
      const lastCareAt=this.lastCare(assistant);
      if(lastCareAt&&timestamp(lastCareAt)>=timestamp(user.createdAt)||this.now()-timestamp(user.createdAt)<care.idleMinutes*60000||this.sentToday(assistant)>=care.maxPerDay)continue;
      const block=chat.careDeliveryBlock;
      if(block&&block.userMessageId===user.id&&block.activationId===activation(care))continue;
      if(block){delete chat.careDeliveryBlock;this.clearRetry(chat);this.store.save();}
      if(chat.careRetryAt&&(chat.careRetryUserId&&chat.careRetryUserId!==user.id||chat.careRetryActivationId!==undefined&&chat.careRetryActivationId!==activation(care)))this.clearRetry(chat);
      if(chat.careRetryAt&&timestamp(chat.careRetryAt)>this.now())continue;
      this.running.add(assistant.id);const controller=new AbortController();this.controllers.set(assistant.id,controller);let attempt=null,invoked=false;
      try{
        this.channel(assistant,care);
        if(typeof this.runtime.proactivePolicy!=='function')throw Error('主动关心策略插件尚未连接，请准备内置扩展并检查后台。');
        const scope={instanceId:this.store.state.instanceId,assistantId:assistant.id,userId:'local-user',sessionId:chat.id,channelId:care.deliveryChannel||'web'},scopeKey=proactiveDeliveryKey(scope);
        const messages=realMessages(chat).slice(-6).map(message=>({role:message.role,text:message.text.slice(0,1200)}));
        const policy=await this.runtime.proactivePolicy({scope,care,lastUserAt:user.createdAt,...(lastCareAt?{lastCareAt}:{}),sentToday:this.sentToday(assistant),messages,now:new Date(this.now()).toISOString(),assistantName:assistant.name});
        if(!policy||typeof policy.allowed!=='boolean'||policy.scopeKey!==scopeKey||policy.source?.integration!==PROACTIVE_SOURCE.integration||policy.source?.revision!==PROACTIVE_SOURCE.revision||policy.source?.repo!==PROACTIVE_SOURCE.repo||policy.allowed&&(typeof policy.prompt!=='string'||!policy.prompt.trim()||policy.prompt.length>24000))throw Error('主动关心策略返回了无效或会话不匹配的结果，没有生成或发送消息。');
        if(!this.sameTurn(assistant,chat,user,care))continue;
        chat.carePolicy={allowed:policy.allowed,reason:typeof policy.reason==='string'?policy.reason.slice(0,80):'',scopeKey,at:new Date(this.now()).toISOString(),source:{...PROACTIVE_SOURCE}};
        if(!policy.allowed){this.retry(chat,user,care,3600000);this.store.save();continue;}
        const generated=await this.runtime.chat(chat,policy.prompt,{background:true,tools:[],signal:controller.signal});
        if(!this.sameTurn(assistant,chat,user,care))continue;
        if(typeof generated!=='string'||!generated.trim()||generated.length>4000)throw Error('主动关心模型没有返回有效的简短文字，没有发送消息。');
        const text=generated.trim();
        if(text==='<skip>'){this.retry(chat,user,care,86400000);this.store.save();continue;}
        this.channel(assistant,{...DEFAULT_CARE,...assistant.care});
        if(care.deliveryChannel!=='web'){
          attempt={id:randomUUID(),assistantId:assistant.id,chatId:chat.id,userId:'local-user',userMessageId:user.id,activationId:activation(care),channelId:care.deliveryChannel,scopeKey,text,status:'sending',createdAt:new Date(this.now()).toISOString(),attemptedAt:new Date(this.now()).toISOString(),logs:[{at:new Date(this.now()).toISOString(),text:'已交给指定渠道发送，等待接口结果；尚未确认用户收到。'}]};
          chat.careDeliveries||=[];chat.careDeliveries.push(attempt);this.store.save();
          invoked=true;const outcome=await this.deliver(assistant,care.deliveryChannel,text);
          if(!outcome||outcome.status!=='accepted')throw Error('接收渠道没有返回明确的接口接受结果。');
          attempt.status='accepted';attempt.completedAt=new Date(this.now()).toISOString();attempt.logs.push({at:attempt.completedAt,text:'渠道接口已接受发送；不代表用户已收到或已读。'});
        }
        const message=this.store.message(chat.id,'assistant',text,{status:'complete',source:'care',replyTo:user.id,parts:conversationalParts(text,assistant.skills.includes('humanize')),...(attempt?{delivery:{channelId:care.deliveryChannel,status:'accepted',received:false,read:false,attemptId:attempt.id}}:{})});
        if(attempt){attempt.messageId=message.id;attempt.superseded=!this.sameTurn(assistant,chat,user,care,false);}
        const n={id:randomUUID(),assistantId:assistant.id,chatId:chat.id,messageId:message.id,title:text.slice(0,140),at:new Date(this.now()).toISOString(),read:false,type:'care',channel:care.deliveryChannel,...(attempt?{deliveryStatus:'accepted',received:false}:{})};
        this.store.state.notifications.unshift(n);delete chat.careError;delete chat.careDeliveryBlock;this.clearRetry(chat);this.store.save();if(!this.closing&&!attempt?.superseded){try{this.onNotify(n);}catch(error){chat.careNotificationError=this.safeError(error);this.store.save();}}
      }catch(error){
        const message=this.safeError(error);chat.careError=message;
        if(invoked&&attempt){const accepted=attempt.status==='accepted';attempt.status=accepted?'accepted':'uncertain';attempt.completedAt=new Date(this.now()).toISOString();attempt.error=message;attempt.logs.push({at:attempt.completedAt,text:accepted?'渠道已接受发送，但本地归档没有完成，不会重复发送。':'渠道结果未确认；可能未发出，也可能已经发出，不会自动重发。'});chat.careError=message+(accepted?' 渠道已接受发送，但本地归档没有完成，不会重复发送。':' 接收结果未确认，不会自动重发。');chat.careDeliveryBlock={userMessageId:user.id,activationId:activation(care),channelId:care.deliveryChannel,attemptId:attempt.id};this.clearRetry(chat);}
        else this.retry(chat,user,care,3600000);
        this.store.save();
      }finally{this.running.delete(assistant.id);this.controllers.delete(assistant.id);}
    }
  }
  close(){this.closing=true;for(const controller of this.controllers.values())controller.abort();}
}
