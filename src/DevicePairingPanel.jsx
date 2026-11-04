import React,{useEffect,useState} from 'react';
import {Smartphone,QrCode,Copy,RefreshCw,ShieldCheck,Unplug,LoaderCircle} from 'lucide-react';
import QRCode from 'qrcode';
import {api} from './client-api.mjs';
import './device-pairing.css';

function reachable(value){
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!['localhost','0.0.0.0','[::]','[::1]'].includes(url.hostname)&&!url.hostname.startsWith('127.')&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}
}

export default function DevicePairingPanel({deployment,onNotice}){
  const [network,setNetwork]=useState(null),[devices,setDevices]=useState([]),[base,setBase]=useState(''),[pair,setPair]=useState(null),[qr,setQR]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const cloud=deployment?.mode==='cloud',cloudURL=deployment?.cloud?.url||'';
  async function refresh(){
    const [sharing,sessions]=await Promise.all([api('/device-sharing'),api('/devices')]);
    setNetwork(sharing);setDevices(sessions.devices||[]);setBase(current=>cloud?cloudURL:sharing.urls?.includes(current)?current:sharing.urls?.[0]||'');
  }
  useEffect(()=>{refresh().catch(e=>setError(e.message));setPair(null);setQR('');},[cloud,cloudURL]);
  useEffect(()=>{
    let active=true;setQR('');
    if(pair&&reachable(base)){
      const url=new URL(base);url.searchParams.set('mobile','1');url.hash=new URLSearchParams({pair:pair.code,instance:pair.instanceId}).toString();
      QRCode.toDataURL(url.href,{width:220,margin:2,color:{dark:'#58407c',light:'#ffffff'}}).then(value=>{if(active)setQR(value);}).catch(()=>{if(active)setError('二维码暂时无法显示，可以在手机网页输入下方配对码。');});
    }
    return()=>{active=false;};
  },[pair,base]);
  useEffect(()=>{
    if(!pair)return;
    const wait=Math.max(0,Date.parse(pair.expiresAt)-Date.now());
    const timer=setTimeout(()=>{setPair(null);setQR('');},wait);return()=>clearTimeout(timer);
  },[pair]);
  async function act(operation){setBusy(true);setError('');try{await operation();}catch(e){setError(e.message);}finally{setBusy(false);}}
  function changeSharing(){return act(async()=>{const sharing=await api('/device-sharing','POST',{enabled:!network?.enabled});setNetwork(sharing);setBase(sharing.urls?.[0]||'');setPair(null);setQR('');});}
  function create(){return act(async()=>{if(!reachable(base))throw Error('请先连接同一 Wi-Fi，或使用手机可访问的云端 HTTPS 地址。');setPair(await api('/devices/pairings','POST',{label:'我的手机'}));});}
  async function copy(value){try{await navigator.clipboard.writeText(value);onNotice?.('已复制，请只交给自己的设备使用。');}catch{setError('未能自动复制，可以直接选择配对码复制。');}}
  function revoke(device){if(!window.confirm('断开“'+device.label+'”？这台设备需要重新配对才能继续访问。'))return;return act(async()=>{await api('/devices/'+encodeURIComponent(device.id),'DELETE');await refresh();onNotice?.('已撤销这台设备的访问。');});}
  return <section className="device-pairing-panel" aria-label="连接手机与设备授权">
    <header><span className="device-pairing-icon"><Smartphone size={24}/></span><div><h2>连接手机</h2><p>在手机上继续聊天，查看相同的安排和记忆。</p></div></header>
    {!cloud&&<div className="device-sharing-row"><div><strong>同一 Wi-Fi 访问</strong><p>{network?.enabled?'电脑和 MioBot 保持运行时，已配对的手机可以连接。':'默认关闭。开启后，手机仍需要一次性配对码才能访问资料。'}</p></div><button type="button" className="cs-button is-secondary" disabled={busy||!network} onClick={changeSharing}>{busy?<LoaderCircle size={15} className="spin"/>:network?.enabled?'关闭访问':'允许连接'}</button></div>}
    {cloud&&<p className="device-pairing-note">手机会直接连接这台云端后台，不经过当前电脑。</p>}
    {(cloud||network?.enabled)&&<div className="device-pairing-create">
      {!cloud&&network?.urls?.length>1&&<label>手机可访问的地址<select value={base} onChange={event=>{setBase(event.target.value);setPair(null);}}>{network.urls.map(url=><option value={url} key={url}>{url}</option>)}</select></label>}
      {reachable(base)?<p className="device-pairing-address">{base}</p>:<p className="device-pairing-note">{cloud?'当前是本机转发地址，手机无法直接访问。请先将云端连接改为手机可访问的 HTTPS 地址。':'暂未找到可用的 Wi-Fi 地址，请连接网络后刷新。'}</p>}
      <div className="device-pairing-actions"><button className="cs-button" type="button" onClick={create} disabled={busy||!reachable(base)}><QrCode size={16}/>{pair?'重新生成配对码':'生成手机配对码'}</button><button type="button" className="cs-button is-secondary" disabled={busy} onClick={()=>act(refresh)}><RefreshCw size={15}/>刷新</button></div>
      {pair&&<div className="device-pairing-result">{qr&&<img src={qr} width="220" height="220" alt="手机配对二维码"/>}<div><strong>用手机相机扫码打开</strong><p>配对码 5 分钟内有效，只能使用一次。</p><button type="button" className="device-pairing-code" onClick={()=>copy(pair.code)}><span>{pair.code}</span><Copy size={15}/></button><p>也可用手机打开上方地址，输入配对码。</p></div></div>}
    </div>}
    <div className="device-pairing-devices"><h3>已连接设备</h3>{devices.length?devices.map(device=><div className="device-session-row" key={device.id}><Smartphone size={18}/><span><strong>{device.label}</strong><small>最近使用 {new Date(device.lastSeenAt||device.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small></span><button type="button" className="device-revoke" disabled={busy} onClick={()=>revoke(device)}><Unplug size={15}/>断开</button></div>):<p className="device-pairing-note">还没有配对的手机。</p>}</div>
    {error&&<p role="alert" className="cloud-deployment-error">{error}</p>}
    <p className="device-pairing-privacy"><ShieldCheck size={14}/>手机获得独立的可撤销授权，不会收到后台管理密钥。手机系统推送尚未接通，提醒先保存在聊天和收件箱。</p>
  </section>;
}
