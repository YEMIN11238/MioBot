import React,{useCallback,useEffect,useRef,useState} from 'react';
import {CalendarClock,Plus,RefreshCw,Pause,Play,X,Check,Rss,ExternalLink,Clock,ChevronDown,Trash2,AlertCircle} from 'lucide-react';
import {api,newRequestId} from './client-api.mjs';
import {freshWorkflowDraft,workflowPayload,workflowView,workflowChannels,workflowDate,workflowSchedule,WORKFLOW_STATUS,WORKFLOW_RUN_STATUS,workflowBindingReady,canRunWorkflow,workflowRuns,publicSourceLink,rssSourcePayload} from './scheduled-workflows-state.mjs';
import './scheduled-workflows.css';

const EMPTY={items:[],runs:[],sources:[],scheduler:null};
export default function ScheduledWorkflows({assistantId,assistants=[],channels=[],deployment,compact=false,instanceId='',onRefresh,onNotice,onDirty}){
  const [view,setView]=useState(EMPTY),[loading,setLoading]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState(''),[open,setOpen]=useState(false),[draft,setDraft]=useState(freshWorkflowDraft),[dirty,setDirty]=useState(false),[runConfirmation,setRunConfirmation]=useState(null),[showEnded,setShowEnded]=useState(false);
  const [sourceForm,setSourceForm]=useState({name:'',url:''}),[sourceOpen,setSourceOpen]=useState(false);
  const scope=instanceId+':'+assistantId,scopeRef=useRef(scope),requestId=useRef(null),sourceRequest=useRef(null),loadVersion=useRef(0),mounted=useRef(true),runningRequest=useRef(new Map());scopeRef.current=scope;
  const assistant=assistants.find(a=>a.id===assistantId),destinations=workflowChannels(channels,assistantId),items=view.items.filter(i=>showEnded||!['cancelled','completed'].includes(i.status)),sourceDirty=sourceForm.url.trim()||sourceForm.name.trim();
  useEffect(()=>{onDirty?.(dirty||!!sourceDirty);},[dirty,sourceDirty]);
  useEffect(()=>()=>onDirty?.(false),[]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;loadVersion.current++;};},[]);
  const load=useCallback(async({signal,quiet=false}={})=>{
    if(!assistantId)return;const startedScope=scope,version=++loadVersion.current;if(!quiet)setLoading(true);
    try{const value=await api('/workflows?assistantId='+encodeURIComponent(assistantId),'GET',undefined,{signal});if(mounted.current&&scopeRef.current===startedScope&&version===loadVersion.current){setView(workflowView(value,assistantId));if(!quiet)setError('');}}
    catch(e){if(e.name!=='AbortError'&&mounted.current&&scopeRef.current===startedScope)setError(e.message||'暂时没能读取安排。');}
    finally{if(mounted.current&&scopeRef.current===startedScope&&!quiet)setLoading(false);}
  },[scope,assistantId]);
  useEffect(()=>{
    setView(EMPTY);setOpen(false);setDirty(false);setDraft(freshWorkflowDraft());setRunConfirmation(null);setSourceForm({name:'',url:''});setBusy('');requestId.current=null;sourceRequest.current=null;runningRequest.current.clear();
    const controller=new AbortController();void load({signal:controller.signal});const refresh=()=>{if(document.visibilityState!=='hidden')void load({signal:controller.signal,quiet:true});};const timer=setInterval(refresh,10000);document.addEventListener('visibilitychange',refresh);
    return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[scope,load]);
  function change(patch){setDraft(current=>({...current,...patch}));setDirty(true);requestId.current=null;setError('');}
  function begin(){setDraft(freshWorkflowDraft());setOpen(true);setDirty(false);requestId.current=null;setError('');}
  function closeForm(){setOpen(false);setDirty(false);requestId.current=null;}
  async function refresh(){await load();await onRefresh?.();}
  async function create(event){
    event.preventDefault();const startedScope=scope;let submitted=false;setError('');setBusy('create');
    try{requestId.current??=newRequestId();const body=workflowPayload(draft,{assistantId,requestId:requestId.current,channels,sources:view.sources});submitted=true;await api('/workflows','POST',body);if(scopeRef.current!==startedScope||!mounted.current)return;closeForm();await refresh();onNotice?.('安排已保存，可在这里查看下次执行时间。');}
    catch(e){if(scopeRef.current===startedScope&&mounted.current)setError(!submitted||e.status?e.message:'创建结果尚未确认，请先刷新列表核对；再次提交会沿用原请求编号。');}
    finally{if(scopeRef.current===startedScope&&mounted.current)setBusy('');}
  }
  async function action(item,action){
    const startedScope=scope;setError('');setBusy(item.id);
    try{await api('/workflows/'+encodeURIComponent(item.id),'PATCH',{action});if(scopeRef.current===startedScope&&mounted.current){await refresh();onNotice?.({pause:'这个安排已暂停。',resume:'这个安排已恢复。',cancel:'这个安排已取消。'}[action]);}}
    catch(e){if(scopeRef.current===startedScope&&mounted.current)setError(e.message);}
    finally{if(scopeRef.current===startedScope&&mounted.current)setBusy('');}
  }
  async function executeNow(item){
    const startedScope=scope;setError('');setBusy(item.id);
    try{if(!runningRequest.current.has(item.id))runningRequest.current.set(item.id,newRequestId());await api('/workflows/'+encodeURIComponent(item.id)+'/run','POST',{requestId:runningRequest.current.get(item.id)});if(scopeRef.current!==startedScope||!mounted.current)return;runningRequest.current.delete(item.id);setRunConfirmation(null);await refresh();onNotice?.('执行请求已提交，结果会保存在记录中。');}
    catch(e){if(scopeRef.current===startedScope&&mounted.current){setError(e.status?e.message:'执行结果尚未确认，请先刷新核对；再次提交会沿用原请求编号。');await load({quiet:true});}}
    finally{if(scopeRef.current===startedScope&&mounted.current)setBusy('');}
  }
  async function addSource(event){
    event.preventDefault();const startedScope=scope;let submitted=false;setError('');setBusy('source');
    try{sourceRequest.current??=newRequestId();const payload=rssSourcePayload(sourceForm,{assistantId,requestId:sourceRequest.current});submitted=true;await api('/rss/sources','POST',payload);if(scopeRef.current!==startedScope||!mounted.current)return;setSourceForm({name:'',url:''});sourceRequest.current=null;await refresh();onNotice?.('来源已保存，任务执行时会读取更新。');}
    catch(e){if(scopeRef.current===startedScope&&mounted.current)setError(!submitted||e.status?e.message:'保存结果尚未确认，请刷新来源列表后核对。');}
    finally{if(scopeRef.current===startedScope&&mounted.current)setBusy('');}
  }
  async function removeSource(source){
    if(!window.confirm('删除订阅来源「'+source.name+'」？使用它的任务可能需要重新配置。'))return;const startedScope=scope;setBusy(source.id);setError('');
    try{await api('/rss/sources/'+encodeURIComponent(source.id)+'?assistantId='+encodeURIComponent(assistantId),'DELETE');if(scopeRef.current===startedScope&&mounted.current){if(open)change({sourceIds:draft.sourceIds.filter(id=>id!==source.id)});await refresh();onNotice?.('来源已删除。');}}
    catch(e){if(scopeRef.current===startedScope&&mounted.current)setError(e.message);}
    finally{if(scopeRef.current===startedScope&&mounted.current)setBusy('');}
  }
  const latest=item=>{const records=workflowRuns(view.runs,item.id);return records.find(r=>['queued','running'].includes(r.status))||records[0]||item.lastRun;};
  return <section className={'scheduled-workflows'+(compact?' swf-compact':'')} aria-label="定时执行与资讯订阅">
    <header className="swf-heading"><div><span className="swf-eyebrow">{assistant?.name||'当前助手'}的安排</span><h2><CalendarClock size={21}/>定时帮你办事</h2><p>设好时间，让助手查资料、整理订阅，并把结果送回来。</p></div><div className="swf-heading-actions"><button type="button" className="swf-button swf-secondary" aria-label="刷新定时任务" disabled={!!busy||loading} onClick={refresh}><RefreshCw size={15} className={loading?'swf-spin':''}/><span>刷新</span></button><button type="button" className="swf-button" disabled={!!busy||open} onClick={begin}><Plus size={16}/>新建安排</button></div></header>
    <p className="swf-runtime-note">{deployment?.mode==='cloud'||deployment?.isServer?'安排由云端后台执行，云端服务需要保持在线。':'当前在本机执行，电脑和应用需要保持运行。'}时间均按北京时间。手机通知还需在设置中授权。</p>
    {view.scheduler&&view.scheduler.status!=='ready'&&<p className="swf-error" role="status"><AlertCircle size={16}/><span>{view.scheduler.error||'任务后台尚未就绪。安排可以先保存，连接后台后请核对执行状态。'}</span></p>}
    {error&&<p className="swf-error" role="alert"><AlertCircle size={16}/><span>{error}</span></p>}
    {open&&<form className="swf-form" onSubmit={create}><div className="swf-form-heading"><h3>安排一件事</h3><button type="button" className="swf-icon" aria-label="关闭新建安排" onClick={closeForm} disabled={!!busy}><X size={19}/></button></div>
      <div className="swf-form-grid"><label className="swf-field">任务名称<input aria-label="定时任务名称" value={draft.title} maxLength={100} required disabled={!!busy} onChange={e=>change({title:e.target.value})} placeholder="例如：每天的科技简报"/></label><label className="swf-field">任务类型<select aria-label="定时任务类型" value={draft.kind} disabled={!!busy} onChange={e=>change({kind:e.target.value})}><option value="agent">交给助手处理</option><option value="rss">整理订阅资讯</option></select></label></div>
      <label className="swf-field">希望助手做什么<textarea aria-label="定时任务要求" rows={3} value={draft.instruction} maxLength={3000} required disabled={!!busy} onChange={e=>change({instruction:e.target.value})} placeholder={draft.kind==='rss'?'从所选来源挑出三条重要更新，简短说明并保留原文链接。':'搜索三条最新科技消息，给出标题、简短摘要和来源链接。'}/></label>
      {draft.kind==='rss'&&<fieldset className="swf-source-choices"><legend>选择订阅来源</legend>{view.sources.length?view.sources.map(s=><label key={s.id}><input type="checkbox" checked={draft.sourceIds.includes(s.id)} disabled={!!busy} onChange={e=>change({sourceIds:e.target.checked?[...draft.sourceIds,s.id]:draft.sourceIds.filter(id=>id!==s.id)})}/><span>{s.name}</span></label>):<p>还没有订阅来源。请先在下方添加公开 RSS / Atom 地址。</p>}</fieldset>}
      <div className="swf-form-grid"><label className="swf-field">什么时候执行<select aria-label="执行频率" value={draft.scheduleType} disabled={!!busy} onChange={e=>change({scheduleType:e.target.value})}><option value="once">只执行一次</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>{draft.scheduleType==='once'?<label className="swf-field">执行时间<input type="datetime-local" aria-label="一次性执行时间" value={draft.runAt} required disabled={!!busy} onChange={e=>change({runAt:e.target.value})}/></label>:<label className="swf-field">北京时间<input type="time" aria-label="每天执行时刻" value={draft.time} required disabled={!!busy} onChange={e=>change({time:e.target.value})}/></label>}</div>
      {draft.scheduleType==='weekly'&&<fieldset className="swf-weekdays"><legend>选择星期</legend>{['一','二','三','四','五','六','日'].map((label,index)=><label key={label}><input type="checkbox" aria-label={'周'+label} checked={draft.weekdays.includes(index+1)} disabled={!!busy} onChange={e=>change({weekdays:e.target.checked?[...draft.weekdays,index+1]:draft.weekdays.filter(d=>d!==index+1)})}/><span>{label}</span></label>)}</fieldset>}
      <label className="swf-field">把结果送到<select aria-label="定时任务接收位置" value={draft.channel} disabled={!!busy} onChange={e=>change({channel:e.target.value})}><option value="web">应用内聊天与收件箱</option>{destinations.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <p className="swf-cost-note">确认后会按计划调用这位助手的模型和已授权工具，可能产生 API 费用。应用内结果可随时查看；锁屏提醒需要手机已允许通知。</p><div className="swf-form-actions"><button type="button" className="swf-button swf-secondary" disabled={!!busy} onClick={closeForm}>取消</button><button type="submit" className="swf-button" disabled={!!busy}><Check size={15}/>{busy==='create'?'正在保存…':'确认创建安排'}</button></div>
    </form>}
    <div className="swf-list-heading"><h3>已安排的任务</h3><label><input type="checkbox" checked={showEnded} onChange={e=>setShowEnded(e.target.checked)}/>显示已结束</label></div>
    {!loading&&!items.length&&<div className="swf-empty"><CalendarClock size={28}/><strong>先交给助手一件小事</strong><p>例如每天八点整理三条你关注的资讯。</p></div>}
    <div className="swf-task-list">{items.map(item=>{const run=latest(item),records=workflowRuns(view.runs,item.id),bindingReady=workflowBindingReady(item);return <article className="swf-task-card" key={item.id}><div className="swf-card-heading"><span className="swf-task-icon">{item.kind==='rss'?<Rss size={19}/>:<CalendarClock size={19}/>}</span><div><h3>{item.title}</h3><p>{workflowSchedule(item.schedule)}</p></div><span className={'swf-status swf-status-'+item.status}>{item.status==='active'&&!bindingReady?'等待后台就绪':WORKFLOW_STATUS[item.status]||'待核对'}</span></div><p className="swf-instruction">{item.instruction}</p><p className="swf-task-meta"><Clock size={13}/>{item.status==='active'?(bindingReady?'下次：'+workflowDate(item.nextRunAt):'执行计划尚未就绪'):WORKFLOW_STATUS[item.status]||'待核对'} · {item.channel==='web'?'应用内收件箱':channels.find(c=>c.id===item.channel)?.name||'原接收位置'}</p>
      {!bindingReady&&item.bindingError&&<p className="swf-error">{item.bindingError}</p>}
      {(item.lastError||run?.status==='delivery_unknown'||run?.deliveryStatus==='unknown')&&<p className="swf-error">{run?.status==='delivery_unknown'||run?.deliveryStatus==='unknown'?'这次送达结果不确定，请先核对接收端，避免重复发送。':item.lastError}</p>}
      <div className="swf-card-actions">{item.status==='active'&&<button type="button" className="swf-text-button" disabled={!!busy} onClick={()=>action(item,'pause')}><Pause size={14}/>暂停</button>}{['paused','draft'].includes(item.status)&&<button type="button" className="swf-text-button" disabled={!!busy} onClick={()=>action(item,'resume')}><Play size={14}/>恢复</button>}{['active','paused','missed'].includes(item.status)&&<button type="button" className="swf-text-button" disabled={!!busy||!canRunWorkflow(item,run)||!!view.scheduler&&view.scheduler.status!=='ready'} onClick={()=>setRunConfirmation(item.id)}><Play size={14}/>{['failed','interrupted'].includes(run?.status)?'重新执行一次':'现在执行一次'}</button>}{!['cancelled','completed'].includes(item.status)&&<button type="button" className="swf-text-button swf-danger" disabled={!!busy} onClick={()=>action(item,'cancel')}><X size={14}/>取消安排</button>}</div>
      {runConfirmation===item.id&&<div className="swf-run-confirm" role="group" aria-label="确认立即执行"><p>现在执行「{item.title}」会调用模型和工具，可能产生 API 费用。原来的时间安排会保留。</p><div><button type="button" className="swf-button swf-secondary" disabled={!!busy} onClick={()=>setRunConfirmation(null)}>先不执行</button><button type="button" className="swf-button" disabled={!!busy||!canRunWorkflow(item,run)||!!view.scheduler&&view.scheduler.status!=='ready'} onClick={()=>executeNow(item)}>{busy===item.id?'正在提交…':'确认执行一次'}</button></div></div>}
      {(records.length>0||run)&&<details className="swf-records"><summary><ChevronDown size={14}/>执行记录{run?' · '+(WORKFLOW_RUN_STATUS[run.status]||'待核对'):''}</summary>{(records.length?records:[run]).slice(0,10).map((record,index)=><RunRecord key={record.id||index} record={record}/>)}</details>}
    </article>})}</div>
    <details className="swf-source-manager" open={sourceOpen} onToggle={e=>{if(e.target===e.currentTarget)setSourceOpen(e.currentTarget.open)}}><summary><Rss size={17}/>订阅来源<span>{view.sources.length} 个</span></summary><p>添加公开的 RSS / Atom 地址。这里只保存来源，执行资讯任务时才读取更新。</p>{view.sources.map(s=><div className="swf-source-row" key={s.id}><div><strong>{s.name}</strong>{publicSourceLink(s.url)?<a href={publicSourceLink(s.url)} target="_blank" rel="noreferrer">{s.url}<ExternalLink size={12}/></a>:<span>来源地址不可用</span>}</div><button type="button" className="swf-icon swf-danger" aria-label={'删除来源'+s.name} disabled={!!busy} onClick={()=>removeSource(s)}><Trash2 size={16}/></button></div>)}<form onSubmit={addSource}><label className="swf-field">来源名称<input value={sourceForm.name} maxLength={100} disabled={!!busy} placeholder="例如：某家公司的官方博客" onChange={e=>{setSourceForm(s=>({...s,name:e.target.value}));sourceRequest.current=null;}}/></label><label className="swf-field">公开 HTTPS 订阅地址<input type="url" aria-label="RSS订阅地址" required value={sourceForm.url} disabled={!!busy} placeholder="https://example.com/feed.xml" onChange={e=>{setSourceForm(s=>({...s,url:e.target.value}));sourceRequest.current=null;}}/></label><button type="submit" className="swf-button swf-secondary" disabled={!!busy||!sourceForm.url.trim()}><Plus size={15}/>{busy==='source'?'正在保存…':'保存订阅来源'}</button></form></details>
  </section>;
}

function RunRecord({record}){
  const text=typeof record.result==='string'?record.result:record.result?.text||record.result?.summary||'',sources=Array.isArray(record.sources)?record.sources:[];
  return <section className="swf-run-record"><header><strong>{WORKFLOW_RUN_STATUS[record.status]||'状态待核对'}</strong><time>{workflowDate(record.startedAt||record.createdAt)}</time></header>{record.error&&<p className="swf-error">{typeof record.error==='string'?record.error:record.error.message||'这次执行未完成。'}</p>}{text&&<p className="swf-run-result">{text}</p>}{sources.length>0&&<ul className="swf-run-sources">{sources.map((s,index)=>{const url=publicSourceLink(s.url||s.link);return <li key={url||index}>{url?<a href={url} target="_blank" rel="noreferrer">{s.title||s.name||'查看来源'}<ExternalLink size={12}/></a>:<span>{s.title||s.name||'来源地址不可用'}</span>}</li>})}</ul>}{record.deliveryStatus&&<small>{({inbox:'结果已保存在应用收件箱，尚不能确认用户已读',accepted:'接收服务已接受，尚不能确认用户已读',delivered:'结果已写入接收位置',unknown:'请先核对接收端，再决定是否重试',sending:'投递进行中，结果尚未确认',not_started:'尚未投递',failed:'未能完成投递',pending:'等待投递'})[record.deliveryStatus]||'投递状态待核对'}</small>}{record.pushError&&<p className="swf-error">{record.pushError}</p>}{record.dedupError&&<p className="swf-error">{record.dedupError}</p>}</section>;
}
