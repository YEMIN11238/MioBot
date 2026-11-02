import React,{useEffect,useRef,useState} from 'react';
import {ChevronDown,ExternalLink,FileText,LoaderCircle,X} from 'lucide-react';
import appIcon from '../assets/app-icon.png';
import './about-miobot.css';

const VERSION='0.5.0';
const components=[
  {name:'AstrBot（修改版）',version:'4.29.3',author:'AstrBotDevs 及贡献者',license:'AGPL-3.0-or-later',file:'AstrBot-AGPL-3.0.txt',url:'https://github.com/AstrBotDevs/AstrBot',note:'托管运行时保留上游来源，并包含 MioBot 的消息权限适配。'},
  {name:'LivingMemory',version:'2.8.2',author:'lxfight 及贡献者',license:'AGPL-3.0',file:'LivingMemory-AGPL-3.0.txt',url:'https://github.com/lxfight-s-Astrbot-Plugins/astrbot_plugin_livingmemory',notice:'LivingMemory-INTEGRATION-NOTICE.txt',note:'长期记忆组件；已适配人格隔离。'},
  {name:'Humanizer',version:'4.1.9 · miobot.1',author:'SIiOC 及贡献者',license:'AGPL-3.0',file:'Humanizer-AGPL-3.0.txt',url:'https://github.com/SIiOC/astrbot-plugin-humanizer',notice:'Humanizer-INTEGRATION-NOTICE.txt',note:'聊天风格与时间感知组件；保留原作者和规则来源说明。'},
  {name:'大肥鱼回复清理',version:'0.1.1-miobot',author:'zexuan604 / zexuanw958-svg',license:'来源配置包 MIT',file:'Dafeiyu-Clean-MIT.txt',url:'https://github.com/zexuanw958-svg/dafeiyu-config-pack',notice:'Dafeiyu-Clean-INTEGRATION-NOTICE.txt',note:'插件原目录未单附许可证；来源配置包明确声明其自有代码使用 MIT。'},
  {name:'minecraft-data',version:'3.119.0',author:'Romain Beaumont / PrismarineJS 及贡献者',license:'MIT 声明与来源',file:'Prismarine-NOTICE-MIT.txt',url:'https://github.com/PrismarineJS/node-minecraft-data',note:'使用固定版 Minecraft Java 1.21.8 资料；来源说明保留包内许可声明。'},
  {name:'prismarine-recipe',version:'1.5.0',author:'Romain Beaumont / PrismarineJS 及贡献者',license:'MIT 声明与来源',file:'Prismarine-NOTICE-MIT.txt',url:'https://github.com/PrismarineJS/prismarine-recipe'},
  {name:'主动聊天策略',version:'v1.2.6 · MioBot适配',author:'Pancakes-Labs 及贡献者',license:'AGPL-3.0',file:'Proactive-AGPL-3.0.txt',url:'https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat',notice:'Proactive-INTEGRATION-NOTICE.txt',note:'复用原插件的动态上下文策略，由MioBot统一调度和投递。'},
  {name:'Electron',author:'Electron contributors / GitHub',license:'MIT',file:'Electron-MIT.txt',url:'https://github.com/electron/electron',note:'发行包另保留 Chromium 等第三方组件的原始通知。'},
  {name:'React',author:'Meta / React contributors',license:'MIT',file:'React-MIT.txt',url:'https://github.com/facebook/react'},
  {name:'React DOM',author:'Meta / React contributors',license:'MIT',file:'React-DOM-MIT.txt',url:'https://github.com/facebook/react'},
  {name:'Lucide',author:'Lucide contributors',license:'ISC',file:'Lucide-ISC.txt',url:'https://github.com/lucide-icons/lucide'},
  {name:'react-parallax-tilt',version:'1.7.349',author:'Marko Kosir',license:'MIT',file:'react-parallax-tilt-MIT.txt',url:'https://github.com/mkosir/react-parallax-tilt'},
  {name:'CPython',version:'3.12.15',author:'Python Software Foundation 及贡献者',license:'PSF 与原始第三方许可',file:'CPython-LICENSE.txt',url:'https://github.com/python/cpython',note:'运行包保留 Python 及各依赖的原始许可证。'},
];

/** Product information lives outside everyday setup and operation flows. */
export default function AboutMioBot({onClose}){
  const viewer=useRef(null);
  const [document,setDocument]=useState(null),[text,setText]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    if(!document)return;
    const controller=new AbortController();setLoading(true);setError('');setText('');
    fetch('/licenses/'+document.file,{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw new Error('许可文件暂时无法读取，请稍后重试。');
      const value=await response.text();
      if(/^\s*<!doctype html/i.test(value))throw new Error('许可文件暂时无法读取，请稍后重试。');
      if(!controller.signal.aborted)setText(value);
    }).catch(err=>{if(err.name!=='AbortError')setError(err.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[document]);
  useEffect(()=>{if(document){viewer.current?.scrollIntoView({block:'nearest'});viewer.current?.focus({preventScroll:true});}},[document,loading]);
  const open=(title,file)=>setDocument({title,file});
  return <div className="mio-about">
    <div className="mio-about-identity"><img src={appIcon} alt="MioBot" width="74" height="74"/><div><h2>MioBot</h2><span>版本 {VERSION} · 本地测试版</span></div></div>
    <p className="mio-about-description">让助手、对话、记忆和任务，都有一个清楚好用的入口。</p>
    <div className="mio-about-product-license"><span>MioBot 项目许可 · AGPL-3.0-only</span><button type="button" onClick={()=>open('MioBot 项目许可证','MioBot-AGPL-3.0.txt')}><FileText size={14}/>查看许可</button></div>
    <details className="mio-about-components"><summary><span>开源组件与许可</span><ChevronDown size={15}/></summary><p className="mio-about-source-note">MioBot 基于以下开源项目进行整合与适配，保留原作者署名、许可证与修改说明。本地测试版源码及构建脚本随项目保留，公共仓库尚未发布。</p><ul>{components.map(item=><li key={item.name}><div className="mio-about-component-heading"><strong>{item.name}</strong>{item.version&&<span>{item.version}</span>}</div><small>{item.author}</small>{item.note&&<p>{item.note}</p>}<div className="mio-about-component-links"><button type="button" onClick={()=>open(item.name+' · '+item.license,item.file)}><FileText size={12}/>{item.license}</button><a href={item.url} target="_blank" rel="noreferrer"><ExternalLink size={12}/>项目来源</a>{item.notice&&<button type="button" onClick={()=>open(item.name+' · 整合与修改说明',item.notice)}>修改说明</button>}</div></li>)}</ul><button className="mio-about-all-notices" type="button" onClick={()=>open('完整第三方组件说明','THIRD-PARTY-NOTICES.txt')}><FileText size={14}/>查看完整第三方说明</button></details>
    {document&&<section ref={viewer} tabIndex={-1} className="mio-about-license-view" aria-label="许可文件内容"><div><h3>{document.title}</h3><button type="button" aria-label="收起许可内容" onClick={()=>setDocument(null)}><X size={16}/></button></div>{loading?<p role="status"><LoaderCircle size={15} className="spin"/>正在读取许可…</p>:error?<p role="alert">{error}</p>:<pre tabIndex={0}>{text}</pre>}</section>}
    {onClose&&<div className="mio-about-footer"><button type="button" onClick={onClose}>完成</button></div>}
  </div>;
}
