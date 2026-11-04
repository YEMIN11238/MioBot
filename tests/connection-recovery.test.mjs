import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createServer} from 'node:http';
import {retryDelayMs,createConnectionRecovery} from '../src/connection-recovery.mjs';
import {api,clientFetch,newRequestId} from '../src/client-api.mjs';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function clock(){
  let time=0,id=0;const jobs=new Map();
  return {now:()=>time,setTimeout(fn,delay){const key=++id;jobs.set(key,{fn,at:time+delay});return key;},clearTimeout(key){jobs.delete(key);},size:()=>jobs.size,
    async tick(ms){const end=time+ms;let limit=200;while(limit--){const next=[...jobs].filter(([,j])=>j.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;time=next[1].at;jobs.delete(next[0]);next[1].fn();await flush();}if(limit<0)throw Error('Unexpected busy polling');time=end;await flush();}};
}
function fixture(refresh,options={}){
  const document=new EventTarget();document.visibilityState='visible';document.hidden=false;
  const window=new EventTarget();window.navigator={onLine:true};
  const timers=clock(),states=[];
  const recovery=createConnectionRecovery({refresh,onStatus:s=>states.push(s),window,document,random:()=>0,...timers,...options});
  return {recovery,document,window,timers,states};
}

test('T3 equal-jitter retry backs off across failures and stays within its five-minute ceiling',()=>{
  for(let failure=0;failure<25;failure++){
    const low=retryDelayMs(failure,0),high=retryDelayMs(failure,1);
    assert.ok(low>=1000&&high<=300000);assert.equal(low*2,high);
    assert.ok(retryDelayMs(failure,.5)>=low&&retryDelayMs(failure,.5)<=high);
  }
  assert.equal(retryDelayMs(0,0),1000);assert.equal(retryDelayMs(1,0),2000);
  assert.equal(retryDelayMs(12,1),300000);
});

test('a transient read failure retries once on the ladder and successful reads use ordinary polling',async()=>{
  let calls=0;const {recovery,timers}=fixture(async()=>{if(++calls===1)throw Error('fixture unreachable');});
  await recovery.start();assert.equal(recovery.getState().phase,'backoff');assert.equal(recovery.getState().retryAt,1000);
  await timers.tick(999);assert.equal(calls,1);
  await timers.tick(1);assert.equal(calls,2);assert.equal(recovery.getState().phase,'ready');
  await timers.tick(2499);assert.equal(calls,2);
  await timers.tick(1);assert.equal(calls,3);recovery.stop();assert.equal(timers.size(),0);
});

test('hidden clients stop polling and a foreground event synchronizes once before resuming',async()=>{
  let calls=0;const {recovery,timers,document}=fixture(async()=>{calls++;});
  await recovery.start();assert.equal(calls,1);
  document.hidden=true;document.visibilityState='hidden';document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(recovery.getState().phase,'suspended');assert.equal(timers.size(),0);
  await timers.tick(60000);assert.equal(calls,1);
  document.hidden=false;document.visibilityState='visible';document.dispatchEvent(new Event('visibilitychange'));await flush();
  assert.equal(calls,2);assert.equal(recovery.getState().phase,'ready');recovery.stop();
});

test('an authentication failure waits for pairing or explicit retry rather than repeatedly requesting the server',async()=>{
  let allowed=false,calls=0;const {recovery,timers}=fixture(async()=>{calls++;if(!allowed)throw Object.assign(Error('请重新配对'),{status:401});});
  await recovery.start();assert.equal(recovery.getState().phase,'blocked');assert.equal(timers.size(),0);
  await timers.tick(600000);assert.equal(calls,1);
  allowed=true;await recovery.wake();assert.equal(calls,2);assert.equal(recovery.getState().phase,'ready');recovery.stop();
});

test('offline hints still allow a probe, then park failed synchronization until the network returns',async()=>{
  let calls=0,reachable=false;const {recovery,timers,window}=fixture(async()=>{calls++;if(!reachable)throw Error('fixture offline');});
  window.navigator.onLine=false;await recovery.start();assert.equal(calls,1);assert.equal(recovery.getState().phase,'offline');assert.equal(timers.size(),0);
  await timers.tick(600000);assert.equal(calls,1);
  reachable=true;window.navigator.onLine=true;window.dispatchEvent(new Event('online'));await flush();
  assert.equal(calls,2);assert.equal(recovery.getState().phase,'ready');recovery.stop();
});

test('concurrent foreground signals do not overlap refreshes and stop prevents late results from reviving the client',async()=>{
  let finish,calls=0,aborted=false;
  const {recovery,timers,window}=fixture(({signal})=>{calls++;signal.addEventListener('abort',()=>{aborted=true;});return new Promise(resolve=>{finish=resolve;});});
  const pending=recovery.start();await flush();window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('online'));await flush();assert.equal(calls,1);
  recovery.stop();assert.equal(aborted,true);assert.equal(timers.size(),0);finish();await pending;
  assert.equal(recovery.getState().phase,'stopped');window.dispatchEvent(new Event('focus'));await flush();assert.equal(calls,1);
});

test('stalled synchronization times out and enters backoff rather than permanently owning the connection',async()=>{
  const {recovery,timers}=fixture(()=>new Promise(()=>{}),{timeoutMs:100});
  void recovery.start();await flush();await timers.tick(100);
  assert.equal(recovery.getState().phase,'backoff');assert.match(recovery.getState().error,/超时/);recovery.stop();assert.equal(timers.size(),0);
});

test('client requests carry same-origin device cookies, reject foreign backends and preserve useful status errors',async()=>{
  const originalFetch=globalThis.fetch,originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location');const calls=[];
  Object.defineProperty(globalThis,'location',{value:{origin:'https://miobot.example'},configurable:true});
  globalThis.fetch=async(path,options)=>{calls.push({path,options});return calls.length===1?Response.json({ok:true}):Response.json({error:'AstrBot 连接未授权'},{status:401});};
  try{
    assert.deepEqual(await api('/state'),{ok:true});assert.equal(calls[0].path,'/api/state');assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.headers.get('X-Personal-Agent'),'1');
    assert.throws(()=>clientFetch('https://another.example/api/state'),/当前/);assert.equal(calls.length,1);
    await assert.rejects(api('/device-sessions','POST',{code:'synthetic'}),error=>error.status===401&&error.message==='MioBot 连接未授权');
    assert.equal(calls[1].options.headers.get('Content-Type'),'application/json');assert.equal(calls[1].options.body,'{"code":"synthetic"}');assert.equal(calls.length,2,'failed writes are not automatically repeated');
  }finally{globalThis.fetch=originalFetch;if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation);else delete globalThis.location;}
});

test('HTTP LAN browsers get secure version-four request IDs without randomUUID',()=>{
  const fallback={getRandomValues:array=>webcrypto.getRandomValues(array)};
  const ids=new Set(Array.from({length:128},()=>newRequestId(fallback)));
  assert.equal(ids.size,128);for(const id of ids)assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.throws(()=>newRequestId({}),/安全/);
});

test('the real local HTTP fixture receives the exact API request once and the wrapper carries cancellation',async()=>{
  const nativeFetch=globalThis.fetch,originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location'),calls=[];
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    calls.push({method:req.method,path:req.url,application:req.headers['x-personal-agent'],type:req.headers['content-type'],body});
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({accepted:true}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  Object.defineProperty(globalThis,'location',{value:{origin},configurable:true});
  globalThis.fetch=(path,options)=>nativeFetch(new URL(path,origin),options);
  try{
    assert.deepEqual(await api('/device-sessions','POST',{code:'synthetic-code'}),{accepted:true});
    assert.deepEqual(calls,[{method:'POST',path:'/api/device-sessions',application:'1',type:'application/json',body:'{"code":"synthetic-code"}'}]);
    const abort=new AbortController();abort.abort();
    await assert.rejects(api('/state','GET',undefined,{signal:abort.signal}),error=>error.name==='AbortError');
    assert.equal(calls.length,1,'an already-cancelled read never reaches the host');
  }finally{
    globalThis.fetch=nativeFetch;if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation);else delete globalThis.location;
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});
