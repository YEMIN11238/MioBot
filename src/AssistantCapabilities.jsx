import React, {useEffect, useRef, useState} from 'react';
import {BookOpen, CalendarClock, Check, ChevronDown, Gamepad2, Heart, Info, LoaderCircle, MessageCircle, Puzzle, RefreshCw, Sparkles, Volume2, Smile, Globe, FileText} from 'lucide-react';
import './assistant-capabilities.css';
import {careDeliveryChannels} from './deployment-state.mjs';
import {OPTIONAL_SKILL_IDS} from './bundled-ui.mjs';

const allowedSkills=['memory','reminders','humanize','long_memory','minecraft','voice','stickers','web','files'];
const defaultCare={enabled:false,idleMinutes:120,quietStart:23,quietEnd:8,maxPerDay:1,deliveryChannel:'web'};
const stateLabel={
  ready:'已就绪',loaded:'已加载',registered:'已注册',installed:'已安装 · 待配置',
  not_configured:'尚未配置',needs_configuration:'需要配置',not_installed:'尚未安装',staged:'已准备 · 待加载',configured:'已配置 · 待验证',needs_connection:'缺少模型连接',
  disabled:'未启用',pending:'等待配置',starting:'正在加载',error:'配置异常',unavailable:'当前不可用',
};
const normalize=assistant=>({
  persona:assistant?.persona||'',
  skills:[...new Set((assistant?.skills||[]).filter(id=>allowedSkills.includes(id)))],
  care:{...defaultCare,...assistant?.care,enabled:assistant?.care?.enabled===true},
});
const fingerprint=value=>JSON.stringify({...value,skills:[...value.skills].sort()});
const pluginNames={astrbot_plugin_wanna_be_human:'聊天拟人增强',astrbot_plugin_dafeiyu_clean:'回复清理',astrbot_plugin_livingmemory:'长期记忆',astrbot_plugin_miobot_games:'我的世界资料',astrbot_plugin_miobot_tasks:'定时任务',astrbot_plugin_miobot_proactive:'主动关心',astrbot_plugin_miobot_media:'语音与私有表情',astrbot_plugin_miobot_research:'网页检索与文件阅读'};
function CapabilityStatus({status}){
  const ready=['ready','loaded','registered'].includes(status),error=['error','unavailable'].includes(status);
  return <span className={'ac-status '+(ready?'is-ready':error?'is-error':'')}><i/>{stateLabel[status]||'等待检查'}</span>;
}
function Notice({children,error=false}){
  return <p className={'ac-notice '+(error?'is-error':'')} role={error?'alert':undefined}><Info size={15}/><span>{children}</span></p>;
}

/** Saves only the current assistant's persona and capability choices. */
export default function AssistantCapabilities({assistant,capabilities={},channels=[],extensions=[],deployment,onSave,onSetup,busy=false,onDirty,metadataDirty=false}){
  const [value,setValue]=useState(()=>normalize(assistant));
  const [setupBusy,setSetupBusy]=useState(false),[saveBusy,setSaveBusy]=useState(false),[error,setError]=useState('');
  const baseline=useRef(fingerprint(normalize(assistant))),dirtyCallback=useRef(onDirty);
  dirtyCallback.current=onDirty;
  const signature=fingerprint(value),dirty=signature!==baseline.current;
  const companion=['daily','companion'].includes(assistant?.kind)||['daily','companion'].includes(assistant?.id);
  const game=assistant?.kind==='game'||assistant?.id==='game';
  const career=assistant?.kind==='career'||assistant?.id==='career';
  const memory=capabilities.memory||{},gameTools=capabilities.game||{},personality=capabilities.personality||{},reminders=capabilities.reminders||{},proactive=capabilities.proactive||{},plugins=Array.isArray(capabilities.plugins)?capabilities.plugins:[];
  const deliveryChannels=careDeliveryChannels(channels,assistant?.id),deliveryValid=value.care.deliveryChannel==='web'||deliveryChannels.some(channel=>channel.id===value.care.deliveryChannel);
  const working=busy||setupBusy||saveBusy;
  const needsSetup=(game&&value.skills.includes('minecraft')&&gameTools.status!=='ready')||(value.care.enabled&&proactive.status!=='ready');
  const roleTitle=companion?'熟人式陪伴':game?'游戏搭档':career?'求职顾问':'个人助手';

  useEffect(()=>{
    const next=normalize(assistant);baseline.current=fingerprint(next);setValue(next);setError('');
  },[assistant?.id]);
  useEffect(()=>{dirtyCallback.current?.(dirty);},[dirty]);
  useEffect(()=>()=>dirtyCallback.current?.(false),[]);

  function update(patch){setValue(current=>({...current,...patch}));setError('');}
  function toggle(id,checked){update({skills:checked?[...new Set([...value.skills,id])]:value.skills.filter(item=>item!==id)});}
  function updateCare(patch){update({care:{...value.care,...patch}});}
  async function setup(){
    if(!onSetup||working)return;
    setSetupBusy(true);setError('');
    try{await onSetup();}catch(e){setError(e.message||'能力配置未完成，请查看后台状态。');}finally{setSetupBusy(false);}
  }
  async function save(){
    if(!value.persona.trim()){setError('请先填写这位助手的人设。');return;}
    if(value.care.enabled&&(!Number.isInteger(value.care.idleMinutes)||value.care.idleMinutes<10||value.care.idleMinutes>10080)){
      setError('主动关心的间隔需为 10 到 10080 分钟。');return;
    }
    if(value.care.enabled&&(!Number.isInteger(value.care.maxPerDay)||value.care.maxPerDay<1||value.care.maxPerDay>3)){
      setError('每天最多主动关心 1 到 3 次。');return;
    }
    if(value.care.enabled&&!deliveryValid){setError('请选择当前助手已验证的消息接收位置，或改用应用内收件箱。');return;}
    setSaveBusy(true);setError('');
    const payload={persona:value.persona.trim(),skills:value.skills,care:value.care};
    try{
      const result=await onSave?.(payload);
      if(result!==false&&result!==null){baseline.current=fingerprint(payload);setValue(payload);dirtyCallback.current?.(false);}
    }catch(e){setError(e.message||'修改没有保存，请稍后重试。');}finally{setSaveBusy(false);}
  }

  const extensionStatus=id=>{const item=extensions.find(value=>value.id===id);return !item?'not_configured':item.enabled?item.status:'disabled';};
  const choices=[
    ...(game?[{id:'minecraft',title:'《我的世界》资料工具',description:'读取真实物品和合成配方。查询不等于已经在游戏里执行。',icon:Gamepad2,status:gameTools.status}]:[]),
    {id:'voice',title:'语音回复',description:'明确要求时生成语音，需在扩展中心配置服务。',icon:Volume2,status:extensionStatus('voice')},
    {id:'stickers',title:'私有表情图库',description:'使用这位助手的私有图库，不自动收集图片。',icon:Smile,status:extensionStatus('stickers')},
    {id:'files',title:'文件阅读',description:'读取你主动上传并选择的文档。',icon:FileText,status:extensionStatus('files')}
  ];

  return <section className="assistant-capabilities" aria-label={assistant?.name+'的人格与能力'}>
    <header className="ac-heading"><div><span className="ac-eyebrow">这位助手的配置</span><h2>人格与能力</h2></div><span className={'ac-role '+(companion?'is-companion':game?'is-game':'')}>{companion?<Heart size={13}/>:game?<Gamepad2 size={13}/>:<Sparkles size={13}/>} {roleTitle}</span></header>
    <p className="ac-intro">{companion?'先听懂你的感受，少说教；能接梗，也尊重你不想聊的时候。':game?'围绕具体游戏提供资料和计划，用工具结果支撑建议。':career?'围绕真实经历、岗位和材料提供帮助，不编造个人贡献或结果。':'为当前助手单独选择人设和能力。'}</p>

    <label className="ac-field">人设与说话方式<textarea aria-label="助手人设" value={value.persona} maxLength={10000} rows={8} onChange={e=>update({persona:e.target.value})}/><small>这段设置只影响 {assistant?.name||'当前助手'}。人设不能替代真实工具和记忆。</small></label>
    <button type="button" className="ac-text-button" disabled={working||value.persona===assistant?.persona} onClick={()=>update({persona:assistant?.persona||''})}><RefreshCw size={13}/>恢复这位助手已保存的人设</button>

    <p className="ac-bundled-note">接好模型即可聊天，记住重要的事并安排提醒。</p>
    <section className="ac-section" aria-label="可选助手能力"><h3>可选扩展</h3><p className="ac-muted">按这位助手的用途选择声音、表情或资料工具。</p><div className="ac-choice-list">{choices.filter(choice=>OPTIONAL_SKILL_IDS.includes(choice.id)).map(({id,title,description,icon:Icon,status})=><label key={id} className={'ac-choice '+(value.skills.includes(id)?'is-selected':'')}><span className="ac-choice-icon"><Icon size={18}/></span><span className="ac-choice-copy"><strong>{title}</strong><small>{description}</small>{status&&<CapabilityStatus status={status}/>}</span><input type="checkbox" aria-label={'允许'+title} checked={value.skills.includes(id)} disabled={working} onChange={e=>toggle(id,e.target.checked)}/></label>)}</div>
      {value.skills.some(id=>['voice','stickers','files'].includes(id))&&<p className="ac-footnote">可选扩展只影响当前助手；需要服务账号的扩展可在扩展中心配置。</p>}
      {game&&value.skills.includes('minecraft')&&<><p className="ac-footnote">资料版本：{gameTools.version||'待后台确认'}。查询资料不会操作游戏客户端或服务器。</p>{gameTools.error&&<Notice error>{gameTools.error}</Notice>}</>}
    </section>

    <section className="ac-section ac-care" aria-label="主动关心设置"><h3><Heart size={15}/>偶尔主动关心</h3><p className="ac-muted">沿用这位助手自己的人设和实际聊过的内容。默认关闭，需要你单独开启。</p><CapabilityStatus status={proactive.status||'not_configured'}/>{value.care.enabled&&proactive.error&&<Notice error>{proactive.error}</Notice>}<label className="ac-switch-row"><span><strong>允许主动关心</strong><small>关闭后仍可正常聊天，也不会取消你确认过的定时任务。</small></span><input type="checkbox" aria-label="允许主动关心" checked={value.care.enabled} disabled={working} onChange={e=>updateCare({enabled:e.target.checked})}/></label>{value.care.enabled&&<div className="ac-care-fields"><label className="ac-field ac-delivery-field">发到哪里<select aria-label="主动关心接收位置" value={value.care.deliveryChannel} onChange={e=>updateCare({deliveryChannel:e.target.value})}><option value="web">应用内聊天与收件箱</option>{deliveryChannels.map(channel=><option key={channel.id} value={channel.id}>{channel.name}</option>)}{!deliveryValid&&<option value={value.care.deliveryChannel} disabled>原接收位置当前不可用，请重新选择</option>}</select><small>{value.care.deliveryChannel==='web'?'消息会保存在当前后台。若电脑离线，重新连接后才能在软件里看到。':'将向你本人确认收到过测试消息的指定会话发送。'}外部接收位置需先在消息渠道中连接并验证。</small></label><label className="ac-field">至少间隔<select aria-label="主动关心间隔" value={value.care.idleMinutes} onChange={e=>updateCare({idleMinutes:Number(e.target.value)})}><option value={30}>30 分钟</option><option value={60}>1 小时</option><option value={120}>2 小时</option><option value={240}>4 小时</option><option value={480}>8 小时</option>{![30,60,120,240,480].includes(value.care.idleMinutes)&&<option value={value.care.idleMinutes}>{value.care.idleMinutes} 分钟</option>}</select></label><label className="ac-field">每天最多<select aria-label="每日关心次数" value={value.care.maxPerDay} onChange={e=>updateCare({maxPerDay:Number(e.target.value)})}>{[1,2,3].map(count=><option key={count} value={count}>{count} 次</option>)}</select></label><fieldset className="ac-quiet-hours"><legend>免打扰时段</legend><label>开始<select aria-label="免打扰开始时间" value={value.care.quietStart} onChange={e=>updateCare({quietStart:Number(e.target.value)})}>{Array.from({length:24},(_,hour)=><option value={hour} key={hour}>{String(hour).padStart(2,'0')}:00</option>)}</select></label><span>—</span><label>结束<select aria-label="免打扰结束时间" value={value.care.quietEnd} onChange={e=>updateCare({quietEnd:Number(e.target.value)})}>{Array.from({length:24},(_,hour)=><option value={hour} key={hour}>{String(hour).padStart(2,'0')}:00</option>)}</select></label><small>按北京时间处理，支持跨夜；起止相同时为全天免打扰。它只能依据你实际聊过的内容关心你。</small></fieldset><Notice>{deployment?.mode==='cloud'?'主动关心由云端后台执行，云端服务需持续运行。':'当前在本机执行，电脑和应用需要保持运行。'}可能调用聊天模型产生费用；助手只依据你实际聊过的内容发消息，不会读取你未提供的实时状态。</Notice></div>}</section>

    <details className="ac-plugin-details"><summary><Puzzle size={15}/>高级：组件诊断<ChevronDown size={14}/></summary>{needsSetup&&<div className="ac-setup-prompt"><p>可选能力仍需检查。日常基础能力由软件统一管理。</p><button type="button" className="ac-button is-secondary" onClick={setup} disabled={working||!onSetup}>{setupBusy?<LoaderCircle size={15} className="ac-spin"/>:<Puzzle size={15}/>}检查内置组件</button></div>}{plugins.length?<ul>{plugins.map((plugin,index)=><li key={plugin.id||index}><div><strong>{pluginNames[plugin.id]||plugin.displayName||'其他扩展'}</strong><CapabilityStatus status={plugin.status}/></div>{plugin.error&&<p role="alert">{plugin.error}</p>}</li>)}</ul>:<p className="ac-muted">后台尚未返回插件状态；不会把能力开关当作安装成功。</p>}<button type="button" className="ac-button is-secondary" onClick={setup} disabled={working||!onSetup}>{setupBusy?<LoaderCircle size={15} className="ac-spin"/>:<RefreshCw size={15}/>}重新检查组件</button></details>
    {error&&<Notice error>{error}</Notice>}
    <footer className="ac-footer"><span aria-live="polite">{dirty||metadataDirty?'有未保存的修改':'已与保存的设置一致'}</span><button type="button" className="ac-button" onClick={save} disabled={working||!(dirty||metadataDirty)}>{saveBusy?<LoaderCircle size={15} className="ac-spin"/>:<Check size={15}/>}保存人格与能力</button></footer>
  </section>;
}
