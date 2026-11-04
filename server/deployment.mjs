import {randomUUID} from 'node:crypto';

export function cloudURL(value){
  let url;try{url=new URL(String(value||'').trim());}catch{throw Error('请填写完整的云端服务地址');}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&!(local&&url.protocol==='http:'))throw Error('云端连接需要 HTTPS；本机测试可使用 localhost');
  if(url.username||url.password||url.search||url.hash)throw Error('服务地址不能包含账号、密码或查询参数');
  return url.href.replace(/\/+$/,'');
}

/** The desktop keeps its own recovery controls even when the remote is offline. */
export class Deployment{
  constructor({store,runtime,isBusy=()=>false,fetcher=fetch,cloudMode=false}){
    Object.assign(this,{store,runtime,isBusy,fetcher,cloudMode});this.controllers=new Set();
    store.state.deployment||={mode:'local'};this.online=false;this.error='';this.checkedAt=0;
  }
  get mode(){return !this.cloudMode&&this.store.state.deployment.mode==='cloud'?'cloud':'local';}
  get paired(){return !!this.store.secrets.cloudConnection?.token;}
  async probe(url=this.store.secrets.cloudConnection?.url,token=this.store.secrets.cloudConnection?.token){
    if(!url||!token)throw Error('尚未配对云端后台');
    const r=await this.fetcher(url+'/api/cloud/info',{headers:{Authorization:'Bearer '+token,'X-Personal-Agent':'1'},redirect:'error',signal:AbortSignal.timeout(8000)});
    if(r.status===401||r.status===403)throw Error('连接密钥不正确或已失效');
    if(!r.ok)throw Error('云端服务暂时不可用（'+r.status+'）');
    let info;try{info=await r.json();}catch{throw Error('该地址没有返回 MioBot 云端服务信息');}
    if(info.product!=='MioBot'||info.apiVersion!==1||!info.instanceId)throw Error('请连接完整的 MioBot 服务端；普通对话后台不能代替云端服务');
    return info;
  }
  async status({refresh=true}={}){
    const connection=this.store.secrets.cloudConnection||{};
    if(refresh&&this.mode==='cloud'&&Date.now()-this.checkedAt>2000){try{this.info=await this.probe();this.online=true;this.error='';}catch(e){this.online=false;this.error=this.safe(e);}this.checkedAt=Date.now();}
    return {mode:this.mode,isServer:this.cloudMode,cloud:{url:connection.url||'',paired:this.paired,online:this.mode==='cloud'&&this.online,instanceName:this.info?.name||connection.instanceName||'',...(this.error?{error:this.error}:{})},localTasksPaused:!!this.store.state.deployment.localTasksPaused};
  }
  safe(error){return String(error?.message||'云端连接失败').split(this.store.secrets.cloudConnection?.token||'\0').join('[已隐藏]').slice(0,240);}
  async connect({url,token}){
    if(this.cloudMode)throw Error('云端服务自身无需再配对其他服务器');
    if(this.isBusy())throw Error('请等当前回复或操作完成后再切换运行位置');
    url=cloudURL(url);const prior=this.store.secrets.cloudConnection||{};
    token=String(token||'').trim()||(url===prior.url?prior.token:'');
    if(!token||token.length<16||token.length>512||/[\r\n]/.test(token))throw Error('请填写有效的连接密钥');
    let info;try{info=await this.probe(url,token);}catch(e){throw Error(String(e.message).split(token).join('[已隐藏]'));}
    if(this.isBusy())throw Error('当前有新的回复正在进行，连接已验证，请稍后再切换');
    const at=new Date().toISOString();
    for(const t of this.store.state.tasks)if(t.status==='pending'){t.status='paused';t.logs.push({at,text:'已切换云端，本机任务暂停；没有自动迁移。'});}
    for(const w of this.store.state.workflows||[])if(w.status==='active'){w.status='paused';w.revision++;w.bindingStatus='needs_runtime';}
    for(const a of this.store.state.assistants)if(a.care?.enabled)a.care.enabled=false;
    const child=this.runtime.child;this.runtime.stop();
    if(child&&child.exitCode===null)await new Promise(resolve=>{const timeout=setTimeout(resolve,5000);child.once('exit',()=>{clearTimeout(timeout);resolve();});});
    this.store.setSecrets({cloudConnection:{url,token,instanceName:info.name||'我的云端后台',instanceId:info.instanceId}});
    this.store.state.deployment={mode:'cloud',localTasksPaused:true,changedAt:at};this.store.save();
    this.info=info;this.online=true;this.error='';this.checkedAt=Date.now();return this.status({refresh:false});
  }
  async useLocal({confirm}={}){
    if(confirm!==true)throw Error('请确认切回本机；云端会继续运行，本地任务不会自动恢复');
    if(this.isBusy())throw Error('请等当前回复完成后再切换');
    this.store.state.deployment={...this.store.state.deployment,mode:'local'};this.store.save();this.online=false;this.error='';
    if(this.runtime.isInstalled()&&!this.runtime.child&&this.store.state.settings.location==='local')void this.runtime.start().catch(e=>{this.runtime.error=this.runtime.safeError(e);});
    return this.status({refresh:false});
  }
  async proxy(req,res,path){
    const {url,token}=this.store.secrets.cloudConnection||{};if(!url||!token)throw Error('请先配对云端服务');
    const controller=new AbortController();this.controllers.add(controller);
    const close=()=>{if(!res.writableEnded)controller.abort();};res.on('close',close);
    try{
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16*1024*1024)throw Error('提交内容过大');chunks.push(chunk);}
      const r=await this.fetcher(url+path,{method:req.method,headers:{Authorization:'Bearer '+token,'X-Personal-Agent':'1','Content-Type':req.headers['content-type']||'application/json','X-MioBot-Request':randomUUID()},...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)}),redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(240000)])});
      this.online=true;this.error='';this.checkedAt=Date.now();
      res.writeHead(r.status,{'Content-Type':r.headers.get('content-type')||'application/json','Cache-Control':'no-store',...(r.headers.get('content-disposition')?{'Content-Disposition':r.headers.get('content-disposition')}:{})});
      if(r.body)for await(const chunk of r.body){if(res.destroyed)break;res.write(chunk);}if(!res.writableEnded)res.end();
    }catch(e){if(!controller.signal.aborted){this.online=false;this.error=this.safe(e);if(!res.headersSent){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'云端连接中断，请在运行位置重新连接。'}));}else res.end();}}
    finally{this.controllers.delete(controller);res.off('close',close);}
  }
  close(){for(const controller of this.controllers)controller.abort();}
}
