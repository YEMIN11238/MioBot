import React, {useState, useEffect, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {MessageCircle, CalendarClock, BookOpen, Puzzle, Settings, Plus, Search, ArrowUp, Paperclip, Mic, X, Check, Clock, ChevronRight, Gamepad2, Briefcase, Pencil, Sparkles, Bell, Trash2, Play, Pause, Monitor, Globe, FileText, Volume2, Smile, MoreHorizontal, LoaderCircle, RefreshCw, Info, ArrowRight, Inbox, Square, Link2} from 'lucide-react';
import ConnectionSettings from './ConnectionSettings.jsx';
import CloudDeploymentPanel from './CloudDeploymentPanel.jsx';
import ExtensionsPanel from './ExtensionsPanel.jsx';
import FileAttachmentPicker from './FileAttachmentPicker.jsx';
import MessageAttachments from './ExtensionMedia.jsx';
import ChatText,{ReferenceSources} from './ChatText.jsx';
import {SearchAvailabilityNotice} from './BundledCapabilities.jsx';
import {OPTIONAL_SKILL_IDS} from './bundled-ui.mjs';
import {extensionItems,extensionUsable,sourceURL} from './extensions-api.mjs';
import FollowingBot from './FollowingBot.jsx';
import AssistantCapabilities from './AssistantCapabilities.jsx';
import AboutMioBot from './AboutMioBot.jsx';
import {productText} from '../shared/product-text.mjs';
import {applyChatStreamEvent,belongsToActiveStream} from './chat-stream.mjs';
import './style.css';
import './native.css';
import './experience.css';

async function api(path, method='GET', body) {
  const r = await fetch('/api'+path, {method, headers:{'X-Personal-Agent':'1','Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
  const j = await r.json();
  if (!r.ok) throw new Error(productText(j.error || '操作未完成'));
  return j;
}
const time = value => new Date(value).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
const localInput = value => {const d=new Date(value);return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const statusNames = {draft:'待确认',pending:'待执行',sending:'发送中',paused:'已暂停',done:'已投递',cancelled:'已取消',failed:'发送失败',overdue:'已过期'};
const kindIcons = {game:Gamepad2,career:Briefcase};
const skillNames={memory:'手动记忆',reminders:'定时提醒',humanize:'拟人聊天',long_memory:'长期记忆',minecraft:'我的世界工具',voice:'语音回复',stickers:'私有表情',web:'网页检索',files:'文件阅读'};
const currentView = () => {try{return JSON.parse(sessionStorage.getItem('personal-agent-view')) || {};}catch{return {};}};

function Avatar({kind='daily',small=false}) {
  const Icon=kindIcons[kind];
  return <span className={`avatar ${kind} ${small?'small':''}`}>{Icon?<Icon size={small?19:29} strokeWidth={1.9}/>:<span className="orb"><i/><i/></span>}</span>;
}
function Badge({children,tone='purple'}) {return <span className={'badge '+tone}>{children}</span>;}
function Button({children,secondary=false,danger=false,className='',...props}) {return <button className={`button ${secondary?'secondary':''} ${danger?'danger':''} ${className}`} {...props}>{children}</button>;}
function Empty({icon:Icon=Sparkles,title,children,action}) {return <div className="empty"><span className="empty-icon"><Icon size={31}/></span><h3>{title}</h3><p>{children}</p>{action}</div>;}
function ToolEvidence({calls}) {
  const labels={schedule:'创建提醒',list:'查询提醒',cancel:'取消提醒',recipe_lookup:'查询合成配方',item_lookup:'查询物品资料',search_web:'检索网页',read_file:'读取文件',speak:'生成语音',voice_reply:'生成语音',send_sticker:'发送表情',list_stickers:'查询私有图库',create_reminder:'创建提醒',schedule_reminder:'创建提醒',list_reminders:'查询提醒',update_reminder:'修改提醒',cancel_reminder:'取消提醒'};
  return <details className="tool-evidence"><summary>工具执行记录 · {calls.length} 次</summary>{calls.map((call,index)=>{const name=String(call.name||'').replace(/^miobot_/,''),source=sourceURL(call.source?.url);return <p key={index}>{call.ok?'执行成功':'执行未完成'} · {labels[name]||'工具调用'}{call.version&&['recipe_lookup','item_lookup'].includes(name)?' · Java '+call.version:''}{source&&<> · <a href={source} target="_blank" rel="noreferrer">资料来源</a></>}</p>;})}</details>;
}
function ChatTaskLink({task,onOpen}) {
  if(!task)return null;
  const needsAttention=['draft','paused','failed','overdue','cancelled'].includes(task.status);
  return <button type="button" className={'chat-task-link '+(['failed','overdue'].includes(task.status)?'needs-attention':'')} title={time(task.dueAt)+' · '+task.title+' · 查看提醒详情'} onClick={()=>onOpen(task.id)}><Clock size={13}/><span>{time(task.dueAt)} · {task.title}{needsAttention?' · '+statusNames[task.status]:''}</span><span className="chat-task-link-action">查看<ChevronRight size={12}/></span></button>;
}
function Modal({title,onClose,children,wide=false}) {
  const ref=useRef();
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{const previous=document.activeElement;ref.current?.querySelector('input,textarea,button')?.focus();const fn=e=>{
    if([...document.querySelectorAll('.modal-backdrop .modal')].at(-1)!==ref.current)return;
    if(e.key==='Escape')close.current();
    if(e.key==='Tab'){const fields=[...ref.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')].filter(n=>n.getClientRects().length);const first=fields[0],last=fields.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  };window.addEventListener('keydown',fn);return()=>{window.removeEventListener('keydown',fn);previous?.focus?.();};},[]);
  return <div className="modal-backdrop" onClick={onClose}><section ref={ref} role="dialog" aria-modal="true" aria-label={title} className={'modal '+(wide?'wide':'')} onClick={e=>e.stopPropagation()}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={onClose}><X/></button></header>{children}</section></div>;
}

function App() {
  const [data,setData]=useState(null),[deployment,setDeployment]=useState(null), [page,setPage]=useState(currentView().page || 'chat');
  const [assistantId,setAssistantId]=useState(currentView().assistantId || 'daily'), [chatId,setChatId]=useState(currentView().chatId || null);
  const [message,setMessage]=useState(''), [sending,setSending]=useState(false), [stream,setStream]=useState(null), [busy,setBusy]=useState(false);
  const [toast,setToast]=useState(''), [modal,setModal]=useState(null), [discardAction,setDiscardAction]=useState(null), [editor,setEditor]=useState(null), [taskId,setTaskId]=useState(null), [memoryId,setMemoryId]=useState(null);
  const [filter,setFilter]=useState('all'), [query,setQuery]=useState(''), [scope,setScope]=useState('current');
  const [settingsTab,setSettingsTab]=useState('runtime'), [extensionFocus,setExtensionFocus]=useState(null), [fatal,setFatal]=useState(''), [connectionError,setConnectionError]=useState(''), [checkedAt,setCheckedAt]=useState(null);
  const [extensionModules,setExtensionModules]=useState([]),[filesByAssistant,setFilesByAssistant]=useState({}),[stickersByAssistant,setStickersByAssistant]=useState({}),[voiceRequested,setVoiceRequested]=useState(false);
  const scroll=useRef(), lastNotification=useRef(''), dirty=useRef(false), activeRequest=useRef(null);

  async function refresh() {
    const [stateResult,deploymentResult,extensionsResult]=await Promise.allSettled([api('/state'),api('/deployment'),api('/extensions')]);
    if(extensionsResult.status==='fulfilled')setExtensionModules(extensionItems(extensionsResult.value));
    if(deploymentResult.status==='fulfilled')setDeployment(deploymentResult.value);
    if(stateResult.status==='rejected')throw stateResult.reason;
    const d=stateResult.value;setData(d);setFatal('');setConnectionError('');setCheckedAt(Date.now());return d;
  }
  useEffect(()=>{refresh().catch(e=>setFatal(e.message));const id=setInterval(()=>refresh().catch(e=>setConnectionError(e.message)),2500);return()=>clearInterval(id);},[]);
  useEffect(()=>{sessionStorage.setItem('personal-agent-view',JSON.stringify({page,assistantId,chatId}));},[page,assistantId,chatId]);
  useEffect(()=>{setVoiceRequested(false);},[assistantId,deployment?.mode,deployment?.cloud?.url]);
  useEffect(()=>{setFilesByAssistant({});setStickersByAssistant({});},[deployment?.mode,deployment?.cloud?.url]);
  useEffect(()=>{if(!toast)return;const id=setTimeout(()=>setToast(''),6000);return()=>clearTimeout(id);},[toast]);
  useEffect(()=>{scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:'smooth'});},[data?.chats.find(x=>x.id===chatId)?.messages.length,stream?.text,sending]);
  useEffect(()=>{const n=data?.notifications[0];if(n&&lastNotification.current&&n.id!==lastNotification.current)setToast('提醒：'+n.title);if(n)lastNotification.current=n.id;},[data?.notifications[0]?.id]);
  useEffect(()=>{if(data&&!data.assistants.some(a=>a.id===assistantId)){setAssistantId(data.assistants[0]?.id);setChatId(null);}},[data?.instanceId,data?.assistants.map(a=>a.id).join('\u0000'),assistantId]);

  async function act(fn,success) {
    try {setBusy(true);const r=await fn();await refresh();if(r?.syncWarnings?.length)setToast('修改已保存；部分渠道同步失败，请到消息渠道查看。');else if(success)setToast(typeof success==='function'?success(r):success);return r;}
    catch(e){setToast(e.message);return null;}finally{setBusy(false);}
  }
  function leave(action) {if(dirty.current){setDiscardAction(()=>action);return;}action();}
  function navigate(next,tab) {leave(()=>{setPage(next);setFilter('all');setQuery('');setEditor(null);if(tab)setSettingsTab(tab);});}
  function configureExtension(id){if(id==='web'){navigate('settings','search');return;}leave(()=>{setExtensionFocus(id);setPage('extensions');setEditor(null);});}
  function chooseAssistant(id) {leave(()=>{setAssistantId(id);setChatId(data.chats.find(c=>c.assistantId===id)?.id || null);setPage('chat');setEditor(null);});}
  async function startChat(id=assistantId) {
    if(!data.assistants.find(a=>a.id===id)?.enabled){setToast('请先在助手管理中开启这个助手');return;}
    leave(async()=>{const c=await act(()=>api('/chats','POST',{assistantId:id}));if(c){setAssistantId(id);setChatId(c.id);setPage('chat');}});
  }
  function editAssistant(a) {leave(()=>{setEditor({...a});setPage('assistants');});}

  async function runChat(id,text,retry=false,extras={}) {
    const requestId=crypto.randomUUID();activeRequest.current={chatId:id,requestId};setStream({chatId:id,text:'',parts:[],stage:'正在回复…'});
    let accepted=false,terminal=false;
    try {
      const response=await fetch(`/api/chats/${id}/${retry?'retry/stream':'messages/stream'}`,{method:'POST',headers:{'X-Personal-Agent':'1','Content-Type':'application/json'},body:JSON.stringify({text,requestId,...extras})});
      if(!response.ok){const e=await response.json();throw new Error(e.error || '发送失败');}
      accepted=true;if(!retry){setMessage('');if(extras.fileIds?.length)setFilesByAssistant(previous=>({...previous,[assistantId]:(previous[assistantId]||[]).filter(item=>!extras.fileIds.includes(item.id))}));if(extras.stickerIds?.length)setStickersByAssistant(previous=>({...previous,[assistantId]:(previous[assistantId]||[]).filter(item=>!extras.stickerIds.includes(item.id))}));setVoiceRequested(false);}await refresh();
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      const consume=async block=>{
        for(const line of block.split('\n'))if(line.startsWith('data:')){
          let event;try{event=JSON.parse(line.slice(5).trim());}catch{continue;}
          setStream(s=>applyChatStreamEvent(s,event));
          if(['done','error','cancelled'].includes(event.type)){terminal=true;if(event.type==='error')setToast(event.error || event.message?.text || '回复失败，可以重试');await refresh();}
        }
      };
      while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let pos;while((pos=buffer.indexOf('\n\n'))!==-1){await consume(buffer.slice(0,pos));buffer=buffer.slice(pos+2);}}
      if(buffer.trim())await consume(buffer);
      if(!terminal)throw new Error('回复连接中断，请检查后台后重试');
    }catch(e){setToast(e.message);if(accepted)await refresh().catch(()=>{});}
    finally{activeRequest.current=null;setStream(null);setSending(false);}
  }
  async function send(e) {
    e?.preventDefault();if(data?.chats.find(c=>c.id===chatId)?.origin==='channel'){setToast('请在原聊天渠道继续，或新建应用内对话。');return;}if((!message.trim()&&!draftFiles.length&&!draftStickers.length)||sending||data?.chats.find(c=>c.id===chatId)?.runStatus==='running')return;
    if(draftFiles.length&&!filesReady){setToast('请先启用文件阅读，并允许当前助手使用。');return;}
    if(draftStickers.length&&!stickersReady){setToast('请先启用私有表情图库，并允许当前助手使用。');return;}
    if(voiceRequested&&!voiceReady){setToast('语音回复当前不可用，请检查扩展配置和助手权限。');return;}
    const text=message.trim()||(draftFiles.length?'请阅读我附上的文件。':'请使用我选中的表情回复。');setSending(true);
    try{let id=chatId;if(!id||data.chats.find(c=>c.id===id)?.assistantId!==assistantId){const c=await api('/chats','POST',{assistantId});id=c.id;setChatId(id);}await runChat(id,text,false,{fileIds:draftFiles.map(item=>item.id),stickerIds:draftStickers.map(item=>item.id),...(voiceRequested?{voice:true}:{})});}
    catch(e){setToast(e.message);setSending(false);}
  }
  async function retryChat() {if(sending||!chatId||data?.chats.find(c=>c.id===chatId)?.origin==='channel')return;setSending(true);await runChat(chatId,undefined,true);}
  async function cancelChat() {const r=activeRequest.current || (chatId?{chatId}:null);if(r)await act(()=>api(`/chats/${r.chatId}/cancel`,'POST',{requestId:r.requestId}),'已请求停止回复');}
  function taskAction(task,action) {return act(()=>api('/tasks/'+task.id,'PATCH',{action}),action==='confirm'?'提醒已确认，执行结果可在任务记录查看':'任务已更新');}

  if(!data&&deployment?.mode==='cloud')return <main className="cloud-offline-entry"><h2>MioBot · 云端连接</h2><p>{fatal||connectionError||'暂时无法读取云端记录。你可以在这里重新连接，或切回本机；不会把旧数据当作最新结果。'}</p><CloudDeploymentPanel deployment={deployment} onChanged={refresh} onError={setFatal} onNotice={setToast}/></main>;
  if(!data)return <main className="loading"><span className="orb"><i/><i/></span><h2>MioBot</h2><p>{fatal || '正在准备你的私人助手…'}</p>{fatal&&<Button onClick={()=>location.reload()}>重试</Button>}</main>;
  const assistant=data.assistants.find(a=>a.id===assistantId) || data.assistants[0];
  const chat=data.chats.find(c=>c.id===chatId),channelRecord=chat?.origin==='channel', connections=data.modelConnections || [], channels=data.channels || [];
  const resolveConnection=(a,c)=>connections.find(x=>x.id===(c?.connectionId || a?.defaultConnectionId || data.settings.defaultConnectionId));
  const connection=resolveConnection(assistant,chat), runtimeReady=data.runtime.status==='ready'&&(deployment?.mode!=='cloud'||deployment.cloud?.online===true), ready=runtimeReady&&!!connection;
  const draftFiles=filesByAssistant[assistantId]||[],draftStickers=stickersByAssistant[assistantId]||[],filesReady=extensionUsable(extensionModules,assistant,'files'),stickersReady=extensionUsable(extensionModules,assistant,'stickers'),voiceReady=extensionUsable(extensionModules,assistant,'voice');
  const fullCloud=deployment?.mode==='cloud',runLocation=fullCloud?'云端后台':data.settings.location==='local'?'本机运行':'本机运行 · 远程对话';
  const unread=data.notifications.filter(n=>!n.read).length, activeStream=stream?.chatId===chatId;
  const recent=data.chats.filter(c=>c.assistantId===assistantId);
  const scoped=item=>scope==='all' || item.assistantId===assistantId;
  const pendingTasks=data.tasks.filter(t=>t.assistantId===assistantId&&t.status==='pending').sort((a,b)=>Date.parse(a.dueAt)-Date.parse(b.dueAt));
  const filteredTasks=data.tasks.filter(t=>scoped(t)&&(filter==='all'||t.status===filter)&&t.title.includes(query));
  const task=filteredTasks.find(t=>t.id===taskId) || filteredTasks[0];
  const filteredMemories=data.memories.filter(m=>scoped(m)&&(filter==='all'||m.category===filter)&&m.content.includes(query));
  const memory=filteredMemories.find(m=>m.id===memoryId) || filteredMemories[0];
  const selectedMemories=data.memories.filter(m=>m.assistantId===assistantId||m.shared);
  const modelLabel=connection ? connection.name+' · '+connection.model : '选择模型';
  const readiness=a=>!a.enabled?'已暂停':!resolveConnection(a)?'待选择模型':!runtimeReady?'后台未连接':resolveConnection(a)?.validation?.status==='available'?'已就绪，可以直接聊':'模型待测试';
  const channelName=id=>id==='web'?'应用收件箱':channels.find(c=>c.id===id)?.name || '未连接渠道';
  const canRetry=!channelRecord&&chat?.messages.length&&!sending&&['error','cancelled'].includes(chat.messages.at(-1)?.status || chat.messages.at(-1)?.role);

  function formSubmit(type) {return async e=>{
    e.preventDefault();const f=Object.fromEntries(new FormData(e.currentTarget));let result;
    if(type==='assistant')result=await act(()=>api('/assistants','POST',f),'助手已创建，请选择模型');
    if(type==='memory')result=await act(()=>api('/memories','POST',{...f,shared:false}),'记忆已保存');
    if(type==='task')result=await act(()=>api('/tasks','POST',{...f,dueAt:new Date(f.dueAt).toISOString()}),'任务草稿已保存，请确认后执行');
    if(result){setModal(null);if(type==='task'){setTaskId(result.id);navigate('tasks');}if(type==='memory'){setMemoryId(result.id);navigate('memory');}if(type==='assistant'){setAssistantId(result.id);setEditor({...result});setPage('assistants');}}
  };}
  const assistantSelect=(name='assistantId',value=assistantId)=><label>所属助手<select name={name} defaultValue={value}>{data.assistants.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>;
  const scopeSelect=<select className="scope-select" aria-label="数据范围" value={scope} onChange={e=>leave(()=>{setScope(e.target.value);setTaskId(null);setMemoryId(null);})}><option value="current">{assistant.name}</option><option value="all">全部助手</option></select>;
  const modelOptions=<><option value="">默认：{resolveConnection(assistant)?.name || '未选择模型'}</option>{connections.map(c=><option key={c.id} value={c.id}>{c.name} · {c.model}</option>)}</>;

  return <div className="desktop">
    <div className="native-titlebar" aria-hidden="true"><span className="native-window-title">MioBot</span><span className="native-window-status"><i className={'dot '+(runtimeReady?'green':'gray')}/>{runLocation}</span></div>
    <div className="app-shell">
      <nav className="rail" aria-label="主导航">
        <button className="brand-orb" aria-label="我的助手" title="我的助手" onClick={()=>navigate('assistants')}><FollowingBot/></button>
        <div className="rail-links">{[['chat','聊天',MessageCircle],['tasks','任务',CalendarClock],['memory','记忆',BookOpen],['extensions','扩展',Puzzle]].map(([id,label,Icon])=><button key={id} title={label} aria-label={label} className={page===id?'selected':''} onClick={()=>navigate(id)}><Icon size={24}/><span>{label}</span></button>)}<button className={'rail-inbox '+(unread?'has-unread':'')} aria-label={'收件箱'+(unread?'，'+unread+'条未读':'')} onClick={()=>setModal('inbox')}><Inbox size={24}/><span>收件箱</span>{unread>0&&<b>{unread>99?'99+':unread}</b>}</button></div>
        <button className={'rail-setting '+(page==='settings'?'selected':'')} onClick={()=>navigate('settings')}><Settings size={24}/><span>设置</span></button>
      </nav>
      <aside className="sidebar">
        <div className="wordmark"><strong>MioBot</strong><span>你的私人助手</span></div>
        <div className="sidebar-label"><button onClick={()=>navigate('assistants')}>我的助手</button><button className="icon-button" aria-label="创建助手" onClick={()=>setModal('assistant')}><Plus size={17}/></button></div>
        <div className="assistant-list">{data.assistants.map(a=><button key={a.id} className={'assistant-row '+(assistantId===a.id?'active':'')} onClick={()=>chooseAssistant(a.id)}><Avatar kind={a.kind}/><span><strong>{a.name}</strong><small><i className={'dot '+(a.enabled&&runtimeReady&&resolveConnection(a)?'violet':'gray')}/>{readiness(a)}</small></span></button>)}</div>
        <button className="create-assistant" onClick={()=>setModal('assistant')}><Plus size={18}/>创建助手</button>
        <div className="recent"><div className="sidebar-label"><span>{assistant.name}的对话</span><button className="icon-button" aria-label="新建对话" onClick={()=>startChat()}><Plus size={16}/></button></div>{recent.length?recent.slice(0,10).map(c=><button key={c.id} className={'recent-row '+(chatId===c.id?'active':'')} onClick={()=>{setChatId(c.id);navigate('chat');}}><MessageCircle size={17}/><span>{c.title}</span></button>):<div className="recent-empty">第一段对话<br/>会从这里开始。</div>}</div>
        <button className="local-status" onClick={()=>navigate('settings','runtime')}><span className={'dot '+(runtimeReady?'green':'gray')}/><span>{runLocation}<small>{connectionError||fullCloud&&!deployment.cloud?.online?'连接暂时不可用':runtimeReady?'助手服务已连接':'后台待连接'}</small></span><ChevronRight size={15}/></button>
      </aside>
      <main className="workspace">
        {!connectionError&&channels.some(c=>c.status==='error')&&<div className="persistent-warning" role="alert"><Info size={17}/><span>{channels.filter(c=>c.status==='error').length} 个消息渠道有连接或同步错误，请检查后再使用。</span><button onClick={()=>navigate('settings','channels')}>查看渠道</button></div>}{connectionError&&<div className="persistent-warning" role="alert"><Info size={17}/><span>无法刷新后台状态：{connectionError}{checkedAt&&<small>上次成功检查 {time(checkedAt)}</small>}</span><button onClick={()=>refresh().catch(e=>setConnectionError(e.message))}>重新连接</button></div>}
        {page==='chat'&&<div className="chat-page"><section className="chat-main">
          <header className="chat-header"><Avatar kind={assistant.kind}/><div><h2>{assistant.name}</h2><div className="subline"><span className={'dot '+(ready?'violet':'gray')}/>{channelRecord?'外部渠道执行记录':readiness(assistant)}</div></div><div className="chat-header-actions"><label className="model-picker"><span className="sr-only">当前对话模型</span><select aria-label="当前对话模型" value={chat?.connectionId || ''} disabled={sending||channelRecord} onChange={async e=>{const value=e.target.value;if(!chat){const c=await act(()=>api('/chats','POST',{assistantId}));if(c){setChatId(c.id);await act(()=>api('/chats/'+c.id,'PATCH',{connectionId:value||null}));}}else await act(()=>api('/chats/'+chat.id,'PATCH',{connectionId:value||null}));}}>{modelOptions}</select></label><button className="icon-button" title="管理模型" aria-label="管理模型" onClick={()=>navigate('settings','models')}><Settings size={18}/></button><button className="icon-button" title="助手设置" aria-label="助手设置" onClick={()=>editAssistant(assistant)}><MoreHorizontal size={22}/></button></div></header>
          <div className="mobile-assistant-picker"><select aria-label="切换助手" value={assistantId} onChange={e=>chooseAssistant(e.target.value)}>{data.assistants.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select><button onClick={()=>startChat()}><Plus size={15}/>新对话</button></div>
          {connection&&runtimeReady&&<SearchAvailabilityNotice data={data} onConfigure={()=>navigate('settings','search')}/>}<div className="chat-scroll" ref={scroll}>
            {(!chat || !chat.messages.length)&&<><div className="welcome"><div><h1>你好，今天想一起完成什么？</h1><p>聊聊想法，也可以交给我一件事。</p></div><div className="hero-orb"><span className="orb"><i/><i/></span></div></div>
              <div className="connect-hint"><span className="mini-icon"><Sparkles size={24}/></span><div><strong>{!connection?'先连接模型，再开始聊天':!runtimeReady?'连接后台，继续和助手聊天':connection.validation?.status==='available'?'已就绪，可以直接聊':'模型已保存，可以先测试一句话'}</strong><p>{!connection?'跟着首次设置完成模型连接；本机记忆和应用内提醒可以先用。':modelLabel}</p></div><button onClick={()=>navigate('settings',!connection?'setup':!runtimeReady?'runtime':'models')}>{!connection?'开始设置':'查看连接'}<ArrowRight size={16}/></button></div>
              <div className="suggestions">{['两分钟后提醒我休息一下','记忆由你决定，查看已保存的资料'].map((s,i)=><button key={s} onClick={()=>i?navigate('memory'):setMessage(s)}><Sparkles size={17}/>{s}<ArrowRight size={16}/></button>)}</div></>}
            {chat?.messages.filter(m=>!(activeStream&&belongsToActiveStream(m,stream))).map(m=><div className={'message '+m.role+' '+(m.status==='cancelled'?'cancelled':m.status==='error'?'error':'')} key={m.id}>{m.role!=='user'&&<Avatar kind={assistant.kind} small/>}<div className="message-body"><div className="bubble-stack">{(m.parts?.length?m.parts:[m.text||(m.status==='cancelled'?'回复已停止':m.status==='streaming'?'后台正在回复…':'')]).map((part,index)=><div className="bubble" key={index}>{index===0&&(m.role==='error'||m.status==='error')&&<Info size={17}/>}<ChatText text={part}/></div>)}</div><MessageAttachments message={m}/><ReferenceSources sources={m.sources}/>{m.status==='cancelled'&&<small className="chat-delivery-note">已停止 · 可重新尝试</small>}{m.taskId&&<ChatTaskLink task={data.tasks.find(task=>task.id===m.taskId)} onOpen={id=>{setTaskId(id);setModal({type:'task-detail',id});}}/>}</div></div>)}
            {sending&&activeStream&&<div className="message assistant live-reply"><Avatar kind={assistant.kind} small/><div className="message-body"><div className="bubble-stack">{stream.parts?.length?stream.parts.map((part,index)=><div className="bubble delivered-part" key={index}><ChatText text={part}/></div>):<div className="bubble">{stream.text?<ChatText text={stream.text}/>:<span className="stream-status"><LoaderCircle size={15} className="spin"/>正在回复…</span>}</div>}{stream.mode==='parts'&&!stream.finished&&<div className="bubble stream-typing" role="status" aria-label="正在继续回复"><span aria-hidden="true"><i/><i/><i/></span></div>}</div></div></div>}
            {canRetry&&<div className="retry-row"><Button secondary onClick={retryChat}><RefreshCw size={15}/>重试上一条</Button><span>沿用原消息，不重复添加。</span></div>}
          </div>
          {sending&&!activeStream&&<div className="other-chat-running">另一个会话正在回复。<button onClick={()=>{const id=activeRequest.current?.chatId;if(id){setChatId(id);const c=data.chats.find(x=>x.id===id);if(c)setAssistantId(c.assistantId);}}}>查看</button><button onClick={cancelChat}>停止</button></div>}
          {channelRecord&&<div className="channel-record-notice" role="note"><Info size={17}/><div><strong>这是外部聊天渠道的执行记录</strong><p>请在原聊天渠道继续，或新建应用内对话。</p></div><button type="button" disabled={sending} onClick={()=>startChat()}><Plus size={15}/>新建应用内对话</button></div>}<form className={'composer '+(channelRecord?'is-read-only':'')} onSubmit={send}><fieldset className="composer-fieldset" disabled={channelRecord}>{!channelRecord&&(draftFiles.length>0||draftStickers.length>0)&&<div className="composer-attachments">{draftFiles.map(item=><span className="composer-attachment" key={item.id}><FileText size={13}/><span>{item.name}</span><button type="button" aria-label={'移除附件'+item.name} onClick={()=>setFilesByAssistant(previous=>({...previous,[assistantId]:draftFiles.filter(file=>file.id!==item.id)}))}><X size={13}/></button></span>)}{draftStickers.map(item=><span className="composer-attachment" key={item.id}><Smile size={13}/><span>使用表情：{item.name}</span><button type="button" aria-label={'移除表情'+item.name} onClick={()=>setStickersByAssistant(previous=>({...previous,[assistantId]:draftStickers.filter(file=>file.id!==item.id)}))}><X size={13}/></button></span>)}</div>}<textarea aria-label="聊天内容" placeholder={channelRecord?'请在原聊天渠道继续，或新建应用内对话':assistant.enabled?'说说你的想法，或交给我一个任务…':'助手已暂停，请在助手设置中开启'} value={channelRecord?'':message} disabled={!assistant.enabled} onChange={e=>setMessage(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send();}}}/><div className="composer-tools"><span className="spacer"/><button type="button" className="icon-button" disabled={sending} aria-label="选择文件附件" title={filesReady?'选择已解析的文件':'配置文件阅读'} onClick={()=>filesReady?setModal({type:'attachment-picker',kind:'files',assistantId}):configureExtension('files')}><Paperclip size={20}/></button><button type="button" className="icon-button" disabled={sending} aria-label="选择私有表情" title={stickersReady?'选择当前助手的私有表情':'配置私有表情图库'} onClick={()=>stickersReady?setModal({type:'attachment-picker',kind:'stickers',assistantId}):configureExtension('stickers')}><Smile size={20}/></button><button type="button" className={'icon-button '+(voiceRequested?'is-active':'')} disabled={sending} aria-label={voiceRequested?'取消本次语音回复':'本次回复使用语音'} aria-pressed={voiceRequested} title={voiceReady?'语音合成可能产生费用':'配置语音回复'} onClick={()=>voiceReady?setVoiceRequested(value=>!value):configureExtension('voice')}><Volume2 size={20}/></button>{(sending||chat?.runStatus==='running')?<button type="button" className="send stop" aria-label="停止回复" onClick={cancelChat}><Square size={19}/></button>:<button className="send" aria-label="发送" disabled={(!message.trim()&&!draftFiles.length&&!draftStickers.length)||!assistant.enabled}><ArrowUp size={24}/></button>}</div></fieldset></form>
        </section><aside className="context-panel"><div className="section-heading"><h3>接下来的安排</h3><button className="text-link" onClick={()=>navigate('tasks')}>查看全部<ChevronRight size={13}/></button></div>{pendingTasks.length?<><button className="pink-feature" onClick={()=>{setTaskId(pendingTasks[0].id);navigate('tasks');}}><span className="pink-clock"><CalendarClock size={28}/></span><small>{assistant.name}</small><strong>{new Date(pendingTasks[0].dueAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</strong><h3>{pendingTasks[0].title}</h3><span>{time(pendingTasks[0].dueAt)}<ArrowRight size={16}/></span></button><div className="upcoming">{pendingTasks.slice(1,3).map(t=><button key={t.id} onClick={()=>{setTaskId(t.id);navigate('tasks');}}><Clock size={17}/><span><small>{time(t.dueAt)}</small>{t.title}</span><ChevronRight size={14}/></button>)}</div></>:<><button className="pink-feature no-task" onClick={()=>setModal('task')}><span className="pink-clock"><CalendarClock size={28}/></span><h3>把小事交给我记着</h3><p>从一个简单的提醒开始</p><span>创建第一条提醒<ArrowRight size={16}/></span></button><div className="upcoming"/></>}
          <div className="memory-summary"><div className="section-heading"><h3>当前可用记忆</h3><button className="icon-button" aria-label="管理记忆" onClick={()=>navigate('memory')}><Pencil size={16}/></button></div>{selectedMemories.length?selectedMemories.slice(0,3).map(m=><button key={m.id} onClick={()=>{setMemoryId(m.id);navigate('memory');}}><BookOpen size={17}/><span>{m.content}</span></button>):<p className="muted memory-placeholder">还没有保存记忆。<br/>你可以决定助手记住什么。</p>}<button className="text-link" onClick={()=>navigate('memory')}>管理记忆<ArrowRight size={16}/></button></div><button className="inbox-link" onClick={()=>setModal('inbox')}><Inbox size={17}/>消息收件箱{unread>0&&<span className="unread"/>}<ChevronRight size={15}/></button><button className="context-channel" onClick={()=>navigate('settings','channels')}><Link2 size={16}/>{channels.filter(c=>c.assistantId===assistantId).length} 个已配置渠道<ChevronRight size={14}/></button>
        </aside></div>}

        {page==='assistants'&&<div className="page"><header className="page-header"><div><h1>我的助手</h1><p>为不同任务设置角色、模型和可用能力。</p></div><Button onClick={()=>setModal('assistant')}><Plus size={18}/>创建助手</Button></header><div className={'split '+(editor?'with-editor':'')}><div className="assistant-grid">{data.assistants.map(a=><section className={'assistant-card '+(editor?.id===a.id?'chosen':'')} key={a.id}><div className="assistant-card-title"><Avatar kind={a.kind}/><div><h2>{a.name}</h2><p>{a.description}</p></div><Badge tone={a.enabled?'purple':'gray'}>{readiness(a)}</Badge></div><p className="assistant-model-label">{resolveConnection(a)?.name || '未选择模型'} · {channels.filter(c=>c.assistantId===a.id).length} 个渠道</p><div className="chips">{a.skills.filter(skill=>OPTIONAL_SKILL_IDS.includes(skill)).map(s=><Badge key={s}>{skillNames[s]||s}</Badge>)}</div><div className="card-buttons"><Button onClick={()=>chooseAssistant(a.id)} disabled={!a.enabled}><MessageCircle size={16}/>继续聊天</Button><Button secondary onClick={()=>editAssistant(a)}><Pencil size={15}/>编辑</Button><Button secondary onClick={()=>navigate('settings','channels')}>连接渠道</Button></div></section>)}</div>{editor&&<aside className="editor-panel"><AssistantEditor key={editor.id} assistant={editor} connections={connections} channels={channels} extensions={extensionModules} deployment={deployment} capabilities={data.capabilities} onSetup={()=>act(async()=>{await api('/capabilities/setup','POST');return api('/capabilities/verify','POST');},'已检查插件与记忆连接')} onDirty={value=>{dirty.current=value;}} onClose={()=>leave(()=>setEditor(null))} onSave={async value=>{const result=await act(()=>api('/assistants/'+editor.id,'PATCH',value),'助手设置已保存');if(result){dirty.current=false;setEditor(null);}return result;}}/></aside>}</div></div>}

        {page==='tasks'&&<div className="page"><header className="page-header"><div><h1>任务安排</h1><p>草稿确认后执行；投递结果保留在任务记录中。</p></div><Button onClick={()=>setModal('task')}><Plus size={18}/>创建提醒</Button></header><div className="toolbar"><div className="search-field"><Search size={18}/><input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={e=>setQuery(e.target.value)}/></div>{scopeSelect}<select aria-label="任务状态" className="scope-select" value={filter} onChange={e=>{setFilter(e.target.value);setTaskId(null);}}><option value="all">全部状态</option>{Object.entries(statusNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div><div className="split with-editor"><section className="task-list card">{filteredTasks.length?filteredTasks.map(t=><button className={'task-row '+(task?.id===t.id?'chosen':'')} key={t.id} onClick={()=>{setTaskId(t.id);setModal({type:'task-detail',id:t.id});}}><span className="task-name"><span className="mini-icon"><CalendarClock size={21}/></span><span><strong>{t.title}</strong><small>{data.assistants.find(a=>a.id===t.assistantId)?.name} · {channelName(t.channel)}</small></span></span><span>{time(t.dueAt)}</span><Badge tone={t.status==='draft'?'pink':t.status==='done'?'green':'gray'}>{statusNames[t.status]}</Badge></button>):<Empty icon={CalendarClock} title="暂时没有任务">创建提醒后，确认执行时间和接收位置。</Empty>}</section><aside className="editor-panel task-detail-desktop">{task?<TaskDetails task={task} records={data.chats.flatMap(c=>c.messages.filter(m=>m.taskId===task.id))} assistants={data.assistants} busy={busy} channelName={channelName} action={taskAction} changeTime={t=>setModal({type:'task-time',task:t})}/>:<Empty icon={Clock} title="任务详情">选择一条任务查看执行记录。</Empty>}</aside></div><p className="small muted runtime-footnote"><Info size={15}/>{fullCloud?'任务由云端后台持续执行。关闭这台电脑后，已接通的外部渠道仍可接收提醒；应用内消息在重新连接后查看。':'当前任务由本机执行，电脑休眠或退出应用会影响执行。仅连接远程对话服务不会把提醒调度迁到云端。'}</p></div>}

        {page==='memory'&&<div className="page"><header className="page-header"><div><h1>我的记忆</h1><p>查看保存内容、来源和共享范围。</p></div><Button onClick={()=>setModal('memory')}><Plus size={18}/>添加记忆</Button></header><div className="toolbar"><div className="search-field"><Search size={18}/><input aria-label="搜索记忆" placeholder="搜索记忆" value={query} onChange={e=>leave(()=>setQuery(e.target.value))}/></div>{scopeSelect}<select aria-label="记忆分类" className="scope-select" value={filter} onChange={e=>leave(()=>{setFilter(e.target.value);setMemoryId(null);})}><option value="all">全部分类</option>{['偏好','目标','进度'].map(x=><option key={x}>{x}</option>)}</select></div><p className="small muted inline-note"><Info size={15}/>这里管理助手保存的记忆，来源会单独标明；你可以编辑、删除或调整共享范围。</p><LongMemoryPanel assistantId={assistantId} assistantName={assistant.name} capabilities={data.capabilities} onNotice={setToast}/><div className="split with-editor"><section className="list-workspace"><div className="memory-list">{filteredMemories.length?filteredMemories.map(m=><button className={'memory-card '+(memory?.id===m.id?'chosen':'')} key={m.id} onClick={()=>leave(()=>{setMemoryId(m.id);if(window.innerWidth<=1050)setModal({type:'memory-detail',id:m.id});})}><Avatar kind={data.assistants.find(a=>a.id===m.assistantId)?.kind}/><div><h2>{m.content}</h2><div className="chips"><Badge>{m.category}</Badge><span>{data.assistants.find(a=>a.id===m.assistantId)?.name}{m.shared?' · 共享给全部助手':' · 仅此助手'}</span></div><small>{m.source} · {time(m.updatedAt)}</small></div><MoreHorizontal size={18}/></button>):<Empty icon={BookOpen} title="先让助手了解你一点">例如回答偏好、当前目标，或每周可投入的时间。</Empty>}</div></section><aside className="editor-panel memory-detail-desktop">{memory?<MemoryEditor key={memory.id} memory={memory} assistants={data.assistants} onDirty={v=>{dirty.current=v;}} onSave={async v=>{const r=await act(()=>api('/memories/'+memory.id,'PATCH',v),'记忆已更新');if(r)dirty.current=false;}} onDelete={()=>leave(()=>setModal({type:'delete-memory',memory}))}/>:<Empty icon={BookOpen} title="你的记忆，由你决定">添加后可以编辑内容，并选择是否共享。</Empty>}</aside></div></div>}

        {page==='settings'&&<ConnectionSettings deployment={deployment} onDeploymentChanged={refresh} onAbout={()=>setModal('about')} data={data} refresh={refresh} onError={setToast} onNotice={setToast} onDirty={v=>{dirty.current=v;}} initialTab={settingsTab} onComplete={()=>{setToast('已就绪，可以直接聊');navigate('chat');}}/>}

        {page==='extensions'&&<ExtensionsPanel data={data} initialItems={extensionModules} initialId={extensionFocus} assistantId={assistantId} onRefresh={refresh} onDirty={value=>{dirty.current=value;}} onNotice={setToast} onError={setToast} onNavigate={navigate}/>}
      </main>
    </div>
    {toast&&<div className="toast" role="status"><Info size={18}/><span>{toast}</span><button className="icon-button" aria-label="关闭提示" onClick={()=>setToast('')}><X size={16}/></button></div>}
    {modal?.type==='attachment-picker'&&<Modal title={modal.kind==='stickers'?'选择这位助手的表情':'选择这位助手的文件'} wide onClose={()=>setModal(null)}><FileAttachmentPicker key={modal.kind+':'+modal.assistantId} kind={modal.kind} assistantId={modal.assistantId} selectedIds={(modal.kind==='stickers'?stickersByAssistant[modal.assistantId]||[]:filesByAssistant[modal.assistantId]||[]).map(item=>item.id)} onNotice={setToast} onError={setToast} onDelete={id=>{const setter=modal.kind==='stickers'?setStickersByAssistant:setFilesByAssistant;setter(previous=>({...previous,[modal.assistantId]:(previous[modal.assistantId]||[]).filter(item=>item.id!==id)}));}} onSelect={items=>{if(modal.assistantId!==assistantId){setToast('助手已经切换，请为当前助手重新选择。');return;}const setter=modal.kind==='stickers'?setStickersByAssistant:setFilesByAssistant;setter(previous=>({...previous,[assistantId]:items}));setModal(null);}}/></Modal>}
    {modal==='about'&&<Modal title="关于 MioBot" onClose={()=>setModal(null)}><AboutMioBot/></Modal>}
    {modal==='assistant'&&<Modal title="创建你的助手" onClose={()=>setModal(null)}><form onSubmit={formSubmit('assistant')}><label>名称<input name="name" required maxLength="30" placeholder="为它取个名字"/></label><label>角色<select name="kind"><option value="daily">日常助手</option><option value="game">游戏助手</option><option value="career">求职助手</option></select></label><label>简介<input name="description" maxLength="100" placeholder="它主要帮你做什么？"/></label><label>角色设定<textarea name="persona" rows="5" required defaultValue="你是我的个人助手。先理解我的目标，回答自然、清楚；没有实际执行的事情，不要声称已经完成。"/></label><label>默认模型<select name="defaultConnectionId"><option value="">使用全局默认</option>{connections.map(c=><option key={c.id} value={c.id}>{c.name} · {c.model}</option>)}</select></label><div className="modal-actions"><Button secondary type="button" onClick={()=>setModal(null)}>取消</Button><Button disabled={busy}>创建助手</Button></div></form></Modal>}
    {modal==='memory'&&<Modal title="添加一条记忆" onClose={()=>setModal(null)}><form onSubmit={formSubmit('memory')}><label>希望助手记住什么？<textarea name="content" rows="4" required maxLength="2000" placeholder="例如：我每天能玩游戏的时间是20分钟"/></label>{assistantSelect()}<label>分类<select name="category"><option>偏好</option><option>目标</option><option>进度</option></select></label><p className="small muted">默认仅所选助手使用，之后可授权共享。</p><div className="modal-actions"><Button secondary type="button" onClick={()=>setModal(null)}>取消</Button><Button disabled={busy}>保存记忆</Button></div></form></Modal>}
    {modal==='task'&&<Modal title="安排一个提醒" onClose={()=>setModal(null)}><TaskCreateForm assistants={data.assistants} assistantId={assistantId} channels={channels} busy={busy} onSubmit={formSubmit('task')} onCancel={()=>setModal(null)}/></Modal>}
    {modal?.type==='task-time'&&<Modal title="修改执行时间" onClose={()=>setModal(null)}><form onSubmit={async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const r=await act(()=>api('/tasks/'+modal.task.id,'PATCH',{dueAt:new Date(f.get('dueAt')).toISOString()}),'时间已修改，请重新确认');if(r)setModal(null);}}><label>执行时间<input name="dueAt" type="datetime-local" defaultValue={localInput(modal.task.dueAt)} required/></label><div className="modal-actions"><Button disabled={busy}>保存时间</Button></div></form></Modal>}
    {modal?.type==='task-detail'&&<Modal title="任务详情" onClose={()=>setModal(null)}><TaskDetails task={data.tasks.find(t=>t.id===modal.id)} records={data.chats.flatMap(c=>c.messages.filter(m=>m.taskId===modal.id))} assistants={data.assistants} busy={busy} channelName={channelName} action={taskAction} changeTime={t=>setModal({type:'task-time',task:t})}/></Modal>}
    {modal?.type==='memory-detail'&&(()=>{const m=data.memories.find(x=>x.id===modal.id);return m&&<Modal title="编辑记忆" onClose={()=>leave(()=>setModal(null))}><MemoryEditor showTitle={false} key={m.id} memory={m} assistants={data.assistants} onDirty={v=>{dirty.current=v;}} onSave={async v=>{const r=await act(()=>api('/memories/'+m.id,'PATCH',v),'记忆已更新');if(r){dirty.current=false;setModal(null);}}} onDelete={()=>leave(()=>setModal({type:'delete-memory',memory:m}))}/></Modal>;})()}
    {modal?.type==='delete-memory'&&<Modal title="删除这条记忆？" onClose={()=>setModal(null)}><p className="modal-copy">“{modal.memory.content}”将不再加入后续记忆上下文。原有聊天中提到的内容仍会保留。</p><div className="modal-actions"><Button secondary onClick={()=>setModal(null)}>保留</Button><Button danger onClick={async()=>{const r=await act(()=>api('/memories/'+modal.memory.id,'DELETE'),'记忆已删除');if(r){dirty.current=false;setMemoryId(null);setModal(null);}}}>删除记忆</Button></div></Modal>}
    {discardAction&&<Modal title="还有未保存的修改" onClose={()=>setDiscardAction(null)}><p className="modal-copy">离开后，这次编辑的内容不会保存。</p><div className="modal-actions"><Button secondary onClick={()=>setDiscardAction(null)}>继续编辑</Button><Button danger onClick={()=>{const action=discardAction;dirty.current=false;setDiscardAction(null);action();}}>放弃修改并离开</Button></div></Modal>}
    {modal?.type==='pause-reminders'&&<Modal title="停用全部助手的提醒？" onClose={()=>setModal(null)}><p className="modal-copy">将暂停 {data.tasks.filter(t=>t.status==='pending').length} 个待执行任务。重新开启能力后，需在任务页恢复这些任务。</p><div className="modal-actions"><Button secondary onClick={()=>setModal(null)}>保留提醒</Button><Button danger onClick={async()=>{await act(()=>api('/extensions/reminders','PATCH',{enabled:false}),'提醒已停用，待执行任务已暂停');setModal(null);}}>暂停并停用</Button></div></Modal>}
    {modal==='inbox'&&<Modal title="消息收件箱" onClose={()=>setModal(null)}>{data.notifications.length?data.notifications.map(n=><button className="inbox-item" key={n.id} onClick={()=>act(()=>api('/notifications/read','POST',{id:n.id}))}><span className="mini-icon"><Bell size={20}/></span><span><strong>{n.title}</strong><small>{data.assistants.find(a=>a.id===n.assistantId)?.name} · {time(n.at)} · {n.read?'已读':'未读'}</small></span>{!n.read&&<span className="dot violet"/>}</button>):<Empty icon={Inbox} title="还没有收到提醒">应用内提醒和你开启的主动关心会保存在这里。</Empty>}</Modal>}
  </div>;
}

function AssistantEditor({assistant,connections,channels,extensions,deployment,capabilities,onSetup,onDirty,onSave,onClose}) {
  const [value,setValue]=useState({...assistant}),[metadataDirty,setMetadataDirty]=useState(false),[detailsDirty,setDetailsDirty]=useState(false);
  useEffect(()=>{onDirty(metadataDirty||detailsDirty);},[metadataDirty,detailsDirty]);
  const update=patch=>{setValue(v=>({...v,...patch}));setMetadataDirty(true);};
  return <><div className="section-heading"><h2>助手设置</h2><button className="icon-button" aria-label="关闭助手设置" onClick={onClose}><X size={18}/></button></div><label>名称<input value={value.name} maxLength={30} onChange={e=>update({name:e.target.value})}/></label><label>简介<input value={value.description} maxLength={100} onChange={e=>update({description:e.target.value})}/></label><label>默认模型<select value={value.defaultConnectionId||''} onChange={e=>update({defaultConnectionId:e.target.value||null})}><option value="">使用全局默认</option>{connections.map(c=><option key={c.id} value={c.id}>{c.name} · {c.model}</option>)}</select></label><label className="switch-line">开启助手<input type="checkbox" checked={value.enabled} onChange={e=>update({enabled:e.target.checked})}/></label><AssistantCapabilities assistant={value} channels={channels} extensions={extensions} deployment={deployment} capabilities={capabilities} metadataDirty={metadataDirty} onSetup={onSetup} onDirty={setDetailsDirty} onSave={patch=>onSave({...value,...patch})}/></>;
}

function MemoryEditor({memory,assistants,onDirty,onSave,onDelete,showTitle=true}) {
  const [value,setValue]=useState({...memory});
  useEffect(()=>{setValue({...memory});},[memory.updatedAt]);
  const update=patch=>{setValue(v=>({...v,...patch}));onDirty(true);};
  return <>{showTitle&&<h2>编辑记忆</h2>}<label>内容<textarea rows="5" value={value.content} onChange={e=>update({content:e.target.value})}/></label><label>所属助手<input readOnly value={assistants.find(a=>a.id===memory.assistantId)?.name || ''}/></label><label>分类<select value={value.category} onChange={e=>update({category:e.target.value})}>{['偏好','目标','进度'].map(x=><option key={x}>{x}</option>)}</select></label><label>来源<div className="source-box"><MessageCircle size={17}/>{memory.source}</div></label><label className="switch-line">共享给全部其他助手<input type="checkbox" checked={value.shared} onChange={e=>update({shared:e.target.checked})}/></label><p className="small muted">默认仅所属助手使用。更新影响后续回答，原有聊天记录保留。</p><div className="editor-footer vertical"><Button onClick={()=>onSave(value)}>保存修改</Button><Button danger onClick={onDelete}>删除记忆</Button></div></>;
}

function LongMemoryPanel({assistantId,assistantName,capabilities,onNotice}) {
  const [items,setItems]=useState([]),[error,setError]=useState(''),[loading,setLoading]=useState(false),[loaded,setLoaded]=useState(false);
  useEffect(()=>{setItems([]);setError('');setLoaded(false);},[assistantId]);
  async function load(){setLoading(true);setError('');try{const result=await api('/long-memories?assistantId='+encodeURIComponent(assistantId));setItems(result.items||[]);setLoaded(true);}catch(e){setError(e.message);}finally{setLoading(false);}}
  async function remove(id){if(!window.confirm('删除这条长期记忆？原始聊天和历史备份仍会保留。'))return;try{await api('/long-memories/'+id+'?assistantId='+encodeURIComponent(assistantId),'DELETE');await load();onNotice('长期记忆已删除');}catch(e){setError(e.message);}}
  return <details className="long-memory-panel"><summary>高级：{assistantName}的增强记忆索引<span>{capabilities?.memory?.status==='ready'?'连接已验证':capabilities?.memory?.status==='configured'?'已配置 · 待验证':'待配置'}</span></summary><p>这里查看增强记忆索引，按当前助手分别保存。基础跨会话记忆在下方管理；删除索引条目不会清除原聊天和已有备份。</p><Button secondary disabled={loading} onClick={load}><RefreshCw size={14}/>{loading?'读取中…':'读取当前助手记忆'}</Button>{error&&<p className="long-memory-error" role="alert">{error}</p>}{loaded&&!items.length&&<p>还没有增强记忆索引。基础记忆仍可在下方查看；也可以直接说“记住……”。</p>}<div className="long-memory-list">{items.map(m=><article key={m.id}><div><p>{m.text||m.content}</p><small>记忆 #{m.id}{m.created_at?' · '+time(m.created_at):''}</small></div><button className="icon-button" aria-label={'删除长期记忆'+m.id} onClick={()=>remove(m.id)}><Trash2 size={16}/></button></article>)}</div></details>;
}

function TaskProcessingDetails({records}) {
  if(!records.length)return null;
  const sources={local:'任务处理 · 未调用模型',astrbot:'助手回复',reminder:'定时提醒 · 后台已执行',care:'主动关心',channel:'消息渠道'};
  return <details className="task-processing-details"><summary>查看处理详情</summary>{records.map(record=><section key={record.id}><p>{sources[record.source]||'处理记录'}{record.model?' · '+record.model:''}<small>{time(record.createdAt)}</small></p>{Array.isArray(record.toolCalls)&&record.toolCalls.length>0&&<ToolEvidence calls={record.toolCalls}/>}</section>)}</details>;
}

function TaskDetails({task,records=[],assistants,busy,channelName,action,changeTime}) {
  if(!task)return null;
  return <><h2>{task.title}</h2><Badge tone={task.status==='done'?'green':'purple'}>{statusNames[task.status]}</Badge><dl><div><dt>执行时间</dt><dd>{time(task.dueAt)}</dd></div><div><dt>所属助手</dt><dd>{assistants.find(a=>a.id===task.assistantId)?.name}</dd></div><div><dt>接收位置</dt><dd>{channelName(task.channel)}</dd></div></dl><h3>执行记录</h3><div className="timeline"><div><span/><section><strong>已创建</strong><p>{time(task.createdAt)}</p></section></div>{task.logs.map((l,i)=><div key={i}><span/><section><strong>{l.text}</strong><p>{time(l.at)}</p></section></div>)}</div><TaskProcessingDetails records={records}/>{task.status==='sending'&&<p className="small muted">消息正在交给渠道处理，暂时无法撤回或修改。</p>}{task.status==='done'&&<p className="small muted">投递记录不代表用户已经阅读，请到对应接收位置查看。</p>}<div className="editor-footer">{task.status==='draft'&&<Button disabled={busy||Date.parse(task.dueAt)<=Date.now()} onClick={()=>action(task,'confirm')}>确认创建</Button>}{['paused','overdue','failed'].includes(task.status)&&<Button onClick={()=>action(task,'resume')}>恢复</Button>}{!['done','cancelled','sending'].includes(task.status)&&<><Button secondary onClick={()=>changeTime(task)}>修改时间</Button>{task.status==='pending'&&<Button secondary onClick={()=>action(task,'pause')}><Pause size={15}/>暂停</Button>}<Button danger onClick={()=>action(task,'cancel')}>取消任务</Button></>}</div>{task.status==='draft'&&Date.parse(task.dueAt)<=Date.now()&&<p className="small muted">时间已过，请修改执行时间后确认。</p>}</>;
}

function TaskCreateForm({assistants,assistantId,channels,busy,onSubmit,onCancel}) {
  const [selected,setSelected]=useState(assistantId),[channel,setChannel]=useState('web');
  return <form onSubmit={onSubmit}><label>提醒内容<input name="title" required maxLength="100" placeholder="例如：领取活动奖励"/></label><label>执行时间<input type="datetime-local" name="dueAt" required defaultValue={localInput(Date.now()+1800000)}/></label><label>所属助手<select name="assistantId" value={selected} onChange={e=>{setSelected(e.target.value);setChannel('web');}}>{assistants.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>接收位置<select name="channel" value={channel} onChange={e=>setChannel(e.target.value)}><option value="web">应用收件箱</option>{channels.filter(c=>c.assistantId===selected&&c.enabled&&c.target&&c.supportProactive&&c.status==='verified').map(c=><option key={c.id} value={c.id}>{c.name}（已确认收到测试）</option>)}</select></label><p className="small muted">先保存草稿，确认后执行。外部接收位置需先在消息渠道中完成发送测试并确认收到。</p><div className="modal-actions"><Button secondary type="button" onClick={onCancel}>取消</Button><Button disabled={busy}>保存草稿</Button></div></form>;
}

createRoot(document.getElementById('root')).render(<App/>);
