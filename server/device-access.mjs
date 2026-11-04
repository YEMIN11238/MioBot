import {timingSafeEqual} from 'node:crypto';
import {parseCookie} from './device-sessions.mjs';
import {localOwnerRequest,sameDeviceOrigin} from './device-network.mjs';

/** Device grants belong to this personal instance, never to the model provider. */
export function requestIdentity(req,{devices,cloudMode,cloudToken}){
  if(!sameDeviceOrigin(req))return null;
  const authorization=req.headers.authorization;
  if(authorization!==undefined){
    if(!cloudMode||!cloudToken)return null;
    const supplied=Buffer.from(String(authorization)),expected=Buffer.from('Bearer '+cloudToken);
    return supplied.length===expected.length&&timingSafeEqual(supplied,expected)?{owner:true}:null;
  }
  const token=parseCookie(req.headers.cookie);
  if(token){const device=devices.authenticate(token);return device?{owner:false,device,token}:null;}
  return !cloudMode&&localOwnerRequest(req)?{owner:true}:null;
}

export function personalRoute(path,method){
  if(path==='/api/device-session')return ['GET','DELETE'].includes(method);
  if(path==='/api/state'||path==='/api/deployment'||path==='/api/extensions')return method==='GET';
  if(path.startsWith('/api/media/'))return ['GET','HEAD'].includes(method);
  if(path==='/api/push')return method==='GET';
  if(path==='/api/push/subscription')return ['POST','DELETE'].includes(method);
  if(path==='/api/push/test')return method==='POST';
  if(path==='/api/rss/sources')return ['GET','POST'].includes(method);
  if(/^\/api\/rss\/sources\/[^/]+$/.test(path))return method==='DELETE';
  if(path==='/api/workflows')return ['GET','POST'].includes(method);
  if(/^\/api\/workflows\/[^/]+$/.test(path))return method==='PATCH';
  if(/^\/api\/workflows\/[^/]+\/run$/.test(path))return method==='POST';
  if(path==='/api/notifications/read')return method==='POST';
  if(path==='/api/chats')return method==='POST';
  if(/^\/api\/chats\/[^/]+(?:\/(?:messages(?:\/stream)?|retry\/stream|cancel|run))?$/.test(path))return ['GET','POST','PATCH'].includes(method);
  if(path==='/api/tasks'||/^\/api\/tasks\/[^/]+$/.test(path))return ['POST','PATCH'].includes(method);
  if(path==='/api/memories'||/^\/api\/memories\/[^/]+$/.test(path))return ['POST','PATCH','DELETE'].includes(method);
  if(path==='/api/long-memories'||/^\/api\/long-memories\/[^/]+$/.test(path))return ['GET','DELETE'].includes(method);
  if(/^\/api\/assistants\/[^/]+$/.test(path))return method==='PATCH';
  return false;
}
