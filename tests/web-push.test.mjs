import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {Store} from '../server/store.mjs';
import {DeviceSessions} from '../server/device-sessions.mjs';
import {WebPushService} from '../server/web-push.mjs';

const owner={owner:true},PUBLIC_IP='8.8.8.8';
function subscription(suffix='a'){
  const ec=createECDH('prime256v1');ec.generateKeys();
  return {endpoint:'https://fcm.googleapis.com/fcm/send/synthetic-'+suffix,expirationTime:null,keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
}
function fixture(t,options={}){
  const directory=mkdtempSync(join(tmpdir(),'miobot-web-push-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const store=new Store(directory),clock={now:Date.parse('2026-11-05T08:00:00+08:00')},calls=[];
  const devices=new DeviceSessions({store,now:()=>clock.now});
  const pair=label=>{const code=devices.issuePairing({label}).code;return devices.exchange({code,label},'fixture').device;};
  const a={owner:false,device:pair('A')},b={owner:false,device:pair('B')};
  const service=new WebPushService({store,now:()=>clock.now,resolver:async()=>[{address:PUBLIC_IP,family:4}],sender:async(s,p,o)=>{calls.push({s,p:JSON.parse(p),o});return {statusCode:201};},...options});
  return {store,clock,calls,devices,service,a,b};
}

test('VAPID and endpoints persist only in the credential store and survive restart',async t=>{
  const {store,service,a}=fixture(t),s=subscription();await service.subscribe(a,{subscription:s},{secure:true});
  const info=service.info(a,{secure:true}),privateKey=store.secrets.webPush.vapid.privateKey;
  assert.equal(info.status,'subscribed');assert.equal(info.subscriptionCount,1);assert.equal(info.publicKey.length,87);
  for(const value of [JSON.stringify(info),JSON.stringify(store.snapshot()),readFileSync(store.file,'utf8')]){assert.ok(!value.includes(s.endpoint));assert.ok(!value.includes(s.keys.auth));assert.ok(!value.includes(privateKey));}
  const restarted=new WebPushService({store:new Store(store.root)});assert.equal(restarted.info(a,{secure:true}).subscribed,true);
});

test('personal devices can change only their own subscriptions and cannot impersonate another device',async t=>{
  const {service,store,a,b}=fixture(t);await service.subscribe(a,{subscription:subscription('a')},{secure:true});await service.subscribe(b,{subscription:subscription('b')},{secure:true});
  await assert.rejects(service.subscribe(a,{subscription:subscription('c'),deviceId:b.device.id},{secure:true}),/参数/);
  assert.throws(()=>service.unsubscribe(a,{deviceId:b.device.id}),/当前设备/);service.unsubscribe(a);
  assert.equal(service.info(a,{secure:true}).subscribed,false);assert.equal(service.info(b,{secure:true}).subscribed,true);
  await assert.rejects(service.subscribe({owner:false,device:{id:'invented'}},{subscription:subscription()},{secure:true}),/失效/);
  assert.equal(store.secrets.webPush.subscriptions.length,1);
});

test('secure-context, key and endpoint validation reject malformed or private subscriptions before sending',async t=>{
  const {service,a,calls}=fixture(t);await assert.rejects(service.subscribe(a,{subscription:subscription()},{secure:false}),/HTTPS/);
  const before=service.registry().subscriptions.length;
  for(const endpoint of ['http://fcm.googleapis.com/push','https://localhost/push','https://127.0.0.1/push','https://169.254.169.254/latest','https://10.0.0.2/push','https://[::1]/push','https://secret@fcm.googleapis.com/push','https://fcm.googleapis.com:8443/push','file:///etc/passwd'])await assert.rejects(service.subscribe(a,{subscription:{...subscription(),endpoint}},{secure:true}));
  await assert.rejects(service.subscribe(a,{subscription:{...subscription(),keys:{p256dh:'bad',auth:'bad'}}},{secure:true}),/密钥/);
  await assert.rejects(service.subscribe(a,{subscription:{...subscription(),expirationTime:0}},{secure:true}),/过期/);
  assert.equal(service.registry().subscriptions.length,before);assert.equal(calls.length,0);assert.equal(service.info(a,{secure:false}).status,'needs_https');
});

test('DNS answers are checked again at delivery and pinned for the HTTPS request',async t=>{
  let resolutions=0;
  const {service,a,calls}=fixture(t,{resolver:async()=>{resolutions++;return [{address:resolutions<=1?PUBLIC_IP:'127.0.0.1',family:4}];}});
  await service.subscribe(a,{subscription:subscription()},{secure:true});const blocked=await service.notify({id:'dns-rebound'});assert.equal(blocked.accepted,0);assert.equal(blocked.failed,1);assert.equal(calls.length,0);
  const other=fixture(t);await other.service.subscribe(other.a,{subscription:subscription('pinned')},{secure:true});await other.service.notify({id:'pinned-request'});
  const agent=other.calls[0].o.agent,answer=await new Promise((resolve,reject)=>agent.options.lookup('fcm.googleapis.com',{all:true},(e,a)=>e?reject(e):resolve(a)));
  assert.deepEqual(answer,[{address:PUBLIC_IP,family:4}]);
  await assert.rejects(new Promise((resolve,reject)=>agent.options.lookup('localhost',{},(e,a)=>e?reject(e):resolve(a))),/hostname/);
});

test('new notifications deduplicate across concurrent calls and expose no private message text in payloads',async t=>{
  const {service,a,calls}=fixture(t);await service.subscribe(a,{subscription:subscription()},{secure:true});
  const notification={id:'private-task-1',title:'private company interview',body:'private address and preferences',at:'2026-11-05'};
  const [one,two]=await Promise.all([service.notify(notification),service.notify(notification)]);
  assert.equal(one.accepted+two.accepted,1);assert.equal(one.skipped+two.skipped,1);assert.equal(calls.length,1);
  const payload=JSON.stringify(calls[0].p);assert.ok(!payload.includes(notification.title));assert.ok(!payload.includes(notification.body));assert.equal(calls[0].p.notificationId,notification.id);assert.ok(calls[0].p.url.startsWith('/?mobile=1'));
  assert.equal(service.info(a,{secure:true}).lastDelivery.status,'accepted');
});

test('revoked or expired device grants are pruned rather than receiving notifications',async t=>{
  const {service,a,b,devices,calls,clock}=fixture(t);await service.subscribe(a,{subscription:subscription('a')},{secure:true});await service.subscribe(b,{subscription:subscription('b')},{secure:true});devices.revoke(a.device.id);
  const result=await service.notify({id:'after-revoke'});assert.equal(result.accepted,1);assert.equal(calls.length,1);assert.ok(calls[0].s.endpoint.endsWith('synthetic-b'));assert.equal(service.registry().subscriptions.length,1);
  clock.now+=31*86400000;await service.notify({id:'after-expiry'});assert.equal(service.registry().subscriptions.length,0);assert.equal(calls.length,1);
});

test('expired push endpoints are removed and redirects do not trigger another request',async t=>{
  let count=0;const {service,a}=fixture(t,{sender:async()=>{count++;throw Object.assign(Error('sensitive endpoint and key must not be returned'),{statusCode:410});}});
  await service.subscribe(a,{subscription:subscription()},{secure:true});const result=await service.notify({id:'expired'});assert.equal(result.failed,1);assert.equal(service.info(a,{secure:true}).subscribed,false);assert.equal(count,1);assert.ok(!JSON.stringify(result).includes('sensitive'));
  const redirect=fixture(t,{sender:async()=>({statusCode:302,headers:{location:'http://127.0.0.1/private'}})});await redirect.service.subscribe(redirect.a,{subscription:subscription('redirect')},{secure:true});const rejected=await redirect.service.notify({id:'redirect'});assert.equal(rejected.accepted,0);assert.equal(rejected.failed,1);assert.equal(redirect.service.info(redirect.a,{secure:true}).lastDelivery.statusCode,302);
});

test('testing targets only the caller and distinguishes provider acceptance from actual display',async t=>{
  const {service,a,b,calls,clock}=fixture(t);await service.subscribe(a,{subscription:subscription('a')},{secure:true});await service.subscribe(b,{subscription:subscription('b')},{secure:true});
  const result=await service.test(a,{secure:true});assert.equal(result.accepted,1);assert.equal(result.delivery,'accepted');assert.equal(calls.length,1);assert.ok(calls[0].s.endpoint.endsWith('synthetic-a'));assert.equal(Object.hasOwn(result,'delivered'),false);
  await assert.rejects(service.test(a,{secure:true}),/等待/);clock.now+=10001;assert.equal((await service.test(b,{secure:true})).accepted,1);
});

test('a failed credentials write never advertises a saved subscription',async t=>{
  const {service,a,store}=fixture(t),original=store.setSecrets;store.setSecrets=function(value){Object.assign(this.secrets,value);throw Error('synthetic disk failure')};
  await assert.rejects(service.subscribe(a,{subscription:subscription()},{secure:true}),/保存/);assert.equal(service.info(a,{secure:true}).subscribed,false);store.setSecrets=original;
});

test('one device replaces its own subscription, but cannot overwrite a subscription owned by another device',async t=>{
  const {service,a,b}=fixture(t),s=subscription('shared');await service.subscribe(a,{subscription:s},{secure:true});await assert.rejects(service.subscribe(b,{subscription:s},{secure:true}),/另一部/);
  await service.subscribe(a,{subscription:subscription('renewed')},{secure:true});assert.equal(service.info(a,{secure:true}).subscriptionCount,1);
  service.removeDevice(a.device.id);assert.equal(service.info(a,{secure:true}).subscribed,false);
});

test('worker shows only minimal notifications and notification clicks cannot open an injected foreign URL',async()=>{
  const handlers=new Map(),shown=[],opened=[],messages=[],self={addEventListener:(name,fn)=>handlers.set(name,fn),skipWaiting:async()=>{},registration:{showNotification:async(...args)=>shown.push(args)},location:{origin:'https://miobot.example'},clients:{claim:async()=>{},matchAll:async()=>[],openWindow:async url=>opened.push(url)}};
  vm.runInNewContext(readFileSync(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,fetch:async()=>({ok:true})});assert.equal(handlers.has('fetch'),false,'worker must not cache private API data');
  const pending=[],waitUntil=p=>pending.push(p);handlers.get('push')({data:{json:()=>({notificationId:'fixture-1',body:'private message',url:'https://evil.example'})},waitUntil});await Promise.all(pending.splice(0));assert.equal(shown.length,1);assert.ok(!shown[0][1].body.includes('private'));assert.equal(shown[0][1].tag,'miobot-fixture-1');
  handlers.get('notificationclick')({notification:{close(){},data:{notificationId:'fixture-1',url:'https://evil.example'}},waitUntil});await Promise.all(pending.splice(0));assert.deepEqual(opened,['/?mobile=1&notification=fixture-1']);
  self.clients.matchAll=async()=>[{url:'https://miobot.example/?mobile=1',postMessage:value=>messages.push(value),focus:async()=>{}}];handlers.get('notificationclick')({notification:{close(){},data:{notificationId:'fixture-2'}},waitUntil});await Promise.all(pending.splice(0));assert.equal(messages[0].type,'miobot:open-notification');assert.equal(opened.length,1);
});

test('the real web-push library builds an encrypted HTTPS request with generated VAPID keys and the pinned agent',async t=>{
  const {default:webpush}=await import('web-push'),{service,a,calls}=fixture(t);
  await service.subscribe(a,{subscription:subscription('crypto')},{secure:true});await service.notify({id:'real-encryption-fixture'});
  const call=calls[0],request=webpush.generateRequestDetails(call.s,JSON.stringify(call.p),call.o);
  assert.equal(request.endpoint,call.s.endpoint);assert.equal(request.method,'POST');assert.equal(request.agent,call.o.agent);assert.equal(request.headers['Content-Encoding'],'aes128gcm');assert.ok(request.headers.Authorization.startsWith('vapid '));assert.ok(Buffer.isBuffer(request.body));
  assert.ok(!request.body.toString('utf8').includes('real-encryption-fixture'),'message content must be encrypted');assert.ok(request.body.length>0);
});
