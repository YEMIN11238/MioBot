import {randomUUID,createHash} from 'node:crypto';
import {requestedReminderTime} from './scheduled-tools.mjs';

export const WORKFLOW_TOOL_NAMES=['schedule_workflow','list_workflows','cancel_workflow'];
const OWNER='local-user',ZONE='Asia/Shanghai',DAY=86400000,MAX_RESULT=8000;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
const copy=x=>structuredClone(x),hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const text=(value,label,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail(label+'需要1到'+max+'字',400);return value.trim();};
const iso=at=>new Date(at).toISOString();
function fields(value,allowed){if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('提交包含不支持的任务字段',400);}

export function normalizeWorkflowSchedule(value,{now=Date.now(),allowPast=false}={}){
  fields(value,['type','runAt','time','weekdays','timezone']);
  if(value.timezone!==undefined&&value.timezone!==ZONE)fail('当前任务统一按北京时间安排',400);
  if(value.type==='once'){
    if(typeof value.runAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|\+08:00)$/.test(value.runAt))fail('请选择带时区的一次性时间',400);
    const at=Date.parse(value.runAt),parts=value.runAt.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/).slice(1).map(Number),local=new Date(at+(value.runAt.endsWith('Z')?0:8*3600000));if(parts[0]!==local.getUTCFullYear()||parts[1]!==local.getUTCMonth()+1||parts[2]!==local.getUTCDate()||parts[3]!==local.getUTCHours()||parts[4]!==local.getUTCMinutes()||(parts[5]||0)!==local.getUTCSeconds())fail('日期或时间不存在',400);if(!Number.isFinite(at)||!allowPast&&at<=now||at>now+366*DAY)fail('请选择一年以内的未来时间',400);
    return {type:'once',runAt:iso(at),timezone:ZONE};
  }
  if(!['daily','weekly'].includes(value.type)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time||''))fail('请选择每天或每周的具体时刻',400);
  if(value.type==='daily')return {type:'daily',time:value.time,timezone:ZONE};
  if(!Array.isArray(value.weekdays)||!value.weekdays.length||value.weekdays.length>7||value.weekdays.some(d=>!Number.isInteger(d)||d<1||d>7))fail('请选择每周的执行日',400);
  return {type:'weekly',time:value.time,weekdays:[...new Set(value.weekdays)].sort(),timezone:ZONE};
}

export function nextWorkflowRun(schedule,now=Date.now()){
  if(schedule.type==='once')return Date.parse(schedule.runAt)>now?schedule.runAt:null;
  const d=new Date(now+8*3600000),[h,m]=schedule.time.split(':').map(Number);
  for(let offset=0;offset<8;offset++){
    const at=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+offset,h,m)-8*3600000,weekday=new Date(at+8*3600000).getUTCDay()||7;
    if(at>now&&(schedule.type==='daily'||schedule.weekdays.includes(weekday)))return iso(at);
  }
  return null;
}

function chineseNumber(value){if(/^\d+$/.test(value))return Number(value);const digits={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};if(value.includes('十')){const [a,b]=value.split('十');return (a?digits[a]:1)*10+(b?digits[b]:0);}return digits[value];}
export function requestedWorkflowSchedule(input,{now=Date.now()}={}){
  if(typeof input!=='string'||/取消|停用|不要|别再|假如|假设|举例|例如|[「」“”`]/.test(input))return null;
  if(/每天|每日|工作日|每周|每星期/.test(input)){
    const match=input.match(/(\d{1,2}|[零〇一二两三四五六七八九十]+)(?:[:：](\d\d)|点(半|\d{1,2}分?)?)/);
    if(!match)return null;let h=chineseNumber(match[1]),m=match[2]?Number(match[2]):match[3]==='半'?30:match[3]?Number(match[3].replace('分','')):0;
    if(/下午|晚上|傍晚/.test(input)&&h<12)h+=12;if(h>23||m>59||!Number.isFinite(h+m))return null;
    const time=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
    if(/工作日/.test(input))return {type:'weekly',time,weekdays:[1,2,3,4,5],timezone:ZONE};
    if(/每天|每日/.test(input))return {type:'daily',time,timezone:ZONE};
    const day=input.match(/每(?:周|星期)([一二三四五六日天])/);if(!day||/每(?:周|星期)[一二三四五六日天][、,，至到和]/.test(input))return null;
    return {type:'weekly',time,weekdays:['一二三四五六日'.indexOf(day[1]==='天'?'日':day[1])+1],timezone:ZONE};
  }
  const once=requestedReminderTime(input,{now,requestedAt:now});return once.ok?{type:'once',runAt:iso(once.at),timezone:ZONE}:null;
}

/** Durable host-owned plans and outbox. Native CronJobManager is the only clock. */
export class Workflows{
  constructor({store,runtime,rss,execute,deliver,onNotify=()=>{},isBusy=()=>false,isPaused=()=>false,now=()=>Date.now()}){
    Object.assign(this,{store,runtime,rss,execute,deliver,onNotify,isBusy,isPaused,now});this.running=new Map();this.closed=false;this.syncing=null;this.lastSync=0;this.signature='';this.scheduler={status:'needs_runtime'};
    store.state.workflows||=[];store.state.workflowRuns||=[];
    for(const run of store.state.workflowRuns){
      if(run.status==='running'){
        if(['sending','accepted'].includes(run.deliveryStatus)){run.status='delivery_unknown';run.error='后台在发送期间重启，无法确认是否已送达，不会自动重发。';}
        else{run.status='interrupted';run.error='后台重启中断了这次生成，可检查记录后手动执行。';}
        run.finishedAt=iso(now());
      }
    }
    for(const run of store.state.workflowRuns)if(['failed','interrupted'].includes(run.status)&&run.deliveryStatus==='not_started'&&store.state.assistants.some(a=>a.id===run.assistantId))this.rss.discardPending?.({assistantId:run.assistantId,runId:run.id,save:false});
    store.save();
  }
  assistant(id){const a=this.store.assistant(id);if(!a.enabled)fail('请先启用这位助手');return a;}
  owned(id,assistantId){const w=this.store.state.workflows.find(x=>x.id===id&&x.ownerId===OWNER);if(!w||assistantId&&w.assistantId!==assistantId)fail('找不到这位助手的安排',404);return w;}
  channel(id,assistantId){if(id==='web')return;const c=this.store.state.channels.find(c=>c.id===id);if(!c||c.assistantId!==assistantId||!c.enabled||c.status!=='verified'||!c.supportProactive||!c.target)fail('请选择这位助手已经验证的接收位置');}
  list({assistantId}={}){
    this.assistant(assistantId);
    const items=this.store.state.workflows.filter(w=>w.ownerId===OWNER&&w.assistantId===assistantId).map(w=>({...copy(w),lastRun:copy(this.store.state.workflowRuns.findLast(r=>r.workflowId===w.id)||null)}));
    const ids=new Set(items.map(w=>w.id)),runs=this.store.state.workflowRuns.filter(r=>ids.has(r.workflowId)&&r.ownerId===OWNER).slice(-80).reverse();
    return {items,runs:copy(runs),sources:this.rss.list({assistantId}).items,scheduler:copy(this.scheduler)};
  }
  async create(input){
    fields(input,['requestId','assistantId','title','instruction','kind','schedule','channel','sourceIds','confirmed']);
    if(input.confirmed!==true)fail('请确认这项安排的时间、工作内容和接收位置');
    const assistant=this.assistant(input.assistantId),title=text(input.title,'安排名称',100),instruction=text(input.instruction,'要完成的工作',3000),schedule=normalizeWorkflowSchedule(input.schedule,{now:this.now(),allowPast:true}),channel=input.channel||'web';
    const requestId=text(input.requestId,'请求编号',100);this.channel(channel,assistant.id);
    if(!['agent','rss'].includes(input.kind))fail('请选择定时工作或订阅简报');
    const sourceIds=input.sourceIds||[];if(!Array.isArray(sourceIds)||sourceIds.length>20||sourceIds.some(id=>typeof id!=='string'))fail('订阅源选择无效');
    const allowed=new Set(this.rss.list({assistantId:assistant.id}).items.map(s=>s.id));if(sourceIds.some(id=>!allowed.has(id))||input.kind==='rss'&&!sourceIds.length)fail('请选择属于这位助手的订阅源');
    const definition={assistantId:assistant.id,title,instruction,kind:input.kind,schedule,channel,sourceIds:[...new Set(sourceIds)]},fingerprint=hash(definition),old=this.store.state.workflows.find(w=>w.ownerId===OWNER&&w.requestId===requestId);
    if(old){if(old.fingerprint!==fingerprint)fail('同一个请求编号不能创建不同安排');return {...copy(old),duplicate:true};}
    normalizeWorkflowSchedule(input.schedule,{now:this.now()});
    if(this.store.state.workflows.filter(w=>w.assistantId===assistant.id&&['active','paused'].includes(w.status)).length>=100)fail('这位助手的安排已达100条，请先整理');
    if(this.store.state.workflows.filter(w=>['active','paused'].includes(w.status)).length>=300)fail('当前实例的有效安排已达300条，请先取消不再使用的安排');
    const item={...definition,id:randomUUID(),ownerId:OWNER,requestId,fingerprint,status:'active',revision:1,createdAt:iso(this.now()),bindingStatus:'needs_runtime',nextRunAt:nextWorkflowRun(schedule,this.now())};
    this.store.state.workflows.push(item);try{this.store.save();}catch(e){this.store.state.workflows.pop();throw e;}
    await this.sync({force:true});return copy(item);
  }
  async change(id,input){
    fields(input,['action','assistantId']);const w=this.owned(id,input.assistantId);if(!['pause','resume','cancel'].includes(input.action))fail('不支持的安排操作');
    if(w.status==='cancelled')fail('这项安排已取消，需要重新创建');
    if(input.action==='resume'){this.assistant(w.assistantId);this.channel(w.channel,w.assistantId);if(w.schedule.type==='once'&&Date.parse(w.schedule.runAt)<=this.now())fail('这个时间已经过去，请新建安排或手动执行一次');}
    const priorWorkflow=copy(w),priorRuns=copy(this.store.state.workflowRuns),priorRss=this.rss.snapshotDelivery?.();
    w.status={pause:'paused',resume:'active',cancel:'cancelled'}[input.action];w.revision++;w.updatedAt=iso(this.now());
    for(const run of this.store.state.workflowRuns.filter(r=>r.workflowId===w.id&&r.status==='queued')){run.status='interrupted';run.error='安排已暂停或取消，这次没有执行。';this.rss.discardPending?.({assistantId:run.assistantId,runId:run.id,save:false});}
    try{this.store.save();}catch(e){Object.assign(w,priorWorkflow);this.store.state.workflowRuns=priorRuns;this.rss.restoreDelivery?.(priorRss);throw e;}
    if(input.action!=='resume')for(const [runId,execution] of this.running)if(execution.workflowId===w.id)execution.controller.abort();
    await this.sync({force:true});return copy(w);
  }
  async sync({force=false}={}){
    if(this.closed||this.isPaused())return;
    if(this.runtime.status!=='ready'){this.scheduler={status:'needs_runtime',error:'安排已保存，需要后台引擎运行后才能定时执行。'};return;}
    if(this.syncing)return this.syncing;
    const jobs=this.store.state.workflows.filter(w=>w.ownerId===OWNER&&['active','paused'].includes(w.status)).map(w=>({id:w.id,revision:w.revision,active:w.status==='active',schedule:w.schedule}));
    const signature=hash([this.runtime.token,jobs]);if(!force&&((signature===this.signature&&this.now()-this.lastSync<30000)||(this.scheduler.status==='error'&&this.now()-this.lastSync<15000)))return;
    this.syncing=(async()=>{try{
      const result=await this.runtime.syncWorkflows({namespace:this.store.state.instanceId,jobs});if(result.ready!==true)throw Error('定时后台没有确认就绪');
      for(const w of this.store.state.workflows){const job=result.jobs?.find(j=>j.id===w.id);if(job){w.bindingStatus='ready';w.nextRunAt=job.nextRunAt;delete w.bindingError;if(job.lastError)w.bindingError=String(job.lastError).slice(0,250);}}
      for(const w of this.store.state.workflows)if(w.status==='active'&&w.schedule.type==='once'&&Date.parse(w.schedule.runAt)<this.now()-300000&&!this.store.state.workflowRuns.some(r=>r.workflowId===w.id&&!r.manual)){w.status='missed';w.revision++;w.nextRunAt=null;w.lastError='后台错过了这次执行时间，没有自动补发。请新建时间安排，或确认后执行一次。';}
      this.scheduler={status:'ready'};this.signature=signature;this.lastSync=this.now();this.store.save();
    }catch(e){this.scheduler={status:'error',error:this.runtime.safeError(e)};for(const w of this.store.state.workflows.filter(w=>w.status==='active')){w.bindingStatus='error';w.bindingError=this.scheduler.error;}this.lastSync=this.now();this.store.save();}
    finally{this.syncing=null;}})();return this.syncing;
  }
  enqueue(w,key,scheduledAt,manual=false){
    const prior=this.store.state.workflowRuns.find(r=>r.key===key);if(prior)return {ok:true,run:copy(prior),duplicate:true};
    if(this.store.state.workflowRuns.filter(r=>r.workflowId===w.id&&['queued','running'].includes(r.status)).length>=1)fail('这项工作已有一次执行在排队或进行中');
    const removable=this.store.state.workflowRuns.filter(r=>['completed','failed','interrupted'].includes(r.status));if(removable.length>400){const remove=new Set(removable.slice(0,removable.length-400).map(r=>r.id));this.store.state.workflowRuns=this.store.state.workflowRuns.filter(r=>!remove.has(r.id));}
    const run={id:randomUUID(),key,workflowId:w.id,assistantId:w.assistantId,ownerId:OWNER,revision:w.revision,scheduledAt,manual,status:'queued',deliveryStatus:'not_started',attempt:0,createdAt:iso(this.now()),sources:[]};
    this.store.state.workflowRuns.push(run);try{this.store.save();}catch(e){this.store.state.workflowRuns.pop();throw e;}return {ok:true,run:copy(run)};
  }
  trigger(input){
    fields(input,['workflowId','revision','scheduledAt']);const w=this.owned(input.workflowId);if(w.status!=='active'||w.revision!==input.revision)fail('这次触发已过期或安排已停用');
    const at=Date.parse(input.scheduledAt);if(!Number.isFinite(at)||at>this.now()+1000||this.now()-at>300000)fail('这次触发时间无效或已经错过');
    if(w.schedule.type==='once'){if(at!==Date.parse(w.schedule.runAt))fail('触发时间与已确认安排不一致');}
    else{if(at%60000!==0)fail('周期触发需要对齐已确认的分钟');const d=new Date(at+8*3600000),time=String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0');if(time!==w.schedule.time||w.schedule.type==='weekly'&&!w.schedule.weekdays.includes(d.getUTCDay()||7))fail('这次触发不属于已确认的周期');}
    return this.enqueue(w,w.id+':'+w.revision+':'+iso(at),iso(at));
  }
  manual(id,{requestId,assistantId}={}){
    const w=this.owned(id,assistantId);this.assistant(w.assistantId);this.channel(w.channel,w.assistantId);if(w.status==='cancelled')fail('已取消的安排不能执行');
    text(requestId,'请求编号',100);const prior=this.store.state.workflowRuns.find(r=>r.key==='manual:'+id+':'+requestId);if(prior)return {ok:true,run:copy(prior),duplicate:true};
    if(this.store.state.workflowRuns.some(r=>r.workflowId===id&&r.status==='delivery_unknown'))fail('上次投递结果不明，请先核对接收端，不能直接重复发送');
    if(this.store.state.workflowRuns.filter(r=>r.workflowId===id&&r.manual&&Date.parse(r.createdAt)>this.now()-DAY).length>=10)fail('这项安排今天已手动执行10次，请稍后再试');
    return this.enqueue(w,'manual:'+id+':'+requestId,iso(this.now()),true);
  }
  async tick(){
    if(this.closed||this.isPaused())return;await this.sync();if(this.running.size||this.runtime.status!=='ready'||this.isBusy())return;
    const queue=this.store.state.workflowRuns.filter(r=>r.status==='queued');const run=queue.find((r,i)=>(!r.retryAt||Date.parse(r.retryAt)<=this.now())&&!queue.slice(0,i).some(prior=>prior.assistantId===r.assistantId));if(run)void this.run(run.id).catch(e=>{this.scheduler={status:'error',error:this.runtime.safeError(e)};});
  }
  async run(id){
    if(this.running.size||this.closed)return;const run=this.store.state.workflowRuns.find(r=>r.id===id);if(!run||run.status!=='queued')return;
    const w=this.owned(run.workflowId);if(w.status==='cancelled'||!run.manual&&w.status!=='active'||run.revision!==w.revision){run.status='interrupted';run.error='安排已改变，没有执行这次任务。';this.store.save();return;}
    const controller=new AbortController();this.running.set(id,{workflowId:w.id,controller});run.status='running';run.startedAt??=iso(this.now());run.attempt++;delete run.retryAt;
    try{
      this.store.save();
      this.assistant(w.assistantId);this.channel(w.channel,w.assistantId);
      if(!run.result){
        let feed=null;if(w.kind==='rss'){run.phase='fetching';this.store.save();feed=await this.rss.fetchForTask({assistantId:w.assistantId,sourceIds:w.sourceIds,limit:10,runId:id,signal:controller.signal});controller.signal.throwIfAborted();run.feedKeys=feed.items.map(i=>i.key);run.sources=feed.items.map(i=>({title:i.title,url:i.url,sourceId:i.sourceId}));
          if(!feed.items.length){run.result='订阅源已检查，暂时没有新的内容。';run.noNewItems=true;}
        }
        if(!run.result){run.phase='generating';this.store.save();const result=await this.execute({workflow:copy(w),run:copy(run),feed,signal:controller.signal,controller});controller.signal.throwIfAborted();run.result=text(result.text,'执行结果',MAX_RESULT);if(result.chatId)run.chatId=result.chatId;run.sources=(result.sources?.length?result.sources:run.sources).slice(0,15);run.toolCalls=(result.toolCalls||[]).slice(0,12);}
        run.phase='generated';this.store.save();
      }
      controller.signal.throwIfAborted();if(this.owned(w.id).status==='cancelled'||this.owned(w.id).revision!==run.revision)throw Error('安排已改变，结果没有发送。');
      if(w.channel==='web'){
        const oldRuns=copy(run),oldWorkflow=copy(w),oldNotifications=this.store.state.notifications.slice(),oldChat=this.store.state.chats.find(c=>c.id===run.chatId),oldMessages=oldChat?.messages.slice(),oldRss=this.rss.snapshotDelivery?.();
        const notification={id:'workflow-'+run.id,workflowId:w.id,runId:run.id,...(run.chatId?{chatId:run.chatId}:{}),assistantId:w.assistantId,title:w.title,at:iso(this.now()),read:false,...(run.noNewItems?{silent:true}:{})};
        try{
          if(!this.store.state.notifications.some(n=>n.id===notification.id))this.store.state.notifications.unshift(notification);
          if(oldChat&&!oldChat.messages.some(m=>m.workflowRunId===run.id&&m.role==='assistant'))oldChat.messages.push({id:randomUUID(),role:'assistant',text:run.result,status:'complete',source:'workflow',createdAt:iso(this.now()),workflowRunId:run.id,sources:run.sources});
          if(w.kind==='rss')this.rss.commitDelivery({assistantId:w.assistantId,runId:run.id,itemKeys:run.feedKeys,save:false});
          run.deliveryStatus='inbox';this.complete(w,run);this.store.save();
        }catch(e){Object.assign(run,oldRuns);Object.assign(w,oldWorkflow);this.store.state.notifications=oldNotifications;if(oldChat)oldChat.messages=oldMessages;this.rss.restoreDelivery?.(oldRss);throw e;}
        try{const pushed=await this.onNotify(notification);if(pushed?.failed)throw Error('通知服务未接受推送');}catch(e){run.pushError='结果已在收件箱，手机推送未确认。';this.store.save();}
      }else{
        run.phase='delivering';run.deliveryStatus='sending';this.store.save();
        try{await this.deliver(w,run.result,run.sources);}catch(e){run.status='delivery_unknown';run.error='接收渠道未确认结果，可能已经发送；请核对接收端，不会自动重发。';run.finishedAt=iso(this.now());this.store.save();return;}
        run.deliveryStatus='accepted';
        if(w.kind==='rss')this.rss.commitDelivery({assistantId:w.assistantId,runId:run.id,itemKeys:run.feedKeys,save:false});
        this.complete(w,run);this.store.save();
      }
    }catch(e){
      if(run.deliveryStatus==='inbox'){run.status='completed';run.pushError='结果已在收件箱，通知状态记录未能保存。';}
      else if(['sending','accepted'].includes(run.deliveryStatus)){run.status='delivery_unknown';run.error='投递结果不明，请先检查接收端。';}
      else if(controller.signal.aborted||w.status!=='active'&&!run.manual){run.status='interrupted';run.error='这次工作已停止，未继续发送。';}
      else if(run.attempt<2&&!this.closed){run.status='queued';run.retryAt=iso(this.now()+30000);run.error=this.runtime.safeError(e);}
      else{run.status='failed';run.error=this.runtime.safeError(e);}
      run.finishedAt=iso(this.now());w.lastError=run.error;if(['failed','interrupted'].includes(run.status)&&run.deliveryStatus==='not_started')this.rss.discardPending?.({assistantId:run.assistantId,runId:run.id,save:false});this.store.save();
    }finally{this.running.delete(id);}
  }
  complete(w,run){run.status='completed';delete run.error;delete run.retryAt;run.finishedAt=iso(this.now());w.lastRunAt=run.finishedAt;delete w.lastError;if(w.schedule.type==='once'&&!run.manual){w.status='completed';w.nextRunAt=null;}else w.nextRunAt=nextWorkflowRun(w.schedule,this.now());}
  async tool(scope,name,args){
    try{
      name=String(name).replace(/^miobot_/,'');const chat=this.store.chat(scope.chatId),user=chat.messages.findLast(m=>m.role==='user');
      if(chat.assistantId!==scope.assistantId||!user||user.id!==scope.userMessageId)fail('这次工具请求不属于当前真实消息');
      if(name==='list_workflows'){fields(args,[]);return {ok:true,items:this.list({assistantId:scope.assistantId}).items};}
      if(name==='cancel_workflow'){fields(args,['workflowId']);if(!/取消|停用|停止|别再/.test(user.text))fail('没有找到主人本轮明确取消安排的要求');return {ok:true,workflow:await this.change(args.workflowId,{action:'cancel',assistantId:scope.assistantId})};}
      if(name!=='schedule_workflow')fail('未知任务工具');fields(args,['title','instruction','schedule']);
      const schedule=requestedWorkflowSchedule(user.text,{now:Date.parse(user.createdAt)});if(!schedule)fail('请先说明每天、每周或哪天几点，以及要完成什么工作');
      if(!/搜索|查|搜|整理|汇总|简报|日报|提醒|叫醒|通知/.test(user.text))fail('请明确说出到点需要完成的工作');
      const proposed=normalizeWorkflowSchedule(args.schedule,{now:this.now()});if(JSON.stringify(proposed)!==JSON.stringify(schedule))fail('模型提出的时间与主人原话不一致，安排没有创建');
      const workflow=await this.create({requestId:'message-'+user.id,assistantId:scope.assistantId,title:args.title,instruction:user.text,kind:'agent',schedule,channel:scope.channel||'web',confirmed:true});
      return {ok:true,workflow,notice:workflow.bindingStatus==='ready'?'安排已保存且定时后台已就绪。':'安排已保存，定时后台还未就绪，请在安排页查看状态。'};
    }catch(e){return {ok:false,error:{message:this.runtime.safeError(e)}};}
  }
  close(){this.closed=true;for(const {controller} of this.running.values())controller.abort();}
}
