import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';

export const DEVICE_COOKIE='miobot_device';
export const PAIRING_TTL=5*60*1000;
export const DEVICE_SESSION_TTL=30*24*60*60*1000;
const ALPHABET='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const TOKEN=/^mdev_[A-Za-z0-9_-]{43}$/;
const HASH=/^[a-f0-9]{64}$/;
const MAX_PAIRINGS=8,MAX_DEVICES=32,MAX_FAILURES=8,FAILURE_WINDOW=10*60*1000;
const hash=value=>createHash('sha256').update(value).digest('hex');
const equal=(left,right)=>typeof left==='string'&&typeof right==='string'&&HASH.test(left)&&HASH.test(right)&&timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
const failure=(status,code,message,extra={})=>Object.assign(new Error(message),{status,code,...extra});
function argumentsObject(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw failure(400,'INVALID_DEVICE_REQUEST','设备连接参数需要有效对象。');
  return value;
}
function label(value,fallback){
  if(value===undefined)return fallback;
  if(typeof value!=='string'||!value.trim()||value.length>80||/[<>\u0000-\u001f\u007f]/.test(value))throw failure(400,'INVALID_DEVICE_LABEL','设备名称需要1到80个普通字符。');
  return value.trim();
}
function codeValue(value){
  if(typeof value!=='string'||value.length>32)return '';
  const code=value.toUpperCase().replace(/[ -]/g,'');
  return /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/.test(code)?code:'';
}
function publicDevice(record){
  return {id:record.id,label:record.label,role:'personal',createdAt:record.createdAt,expiresAt:record.expiresAt,lastSeenAt:record.lastSeenAt,...(record.revokedAt?{revokedAt:record.revokedAt}:{})};
}

/** Independent, revocable device grants for the single owner of this instance.
 * Caller authorization and allowed routes remain the HTTP server's responsibility.
 * Only hashes are persisted; a pairing code is returned once to its issuing owner.
 */
export class DeviceSessions{
  constructor({store,now=Date.now}){
    if(!store?.secrets||typeof store.setSecrets!=='function'||typeof now!=='function')throw Error('设备授权存储未准备完成。');
    this.store=store;this.now=now;this.failures=new Map();
  }
  registry(){
    const value=this.store.secrets.deviceAccess;
    if(value===undefined)return {version:1,pairings:[],sessions:[]};
    if(value?.version!==1||!Array.isArray(value.pairings)||!Array.isArray(value.sessions))throw failure(503,'DEVICE_STORE_INVALID','设备授权记录不可用，请在电脑端检查。');
    return structuredClone(value);
  }
  prune(value){
    const now=this.now();
    value.pairings=value.pairings.filter(item=>Date.parse(item.expiresAt)>now);
    value.sessions=value.sessions.filter(item=>Date.parse(item.expiresAt)>now&&(!item.revokedAt||Date.parse(item.revokedAt)>now-7*24*60*60*1000));
    const revoked=value.sessions.filter(item=>item.revokedAt).slice(-32),active=value.sessions.filter(item=>!item.revokedAt);
    value.sessions=[...revoked,...active];
    return value;
  }
  save(value){
    const previous=this.store.secrets.deviceAccess,had=Object.hasOwn(this.store.secrets,'deviceAccess');
    try{this.store.setSecrets({deviceAccess:value});}
    catch{
      // Store.setSecrets updates its memory before the atomic file replacement.
      // A failed write must not consume a code or authorize an unsaved device.
      if(had)this.store.secrets.deviceAccess=previous;else delete this.store.secrets.deviceAccess;
      throw failure(503,'DEVICE_STORE_FAILED','设备授权没有保存成功，请稍后重试。');
    }
  }
  issuePairing(input={}){
    argumentsObject(input);
    const deviceLabel=label(input.label,'我的手机'),value=this.prune(this.registry()),now=this.now();
    if(value.pairings.length>=MAX_PAIRINGS)throw failure(429,'PAIRINGS_FULL','待使用的配对码较多，请稍候再生成。');
    let code;
    do{code=[...randomBytes(8)].map(n=>ALPHABET[n&31]).join('');}while(value.pairings.some(item=>equal(item.codeHash,hash(code))));
    const record={id:randomUUID(),label:deviceLabel,codeHash:hash(code),createdAt:new Date(now).toISOString(),expiresAt:new Date(now+PAIRING_TTL).toISOString()};
    value.pairings.push(record);this.save(value);
    return {id:record.id,code:code.slice(0,4)+'-'+code.slice(4),expiresAt:record.expiresAt};
  }
  checkRate(peer){
    const now=this.now();for(const [key,item] of this.failures)if(item.until<=now)this.failures.delete(key);
    const key=String(peer||'unknown').slice(0,128),entry=this.failures.get(key);
    if(entry&&entry.count>=MAX_FAILURES)throw failure(429,'PAIRING_RATE_LIMIT','配对尝试过于频繁，请稍后重试。',{retryAfter:Math.max(1,Math.ceil((entry.until-now)/1000))});
    return key;
  }
  failedPairing(key){
    if(!this.failures.has(key)&&this.failures.size>=256)this.failures.delete(this.failures.keys().next().value);
    const item=this.failures.get(key)||{count:0,until:this.now()+FAILURE_WINDOW};item.count++;this.failures.set(key,item);
    throw failure(401,'INVALID_PAIRING','配对码无效、已过期或已使用，请重新生成。');
  }
  exchange(input={},peer='unknown'){
    argumentsObject(input);
    const key=this.checkRate(peer),deviceLabel=label(input.label,'我的手机'),code=codeValue(input.code),value=this.prune(this.registry());
    const pairing=code&&value.pairings.find(item=>equal(item.codeHash,hash(code)));
    if(!pairing)return this.failedPairing(key);
    if(value.sessions.filter(item=>!item.revokedAt).length>=MAX_DEVICES)throw failure(409,'DEVICES_FULL','已连接设备较多，请先在电脑端移除旧设备。');
    const now=this.now(),token='mdev_'+randomBytes(32).toString('base64url');
    const record={id:randomUUID(),label:input.label===undefined?pairing.label:deviceLabel,tokenHash:hash(token),createdAt:new Date(now).toISOString(),lastSeenAt:new Date(now).toISOString(),expiresAt:new Date(now+DEVICE_SESSION_TTL).toISOString()};
    value.pairings=value.pairings.filter(item=>item.id!==pairing.id);value.sessions.push(record);this.save(value);this.failures.delete(key);
    return {token,device:publicDevice(record)};
  }
  authenticate(token){
    if(typeof token!=='string'||!TOKEN.test(token))return null;
    const value=this.registry(),digest=hash(token),now=this.now();
    const record=value.sessions.find(item=>!item.revokedAt&&Date.parse(item.expiresAt)>now&&equal(item.tokenHash,digest));
    if(!record)return null;
    if(now-Date.parse(record.lastSeenAt)>=5*60*1000){record.lastSeenAt=new Date(now).toISOString();this.save(value);}
    return publicDevice(record);
  }
  list(){return this.prune(this.registry()).sessions.filter(item=>!item.revokedAt).map(publicDevice);}
  revoke(id){
    if(typeof id!=='string'||id.length>100)return null;
    const value=this.prune(this.registry()),record=value.sessions.find(item=>item.id===id);
    if(!record)return null;
    if(!record.revokedAt){record.revokedAt=new Date(this.now()).toISOString();this.save(value);}
    return publicDevice(record);
  }
  logout(token){
    if(typeof token!=='string'||!TOKEN.test(token))return false;
    const record=this.registry().sessions.find(item=>!item.revokedAt&&equal(item.tokenHash,hash(token)));
    return record?!!this.revoke(record.id):false;
  }
}

/** Parse only this device's cookie; duplicate names fail closed. */
export function parseCookie(raw){
  if(typeof raw!=='string'||raw.length>8192)return null;
  const values=raw.split(';').map(part=>part.trim()).filter(part=>part.startsWith(DEVICE_COOKIE+'='));
  if(values.length!==1)return null;
  try{const token=decodeURIComponent(values[0].slice(DEVICE_COOKIE.length+1));return TOKEN.test(token)?token:null;}catch{return null;}
}
export function cookieHeader(token,{secure=false,maxAge=DEVICE_SESSION_TTL/1000}={}){
  if(typeof token!=='string'||!TOKEN.test(token)||!Number.isInteger(maxAge)||maxAge<1||maxAge>DEVICE_SESSION_TTL/1000)throw Error('设备会话Cookie无效。');
  return DEVICE_COOKIE+'='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+maxAge+(secure?'; Secure':'');
}
export function removeCookie({secure=false}={}){
  return DEVICE_COOKIE+'=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT'+(secure?'; Secure':'');
}
