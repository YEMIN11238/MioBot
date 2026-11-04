import http from 'node:http';
import {networkInterfaces} from 'node:os';

export function loopbackPeer(value=''){
  return value==='::1'||value==='127.0.0.1'||value.startsWith('127.')||value.startsWith('::ffff:127.');
}

export function localOwnerRequest(req){
  return req.headers['x-personal-agent']==='1'&&loopbackPeer(req.socket.remoteAddress)&&/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(req.headers.host||'');
}

export function sameDeviceOrigin(req){
  if(!req.headers.origin)return true;
  try{const origin=new URL(req.headers.origin),protocol=req.socket.encrypted===true||req.headers['x-forwarded-proto']==='https'?'https:':'http:';return origin.protocol===protocol&&origin.host===req.headers.host;}catch{return false;}
}

function lanAddresses(port){
  const found=new Set();
  for(const values of Object.values(networkInterfaces()))for(const entry of values||[]){
    const address=entry.address;
    if(entry.internal||entry.family!=='IPv4'||!/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address))continue;
    found.add('http://'+address+':'+port);
  }
  return [...found];
}

function closeListener(server){
  return new Promise((resolve,reject)=>{
    server.close(error=>error&&error.code!=='ERR_SERVER_NOT_RUNNING'?reject(error):resolve());
    // Stop accepting first, then close existing connections; a new connection
    // cannot slip in between these two steps and keep shutdown pending.
    server.closeAllConnections?.();
  });
}
function restoreSharing(store,previous,had){
  if(had)store.state.deviceSharing=previous;else delete store.state.deviceSharing;
}

/** Network exposure is a separate opt-in listener; every API still authenticates. */
export class DeviceNetwork{
  constructor({store,listener,port=4319}){Object.assign(this,{store,listener,port});this.server=null;this.error='';this.pending=Promise.resolve();}
  status(){const enabled=this.server?.listening===true,address=this.server?.address(),port=address&&typeof address==='object'?address.port:this.port;return {enabled,urls:enabled?lanAddresses(port):[],port,...(this.error?{error:this.error}:{})};}
  change(operation){const result=this.pending.then(operation,operation);this.pending=result.catch(()=>{});return result;}
  enable(){return this.change(()=>this.open());}
  async open(){
    if(this.server?.listening)return this.status();
    const server=http.createServer(this.listener);
    server.on('error',()=>{this.error='手机连接服务发生错误，请检查连接状态后重试。';});
    server.on('close',()=>{if(this.server===server)this.server=null;});
    try{
      await new Promise((resolve,reject)=>{
        const cleanup=()=>{server.off('error',failed);server.off('listening',ready);};
        const failed=error=>{cleanup();reject(error);},ready=()=>{cleanup();resolve();};
        server.once('error',failed);server.once('listening',ready);server.listen(this.port,'0.0.0.0');
      });
    }catch{await closeListener(server);this.error='手机连接端口暂时不可用，请检查是否被其他程序使用。';throw Error(this.error);}
    const previous=this.store.state.deviceSharing,had=Object.hasOwn(this.store.state,'deviceSharing');
    try{this.store.state.deviceSharing={enabled:true};this.store.save();}
    catch{
      restoreSharing(this.store,previous,had);await closeListener(server);
      this.error='手机连接设置未能保存，网络访问已关闭。';throw Object.assign(Error(this.error),{status:503,code:'DEVICE_SHARING_SAVE_FAILED'});
    }
    this.server=server;this.error='';return this.status();
  }
  disable(options={}){return this.change(()=>this.stop(options));}
  async stop({persist=true}={}){
    const server=this.server,previous=this.store.state.deviceSharing,had=Object.hasOwn(this.store.state,'deviceSharing');let saveFailed=false;
    if(persist){try{this.store.state.deviceSharing={enabled:false};this.store.save();}catch{restoreSharing(this.store,previous,had);saveFailed=true;}}
    // Even when persistence fails, turning off network access must close the
    // active listener. Retain its reference until close has actually completed.
    if(server)await closeListener(server);
    if(this.server===server)this.server=null;
    if(saveFailed){this.error='手机连接已关闭，但关闭设置未保存；下次启动可能按原设置开启。';throw Object.assign(Error(this.error),{status:503,code:'DEVICE_SHARING_SAVE_FAILED'});}
    this.error='';
    return this.status();
  }
}
