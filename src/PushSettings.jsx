import React,{useEffect,useRef,useState} from 'react';
import {Bell,Check,RefreshCw,Smartphone} from 'lucide-react';
import {api} from './client-api.mjs';
import './push-settings.css';

const browserState=()=>({
  secure:globalThis.location?.protocol==='https:'&&globalThis.isSecureContext===true,
  supported:typeof navigator!=='undefined'&&'serviceWorker'in navigator&&typeof PushManager!=='undefined'&&typeof Notification!=='undefined',
  permission:typeof Notification!=='undefined'?Notification.permission:'unsupported',
  ios:typeof navigator!=='undefined'&&(/iP(?:hone|ad|od)/.test(navigator.userAgent)||navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1),
  standalone:globalThis.matchMedia?.('(display-mode: standalone)').matches===true||globalThis.navigator?.standalone===true,
});
function bytes(value){const normalized=value.replace(/-/g,'+').replace(/_/g,'/'),raw=atob(normalized);return Uint8Array.from(raw,c=>c.charCodeAt(0));}

/** Called only from a button; registering a worker never caches personal API data. */
export default function PushSettings({onNotice,onChange}){
  const [info,setInfo]=useState(null),[browser,setBrowser]=useState(browserState),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const live=useRef(true);
  async function refresh(){const next=await api('/push');if(live.current){setInfo(next);setBrowser(browserState());onChange?.(next);}return next;}
  useEffect(()=>{live.current=true;refresh().catch(e=>{if(live.current)setError(e.message);});const focus=()=>{setBrowser(browserState());};window.addEventListener('focus',focus);return()=>{live.current=false;window.removeEventListener('focus',focus);};},[]);
  const installationNeeded=browser.ios&&!browser.standalone,canEnable=browser.secure&&browser.supported&&!installationNeeded&&browser.permission!=='denied'&&!!info?.publicKey;
  function say(text){setNotice(text);onNotice?.(text);}
  async function enable(){
    if(!canEnable||busy)return;
    setBusy(true);setError('');setNotice('');
    try{
      // Safari requires this call directly in the user-activation handler.
      const permission=await Notification.requestPermission();setBrowser(browserState());
      if(permission!=='granted')throw Error(permission==='denied'?'通知权限没有允许，请在系统或浏览器设置中修改。':'还没有允许通知，这次没有连接。');
      const registration=await navigator.serviceWorker.register('/sw.js',{scope:'/'});
      let timer;try{await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('通知组件还没有准备好，请稍后重试。')),10000);})]);}finally{clearTimeout(timer);}
      let subscription=await registration.pushManager.getSubscription();
      if(subscription){const previous=subscription.options?.applicationServerKey,current=bytes(info.publicKey);if(previous&&(new Uint8Array(previous).length!==current.length||![...new Uint8Array(previous)].every((b,i)=>b===current[i]))){await subscription.unsubscribe();subscription=null;}}
      if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes(info.publicKey)});
      const next=await api('/push/subscription','POST',{subscription:subscription.toJSON()});setInfo(next);onChange?.(next);
      say('通知连接已保存。请发送一条测试，核对这部设备是否真的收到。');
    }catch(e){setError(e.message||'通知连接没有完成，请重试。');}
    finally{setBusy(false);}
  }
  async function disable(){
    setBusy(true);setError('');setNotice('');
    try{
      await api('/push/subscription','DELETE',{});
      const registration=await navigator.serviceWorker?.getRegistration('/'),subscription=await registration?.pushManager.getSubscription();
      if(subscription)await subscription.unsubscribe();
      await refresh();say('这部设备的通知连接已关闭，后台任务仍会保存在收件箱。');
    }catch(e){setError(e.message||'通知连接没有关闭成功。');await refresh().catch(()=>{});}
    finally{setBusy(false);}
  }
  async function test(){
    setBusy(true);setError('');setNotice('');
    try{
      const result=await api('/push/test','POST',{});await refresh();
      if(result.accepted>0)say('推送服务已接受测试。请核对手机锁屏或通知中心；这还不代表手机已显示或已读。');
      else throw Error('这条测试未被推送服务接受，请检查网络或重新连接通知。');
    }catch(e){setError(e.message||'这次测试没有完成。');}finally{setBusy(false);}
  }
  const title=!browser.secure?'需要 HTTPS 连接':installationNeeded?'先添加到手机主屏幕':!browser.supported?'当前浏览器不支持通知':browser.permission==='denied'?'通知权限未允许':info?.subscribed?'已连接这部设备':'连接手机通知';
  return <section className="miobot-push-settings" aria-label="手机通知设置"><div className="mpush-heading"><span><Bell size={24}/></span><div><h3>{title}</h3><p>{info?.subscribed?'后台已保存浏览器订阅；实际送达以测试为准。':'在有新安排或任务结果时接收通知。'}</p></div></div>
    {!browser.secure&&<p className="mpush-note">目前这个 HTTP 局域网地址只能查看收件箱。请连接可访问的 HTTPS 后台，再启用系统通知。</p>}
    {installationNeeded&&<p className="mpush-note"><Smartphone size={16}/>在 Safari 分享菜单中选择「添加到主屏幕」，从新图标打开 MioBot，再点「允许通知」。需要支持网页推送的 iOS 版本。</p>}
    {browser.permission==='denied'&&<p className="mpush-note">系统或浏览器已阻止通知。请在设置中允许 MioBot 通知后，再回到这里连接。</p>}
    <p className="mpush-note">通知只显示简短提示，消息正文保存在当前后台。专注模式、系统设置和网络可能影响显示；通知不是保证响铃的闹钟。</p>
    <div className="mpush-actions">{!info?.subscribed?<button type="button" onClick={enable} disabled={busy||!canEnable}><Bell size={16}/>允许通知并连接</button>:<><button type="button" onClick={test} disabled={busy||!browser.secure}><Check size={16}/>发送测试通知</button><button type="button" className="is-secondary" onClick={disable} disabled={busy}>关闭这部设备的通知</button></>}<button type="button" className="is-secondary" onClick={()=>{setBusy(true);setError('');refresh().catch(e=>setError(e.message)).finally(()=>setBusy(false));}} disabled={busy}><RefreshCw size={15}/>刷新状态</button></div>
    {busy&&<p className="mpush-note" role="status">正在处理通知连接…</p>}{error&&<p className="mpush-error" role="alert">{error}</p>}{notice&&<p className="mpush-success" role="status">{notice}</p>}
    {info?.lastDelivery&&<p className="mpush-note">最近一次：{info.lastDelivery.status==='accepted'?'服务接受':info.lastDelivery.status==='expired'?'订阅已失效':info.lastDelivery.status==='sending'?'发送结果尚未确认':'未发送成功'}，不代表设备已显示或已读。</p>}
  </section>;
}

/** Mount once in the mobile shell so clicking a push can open its inbox. */
export function usePushNavigation(onOpen){
  const callback=useRef(onOpen);callback.current=onOpen;
  useEffect(()=>{
    function open(id){if(typeof id==='string'&&/^[-_:A-Za-z0-9]{1,160}$/.test(id))callback.current?.(id);}
    function message(event){if(event.data?.type==='miobot:open-notification')open(event.data.notificationId);}
    navigator.serviceWorker?.addEventListener('message',message);
    const url=new URL(location.href),id=url.searchParams.get('notification');
    if(id){url.searchParams.delete('notification');history.replaceState(null,'',url.pathname+url.search+url.hash);open(id);}
    return()=>navigator.serviceWorker?.removeEventListener('message',message);
  },[]);
}
