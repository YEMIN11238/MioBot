import React,{useEffect,useState} from 'react';
import {Puzzle,ChevronRight,Check,RefreshCw} from 'lucide-react';
import {extensionRequest} from './extensions-api.mjs';
import './cloud-plugin-bundles.css';

const labels={bundled:'已内置 · 未启用',loaded:'已加载 · 待实际使用验证',needs_restart:'未加载，请检查配置',missing:'组件文件缺失'};
export default function CloudPluginBundles({data,onDirty,onNavigate,onRefresh,onNotice}){
  const [open,setOpen]=useState(false),[items,setItems]=useState([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [config,setConfig]=useState(''),[secrets,setSecrets]=useState({}),[channel,setChannel]=useState(''),[dirty,setDirty]=useState(false);
  const item=items.find(p=>p.id===selected),channels=(data.channels||[]).filter(c=>c.type==='aiocqhttp');
  useEffect(()=>{onDirty?.(dirty);},[dirty]);
  useEffect(()=>()=>onDirty?.(false),[]);
  async function load(){const r=await extensionRequest('/bundled-plugins','GET');setItems(r.items||[]);return r.items||[];}
  useEffect(()=>{if(open)load().catch(e=>setError(e.message));},[open]);
  function select(next){if(dirty&&!window.confirm('组件配置尚未保存，放弃修改？'))return;setSelected(next.id);setConfig(JSON.stringify(next.config,null,2));setSecrets({});setChannel(next.channelId||'');setDirty(false);setError('');}
  async function save(enabled){
    setBusy(true);setError('');
    try{
      let value;try{value=JSON.parse(config);}catch{throw Error('配置不是有效 JSON，请检查逗号、引号和括号。');}
      const r=await extensionRequest('/bundled-plugins/'+item.id,'PATCH',{enabled,channelId:channel,config:value,secrets});
      const list=await load(),updated=list.find(p=>p.id===item.id)||r.item;
      setConfig(JSON.stringify(updated.config,null,2));setSecrets({});setChannel(updated.channelId||'');setDirty(false);await onRefresh?.();onNotice?.(enabled?'组件已加载，请在绑定的 QQ 会话验证实际效果。':'配置已保存，组件当前停用。');
    }catch(e){setError(e.message);await load().catch(()=>{});}finally{setBusy(false);}
  }
  return <details className="cloud-plugin-bundles" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary><Puzzle size={17}/>大肥鱼同款组件<span>已内置，按需配置</span></summary>
    <p>这些组件已随软件提供，无需到插件市场另行下载。它们用于 QQ 渠道，每个组件绑定一个助手的主人私聊；启停或修改已启用组件会重启后台，请等回复完成后操作。</p>
    {!channels.length&&<p className="extension-small">先保存配置也可以。准备使用时，到<button type="button" className="extension-inline-link" onClick={()=>onNavigate?.('settings','channels')}>消息渠道</button>连接并验证 QQ，再选择接收会话。</p>}
    <div className="cpb-layout"><div className="cpb-list">{items.map(p=><button type="button" key={p.id} className={'cpb-item '+(selected===p.id?'is-selected':'')} onClick={()=>select(p)} disabled={busy}><span><strong>{p.name}</strong><small>{labels[p.status]||p.status}</small></span><ChevronRight size={16}/></button>)}</div>
    {item&&<section className="extension-editor cpb-editor" aria-label={item.name+'配置'}><header><h2>{item.name}</h2><small>{item.version}</small></header><p>{item.description}</p><p className="extension-small">这里管理 QQ 原生组件。电脑和手机聊天现有的语音、图库配置继续在上方管理；两套图库不会自动合并。</p>
      <label>绑定 QQ 主人会话<select aria-label="组件绑定渠道" value={channel} disabled={busy} onChange={e=>{setChannel(e.target.value);setDirty(true);}}><option value="">稍后配置</option>{channels.map(c=><option key={c.id} value={c.id}>{c.name} · {data.assistants?.find(a=>a.id===c.assistantId)?.name||'未绑定助手'}{c.status==='verified'?'':' · 待验证'}</option>)}</select></label>
      <p className="extension-small">主人身份由这个渠道的私聊目标填写。QQ 资料和空间操作需要该主人会话，不能从其他账号调用。</p>
      <details><summary>高级配置</summary><label>组件参数（JSON）<textarea aria-label="组件参数" spellCheck={false} rows={14} value={config} disabled={busy} onChange={e=>{setConfig(e.target.value);setDirty(true);}}/></label><p className="extension-small">服务凭据请填下方；空白表示保留。学习和自动收集默认为关闭，需明确配置后使用。</p></details>
      {item.secretFields?.map(f=><label key={f.path}>{f.label}<input type="password" autoComplete="new-password" aria-label={f.label} value={secrets[f.path]||''} placeholder={f.saved?'已保存；留空保留':'尚未配置'} disabled={busy} onChange={e=>{setSecrets(s=>({...s,[f.path]:e.target.value}));setDirty(true);}}/></label>)}
      {item.error&&<p className="extension-error">{item.error}</p>}<div className="extension-editor-actions"><button type="button" className="cs-button" disabled={busy||!item.present} onClick={()=>save(true)}>{busy?<RefreshCw size={15} className="spin"/>:<Check size={15}/>}保存并启用</button><button type="button" className="cs-button is-secondary" disabled={busy||!item.present} onClick={()=>save(false)}>{item.enabled?'保存并停用':'仅保存配置'}</button></div>
      <p className="extension-small">加载成功只说明组件可运行。语音可能消耗服务额度；发图、唱歌、资料修改和空间操作需在 QQ 核对结果。</p>
    </section>}</div>{error&&<p className="extension-error" role="alert">{error}</p>}
  </details>;
}
