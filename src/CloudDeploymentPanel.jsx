import React,{useEffect,useRef,useState} from 'react';
import {Check,ChevronDown,Cloud,Copy,Download,Link2,LoaderCircle,Monitor,RefreshCw,ShieldCheck} from 'lucide-react';
import {productText} from '../shared/product-text.mjs';
import {cloudDraftError} from './deployment-state.mjs';
import './cloud-deployment.css';

async function deploymentRequest(path,body){
  const response=await fetch('/api/deployment'+path,{method:body===undefined?'GET':'POST',headers:{'X-Personal-Agent':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json().catch(()=>({error:'连接服务没有返回有效结果。'}));
  if(!response.ok)throw new Error(productText(value.error||'连接操作未完成。'));
  return value;
}

function GuideText({text,onCopy}){
  const blocks=String(text||'').split(/```[^\n]*\n([\s\S]*?)```/g);
  return <div className="cloud-guide-content">{blocks.map((block,index)=>index%2?<div className="cloud-guide-command" key={index}><button type="button" className="cs-button is-secondary" onClick={()=>onCopy(block.trim())}><Copy size={13}/>复制命令</button><pre><code>{block.trim()}</code></pre></div>:<div className="cloud-guide-prose" key={index}>{block.split('\n').filter(line=>line.trim()).map((line,lineIndex)=>/^#{1,6}\s/.test(line)?<h4 key={lineIndex}>{line.replace(/^#{1,6}\s+/,'')}</h4>:<p key={lineIndex}>{line}</p>)}</div>)}</div>;
}

function DeploymentGuide({onNotice}){
  const [guide,setGuide]=useState(null),[loading,setLoading]=useState(false),[downloading,setDownloading]=useState(false),[error,setError]=useState(''),[copied,setCopied]=useState(false);
  async function load(){setLoading(true);setError('');try{setGuide(await deploymentRequest('/guide'));}catch(err){setError(err.message);}finally{setLoading(false);}}
  async function copy(text){try{await navigator.clipboard.writeText(text);setCopied(true);onNotice?.('命令已复制，请在你自己的服务器中核对后运行。');}catch{setError('复制没有完成，可以直接选中下方命令手动复制。');}}
  async function download(){
    setDownloading(true);setError('');let objectURL='';
    try{
      const url=new URL(guide.packageUrl||'/api/deployment/package',window.location.origin);if(url.origin!==window.location.origin||url.pathname!=='/api/deployment/package')throw Error('运行包地址不可用，请重新读取部署指南。');
      const response=await fetch(url.pathname+url.search,{headers:{'X-Personal-Agent':'1'}});if(!response.ok){const value=await response.json().catch(()=>({}));throw Error(productText(value.error||'运行包暂时无法下载。'));}
      const match=response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)"?/i),filename=match?.[1]?.split(/[\\/]/).at(-1)||'miobot-cloud-'+String(guide.version||'package').replace(/[^a-zA-Z0-9._-]/g,'')+'.tar.gz';
      objectURL=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=objectURL;link.download=filename;document.body.appendChild(link);link.click();link.remove();onNotice?.('已发起运行包下载。请按下方步骤上传到你自己的服务器。');
    }catch(err){setError(err.message);}finally{if(objectURL)setTimeout(()=>URL.revokeObjectURL(objectURL),1000);setDownloading(false);}
  }
  const instructions=typeof guide?.guide==='string'?guide.guide:guide?.guide?.text;
  return <details className="cloud-guide" onToggle={event=>{if(event.currentTarget.open&&!guide&&!loading)void load();}}><summary><span><Download size={16}/>部署指南与运行包</span><ChevronDown size={15}/></summary><div className="cloud-guide-body"><p className="cloud-guide-disclaimer">Linux Docker 部署尚未完整实测。这里提供运行包与配对步骤；不会替你购买或部署服务器，也不会迁移这台电脑的助手、聊天和密钥。</p><ol className="cloud-guide-overview"><li>下载运行包</li><li>上传到服务器</li><li>启动后台</li><li>获取连接密钥</li><li>回到这里配对</li></ol>{loading&&<p className="cloud-guide-note"><LoaderCircle size={15} className="spin"/>正在读取当前版本的部署说明…</p>}{guide&&<><div className="cloud-guide-package"><span>运行包版本：{guide.version||'以运行包为准'}</span><button type="button" className="cs-button is-secondary" disabled={!guide.packageAvailable||downloading} onClick={download}>{downloading?<LoaderCircle size={14} className="spin"/>:<Download size={14}/>}下载云端运行包</button></div>{!guide.packageAvailable&&<p className="cloud-guide-note">当前安装包没有附带云端运行包；请重新获取包含服务端运行包的 MioBot 版本。</p>}{instructions&&<GuideText text={instructions} onCopy={copy}/>}<GuideSteps value={guide.guide} onCopy={copy}/>{copied&&<p className="cloud-guide-note"><Check size={14}/>命令已复制；操作由你在服务器执行。</p>}</>}{error&&<p className="cloud-deployment-error" role="alert">{error}</p>}{!loading&&<button type="button" className="cloud-guide-reload" onClick={load}><RefreshCw size={13}/>重新读取指南</button>}</div></details>;
}

function GuideSteps({value,onCopy}){
  if(!value||typeof value!=='object')return null;
  const steps=Array.isArray(value.steps)?value.steps:[];
  return <div className="cloud-guide-steps">{steps.map((step,index)=>{if(typeof step==='string')return <GuideText key={index} text={step} onCopy={onCopy}/>;return <section key={index}><h4>{step.title||'第 '+(index+1)+' 步'}</h4>{step.description&&<p>{step.description}</p>}{step.text&&<GuideText text={step.text} onCopy={onCopy}/>}<GuideText text={step.command?'```\n'+step.command+'\n```':''} onCopy={onCopy}/></section>;})}{Array.isArray(value.notes)&&value.notes.map((note,index)=><p key={'note-'+index} className="cloud-guide-note">{note}</p>)}</div>;
}

/** Always talks to the desktop connection manager, including while cloud is offline. */
export default function CloudDeploymentPanel({deployment,onChanged,onDirty,onError,onNotice}){
  const [state,setState]=useState(deployment||null),[url,setUrl]=useState(deployment?.cloud?.url||''),[token,setToken]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const dirtyCallback=useRef(onDirty),savedURL=useRef(deployment?.cloud?.url||'');dirtyCallback.current=onDirty;
  const dirty=url!==savedURL.current||!!token;
  useEffect(()=>{if(deployment)setState(deployment);},[deployment]);
  useEffect(()=>{const next=deployment?.cloud?.url||'';if(!dirty){setUrl(next);savedURL.current=next;}},[deployment?.cloud?.url]);
  useEffect(()=>{dirtyCallback.current?.(dirty);},[dirty]);
  useEffect(()=>()=>dirtyCallback.current?.(false),[]);
  const cloud=state?.cloud||{},cloudMode=state?.mode==='cloud',connected=cloudMode&&cloud.paired&&cloud.online;
  const sameSaved=cloud.paired&&url.trim().replace(/\/+$/,'')===String(cloud.url||'').replace(/\/+$/,'');
  async function reload(){
    setBusy(true);setError('');
    try{const value=await deploymentRequest('');setState(value);await onChanged?.();return value;}
    catch(err){setError(err.message);onError?.(err.message);return null;}
    finally{setBusy(false);}
  }
  async function connect(){
    const problem=cloudDraftError(url,token,state||{});if(problem){setError(problem);return;}
    setBusy(true);setError('');
    try{const value=await deploymentRequest('/connect',{url:url.trim(),token:token.trim()});const next=value.deployment||value;setState(next);setToken('');savedURL.current=next.cloud?.url||url.trim();setUrl(savedURL.current);dirtyCallback.current?.(false);await onChanged?.();onNotice?.('云端已连接，正在使用这台服务器上的助手和记录。');}
    catch(err){setError(err.message);onError?.(err.message);}
    finally{setBusy(false);}
  }
  async function useLocal(){
    if(!window.confirm('切回这台电脑运行？云端仍会继续运行。本地原有待办保持暂停、主动关心保持关闭，请核对后手动恢复，避免重复消息。'))return;
    setBusy(true);setError('');
    try{const value=await deploymentRequest('/local',{confirm:true});setState(value.deployment||value);setToken('');dirtyCallback.current?.(false);await onChanged?.();onNotice?.('已切回本机。请核对任务列表，再恢复需要在本机执行的提醒。');}
    catch(err){setError(err.message);onError?.(err.message);}
    finally{setBusy(false);}
  }
  return <section className="cloud-deployment" aria-label="完整后台运行位置">
    <header><span className="cloud-deployment-icon">{cloudMode?<Cloud size={25}/>:<Monitor size={25}/>}</span><div><h2>让助手持续运行</h2><p>选择完整后台的位置，聊天、记忆、提醒和主动关心一起运行。</p></div><span className={'cloud-deployment-status '+(connected?'is-online':cloudMode?'is-offline':'')}>{cloudMode?connected?'云端已连接':'云端暂时不可用':'当前在本机'}</span></header>
    <div className="cloud-deployment-summary"><strong>{cloudMode?(cloud.instanceName||cloud.serverName||'我的云端后台'):'这台电脑'}</strong><p>{cloudMode?'任务由云端执行，关闭这台电脑不会停止云端后台。云端服务本身需保持运行。':'本机运行需要保持电脑和应用开启。连接完整云端后台后，电脑可以关机。'}</p>{cloudMode&&!cloud.online&&<p role="alert">目前无法读取云端最新状态；显示的旧记录不能当作任务已完成。你仍可在这里重新连接或切回本机。</p>}{state?.localTasksPaused&&<p>切换前的本地待办已暂停，主动关心已关闭；原数据保留，没有自动迁移到云端。</p>}</div>
    <DeploymentGuide onNotice={onNotice}/><div className="cloud-deployment-form"><h3>{cloudMode?'管理云端连接':'连接我的云端后台'}</h3><p>先在服务器安装 MioBot 服务端，再填写服务地址和连接密钥。这里不会购买服务器，也不会自动迁移当前助手、聊天、记忆或 API 密钥。</p><label>云端服务地址<input aria-label="云端服务地址" value={url} onChange={event=>{setUrl(event.target.value);setError('');}} placeholder="https://你的云端服务地址" autoComplete="url" spellCheck={false}/></label><label>连接密钥<input aria-label="云端连接密钥" type="password" autoComplete="new-password" value={token} onChange={event=>{setToken(event.target.value);setError('');}} placeholder={sameSaved?'已保存；留空保留':'只在这里填写，不会回显'}/></label><small><ShieldCheck size={13}/>密钥只用于连接你的后台，不会展示在页面或带进聊天。</small>{(error||cloud.error)&&<p className="cloud-deployment-error" role="alert">{error||productText(cloud.error)}</p>}<div className="cloud-deployment-actions"><button type="button" className="cs-button" disabled={busy||!url.trim()} onClick={connect}>{busy?<LoaderCircle size={15} className="spin"/>:<Link2 size={15}/>}验证并连接云端</button><button type="button" className="cs-button is-secondary" disabled={busy} onClick={reload}><RefreshCw size={15}/>检查连接</button>{cloudMode&&<button type="button" className="cs-button is-secondary" disabled={busy} onClick={useLocal}><Monitor size={15}/>切回本机运行</button>}</div></div>
  </section>;
}
