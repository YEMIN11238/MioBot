import {ECDH,createECDH,createHash,randomUUID} from 'node:crypto';
import {lookup as dnsLookup} from 'node:dns/promises';
import {Agent as HttpsAgent} from 'node:https';
import {isIP} from 'node:net';
import {publicAddress} from './research-tools.mjs';

const MAX_SUBSCRIPTIONS=32,MAX_OWNER_SUBSCRIPTIONS=3,MAX_RECEIPTS=512;
const DEFAULT_SUBJECT='https://github.com/YEMIN11238/MioBot';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
const failure=(status,code,message)=>Object.assign(new Error(message),{status,code});
const fail=(status,code,message)=>{throw failure(status,code,message);};
const encode=value=>Buffer.from(value).toString('base64url');

function vapidKeys(){const ec=createECDH('prime256v1');ec.generateKeys();return {publicKey:encode(ec.getPublicKey()),privateKey:encode(ec.getPrivateKey()),subject:DEFAULT_SUBJECT};}
function keyBytes(value,length){
  if(typeof value!=='string'||!/^[-_A-Za-z0-9]+={0,2}$/.test(value)||value.length>200)return null;
  const bytes=Buffer.from(value,'base64url');return bytes.length===length?bytes:null;
}
function validVapid(value){return object(value)&&keyBytes(value.publicKey,65)?.[0]===4&&!!keyBytes(value.privateKey,32)&&typeof value.subject==='string'&&value.subject===DEFAULT_SUBJECT;}
function subscriptionValue(value){
  if(!object(value)||Object.keys(value).some(key=>!['endpoint','expirationTime','keys'].includes(key))||!object(value.keys)||Object.keys(value.keys).some(key=>!['p256dh','auth'].includes(key)))fail(400,'INVALID_PUSH_SUBSCRIPTION','浏览器通知订阅格式无效。');
  const pub=keyBytes(value.keys.p256dh,65),auth=keyBytes(value.keys.auth,16);
  if(!pub||pub[0]!==4||!auth)fail(400,'INVALID_PUSH_KEYS','浏览器通知密钥无效，请重新连接通知。');
  try{ECDH.convertKey(pub,'prime256v1');}catch{fail(400,'INVALID_PUSH_KEYS','浏览器通知密钥无效，请重新连接通知。');}
  if(value.expirationTime!==undefined&&value.expirationTime!==null&&(!Number.isSafeInteger(value.expirationTime)||value.expirationTime<0))fail(400,'INVALID_PUSH_EXPIRY','通知订阅有效期无效。');
  return {endpoint:value.endpoint,expirationTime:value.expirationTime??null,keys:{p256dh:pub.toString('base64url'),auth:auth.toString('base64url')}};
}

async function endpointAddress(endpoint,resolver){
  let url;try{url=new URL(endpoint);}catch{fail(400,'UNSAFE_PUSH_ENDPOINT','通知服务地址无效。');}
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(typeof endpoint!=='string'||endpoint.length>4096||url.protocol!=='https:'||url.port&&url.port!=='443'||url.username||url.password||url.hash||!host||/^(?:localhost|metadata\.google\.internal)$|\.(?:localhost|local|internal|lan|home|invalid|test)$/.test(host))fail(400,'UNSAFE_PUSH_ENDPOINT','通知订阅必须使用公开 HTTPS 推送服务。');
  let addresses,timer;
  try{
    addresses=isIP(host)?[{address:host,family:isIP(host)}]:await Promise.race([
      resolver(host,{all:true,verbatim:true}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),2500);}),
    ]);
  }catch{fail(400,'PUSH_DNS_UNAVAILABLE','通知服务地址暂时无法验证，请稍后重试。');}
  finally{clearTimeout(timer);}
  if(!Array.isArray(addresses)||!addresses.length||addresses.length>32||addresses.some(a=>!publicAddress(a.address)))fail(400,'UNSAFE_PUSH_ENDPOINT','通知服务未解析到允许的公网地址。');
  return {url:url.href,host,addresses:addresses.map(a=>({address:a.address,family:isIP(a.address)}))};
}

function pinnedAgent({host,addresses}){
  return new HttpsAgent({keepAlive:false,lookup(name,options,callback){
    if(name.toLowerCase()!==host)return callback(Error('Push hostname mismatch'));
    const family=typeof options==='number'?options:options?.family,selected=addresses.filter(a=>!family||a.family===family);
    if(!selected.length)return callback(Error('No validated push address'));
    if(options?.all)return callback(null,selected);
    callback(null,selected[0].address,selected[0].family);
  }});
}

async function sendPush(subscription,payload,options){
  const {default:webpush}=await import('web-push');
  // web-push uses node:https without a redirect follower. DNS is pinned below.
  return webpush.sendNotification(subscription,payload,options);
}

/** Optional personal-device delivery. It never stores endpoints in ordinary state.
 * Identity must come from requestIdentity; device grants are checked again here.
 * A push provider accepting a request is not proof the phone displayed or read it.
 */
export class WebPushService{
  constructor({store,sender=sendPush,resolver=dnsLookup,now=Date.now,vapid}={}){
    if(!store?.secrets||typeof store.setSecrets!=='function')throw Error('通知存储尚未准备好。');
    this.store=store;this.sender=sender;this.resolver=resolver;this.now=now;this.tests=new Map();
    if(store.secrets.webPush===undefined)this.save({version:1,vapid:vapid||vapidKeys(),subscriptions:[],receipts:[]});
  }
  registry(){
    const value=this.store.secrets.webPush;
    if(value?.version!==1||!validVapid(value.vapid)||!Array.isArray(value.subscriptions)||!Array.isArray(value.receipts))fail(503,'PUSH_STORE_INVALID','通知配置不可用，请在电脑端检查后台。');
    return structuredClone(value);
  }
  save(value){
    const old=this.store.secrets.webPush,had=Object.hasOwn(this.store.secrets,'webPush');
    try{this.store.setSecrets({webPush:value});}
    catch{if(had)this.store.secrets.webPush=old;else delete this.store.secrets.webPush;fail(503,'PUSH_STORE_FAILED','通知配置没有保存成功，请稍后重试。');}
  }
  activeDevice(id){
    const registry=this.store.secrets.deviceAccess;
    return registry?.version===1&&Array.isArray(registry.sessions)&&registry.sessions.some(s=>s.id===id&&!s.revokedAt&&Date.parse(s.expiresAt)>this.now());
  }
  scope(identity){
    if(!object(identity))fail(401,'PUSH_NOT_AUTHORIZED','请先连接当前 MioBot 后台。');
    if(identity.owner===true&&!identity.device)return 'owner';
    const id=identity.device?.id;
    if(identity.owner===false&&typeof id==='string'&&this.activeDevice(id))return 'device:'+id;
    fail(403,'PUSH_NOT_AUTHORIZED','这部设备的授权已失效，请重新配对。');
  }
  active(subscription){return (subscription.scope==='owner'||subscription.scope?.startsWith('device:')&&this.activeDevice(subscription.scope.slice(7)))&&(subscription.expirationTime===null||subscription.expirationTime===undefined||subscription.expirationTime>this.now());}
  info(identity,{secure=false}={}){
    const scope=this.scope(identity),value=this.registry(),subscriptions=value.subscriptions.filter(s=>s.scope===scope&&this.active(s)),receipt=[...value.receipts].reverse().find(r=>r.scope===scope);
    return {configured:true,requiresHttps:true,status:!secure?'needs_https':subscriptions.length?'subscribed':'ready',publicKey:value.vapid.publicKey,subscribed:subscriptions.length>0,subscriptionCount:subscriptions.length,...(receipt?{lastDelivery:{at:receipt.at,status:receipt.status,accepted:receipt.status==='accepted',...(receipt.statusCode?{statusCode:receipt.statusCode}:{})}}:{})};
  }
  async subscribe(identity,input,{secure=false}={}){
    const scope=this.scope(identity);
    if(!secure)fail(409,'PUSH_HTTPS_REQUIRED','请从 HTTPS 地址打开 MioBot 后再连接手机通知。');
    if(!object(input)||Object.keys(input).some(k=>k!=='subscription'))fail(400,'INVALID_PUSH_REQUEST','通知订阅参数无效。');
    const subscription=subscriptionValue(input.subscription),endpoint=await endpointAddress(subscription.endpoint,this.resolver);
    if(subscription.expirationTime!==null&&subscription.expirationTime<=this.now())fail(400,'PUSH_SUBSCRIPTION_EXPIRED','这份通知订阅已过期，请重新连接。');
    const value=this.registry();value.subscriptions=value.subscriptions.filter(s=>this.active(s));
    const existing=value.subscriptions.find(s=>s.endpoint===endpoint.url);
    if(existing&&existing.scope!==scope)fail(409,'PUSH_SCOPE_MISMATCH','这份浏览器订阅属于另一部已连接设备，请先断开原设备。');
    const at=new Date(this.now()).toISOString();
    if(existing)Object.assign(existing,subscription,{endpoint:endpoint.url,updatedAt:at});
    else{
      if(value.subscriptions.length>=MAX_SUBSCRIPTIONS)fail(409,'PUSH_DEVICES_FULL','通知设备较多，请先断开不再使用的设备。');
      const own=value.subscriptions.filter(s=>s.scope===scope);
      if(scope==='owner'&&own.length>=MAX_OWNER_SUBSCRIPTIONS)fail(409,'PUSH_DEVICES_FULL','本机通知订阅较多，请先关闭旧浏览器的通知连接。');
      if(scope!=='owner')value.subscriptions=value.subscriptions.filter(s=>s.scope!==scope);
      value.subscriptions.push({...subscription,endpoint:endpoint.url,id:randomUUID(),scope,createdAt:at,updatedAt:at});
    }
    this.save(value);return this.info(identity,{secure});
  }
  unsubscribe(identity,input={}){
    if(!object(input)||Object.keys(input).length)fail(400,'INVALID_PUSH_REQUEST','只能关闭当前设备自己的通知连接。');
    const scope=this.scope(identity),value=this.registry();value.subscriptions=value.subscriptions.filter(s=>s.scope!==scope);this.save(value);return {ok:true,subscribed:false};
  }
  removeDevice(deviceId){
    if(typeof deviceId!=='string'||!deviceId||deviceId.length>100)return;
    const value=this.registry(),scope='device:'+deviceId,kept=value.subscriptions.filter(s=>s.scope!==scope);
    if(kept.length!==value.subscriptions.length){value.subscriptions=kept;this.save(value);}
  }
  async test(identity,{secure=false}={}){
    if(!secure)fail(409,'PUSH_HTTPS_REQUIRED','请从 HTTPS 地址打开 MioBot 后再测试手机通知。');
    const scope=this.scope(identity),last=this.tests.get(scope);
    if(last!==undefined&&this.now()-last<10000)fail(429,'PUSH_TEST_RATE_LIMIT','请等待几秒，再发送下一条测试通知。');
    if(!this.registry().subscriptions.some(s=>s.scope===scope&&this.active(s)))fail(409,'PUSH_NOT_SUBSCRIBED','这部设备还没有连接通知，请先允许通知。');
    this.tests.set(scope,this.now());
    return this.notify({id:'test-'+randomUUID(),type:'push_test'},{scopes:[scope]});
  }
  async notify(notification,{deviceIds,scopes}={}){
    if(!object(notification)||typeof notification.id!=='string'||!/^[-_:A-Za-z0-9]{1,160}$/.test(notification.id))fail(400,'INVALID_NOTIFICATION','通知编号无效。');
    if(deviceIds!==undefined&&(!Array.isArray(deviceIds)||deviceIds.some(id=>typeof id!=='string'||id.length>100)))fail(400,'INVALID_PUSH_SCOPE','通知设备范围无效。');
    const allowed=scopes?new Set(scopes):deviceIds?new Set(deviceIds.map(id=>'device:'+id)):null;
    const value=this.registry(),all=value.subscriptions;value.subscriptions=all.filter(s=>this.active(s));
    const selected=value.subscriptions.filter(s=>!allowed||allowed.has(s.scope)),pending=[];let skipped=0;
    for(const s of selected){
      const key=hash(notification.id+'\0'+s.id);
      if(value.receipts.some(r=>r.key===key)){skipped++;continue;}
      const receipt={key,notificationId:notification.id,subscriptionId:s.id,scope:s.scope,status:'sending',at:new Date(this.now()).toISOString()};
      value.receipts.push(receipt);pending.push({subscription:s,key});
    }
    value.receipts=value.receipts.slice(-MAX_RECEIPTS);
    if(pending.length||all.length!==value.subscriptions.length)this.save(value);
    const payload=JSON.stringify({title:'MioBot',body:notification.type==='push_test'?'这是一条连接测试，请核对手机是否收到。':'有一条新消息，打开 MioBot 收件箱查看。',notificationId:notification.id,url:'/?mobile=1&notification='+encodeURIComponent(notification.id)});
    const result={accepted:0,failed:0,skipped,attempted:pending.length,delivery:'not_sent'};
    const queue=[...pending];
    const worker=async()=>{
      while(queue.length){
        const {subscription:s,key}=queue.shift();let agent,statusCode=0,accepted=false,expired=false;
        try{
          const endpoint=await endpointAddress(s.endpoint,this.resolver);agent=pinnedAgent(endpoint);
          const current=this.registry(),still=current.subscriptions.find(item=>item.id===s.id&&item.scope===s.scope);
          if(!still||!this.active(still)){result.skipped++;continue;}
          const response=await this.sender({endpoint:s.endpoint,expirationTime:s.expirationTime,keys:s.keys},payload,{vapidDetails:{subject:current.vapid.subject,publicKey:current.vapid.publicKey,privateKey:current.vapid.privateKey},TTL:60,urgency:'normal',timeout:10000,agent});
          statusCode=Number(response?.statusCode)||0;accepted=statusCode>=200&&statusCode<300;
        }catch(error){statusCode=Number(error?.statusCode)||0;expired=statusCode===404||statusCode===410;}
        finally{agent?.destroy();}
        if(accepted)result.accepted++;else result.failed++;
        const current=this.registry(),receipt=current.receipts.find(r=>r.key===key);
        if(receipt)Object.assign(receipt,{status:accepted?'accepted':expired?'expired':'failed',at:new Date(this.now()).toISOString(),...(statusCode?{statusCode}:{})});
        if(expired)current.subscriptions=current.subscriptions.filter(item=>item.id!==s.id);
        this.save(current);
      }
    };
    await Promise.all(Array.from({length:Math.min(4,pending.length)},worker));
    result.delivery=result.accepted?'accepted':result.failed?'failed':'not_sent';return result;
  }
}
