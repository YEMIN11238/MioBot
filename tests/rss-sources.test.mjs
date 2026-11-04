import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';
import {RssSources,RSS_LIMITS} from '../server/rss-sources.mjs';

const XML='<rss version="2.0"><channel><title>Fixture feed</title></channel></rss>';
const article=(id,extra={})=>({id,title:'Fixture '+id,url:'https://news.example.org/'+id,summary:'Public source text '+id,publishedAt:'2026-11-05T00:00:00Z',...extra});
function fixture(t,options={}){
  const dir=mkdtempSync(join(tmpdir(),'miobot-rss-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir),requests=[],parses=[],lookupCalls=[];
  const lookup=async(host)=>{lookupCalls.push(host);return [{address:'1.1.1.1',family:4}]};
  const fetcher=async(url,opts)=>{requests.push({url,opts});return new Response(XML,{headers:{'content-type':'application/rss+xml'}})};
  const parser=async value=>{parses.push(value);return {ok:true,items:[article('first'),article('second')]}};
  const rss=new RssSources({store,lookup,fetcher,parser,...options});return {dir,store,rss,requests,parses,lookupCalls};
}
const source=(rss,extra={})=>rss.create({assistantId:'daily',name:'Fixture source',url:'https://feeds.example.org/rss.xml',...extra});

test('public sources are scoped, duplicate saves are idempotent, and unused sources are not claimed tested',async t=>{
  const {store,rss}=fixture(t),s=await source(rss,{requestId:'request-1'}),again=await source(rss,{requestId:'request-1'});
  assert.equal(s.id,again.id);assert.equal(s.status,'saved');assert.equal(s.verification,'not_tested');assert.equal(store.state.rssSources.length,1);
  assert.deepEqual(rss.list({assistantId:'game'}).items,[]);await assert.rejects(rss.create({assistantId:'daily',name:'Different',url:s.url,requestId:'request-1'}),/请求编号/);
  assert.throws(()=>rss.remove(s.id,'game'),/这位助手/);assert.equal(rss.remove(s.id,'daily').ok,true);
});

test('invalid source scope and private credentials are rejected before any HTTP call',async t=>{
  const {rss,requests}=fixture(t);
  for(const url of ['http://feeds.example.org/rss','https://localhost/rss','https://127.0.0.1/rss','https://[::1]/rss','https://0x7f000001/rss','https://user:pass@example.org/rss','https://example.org:444/rss','https://example.org/rss?access_token=private','https://metadata.google.internal/feed'])await assert.rejects(source(rss,{url}));
  await assert.rejects(rss.create({assistantId:'daily',name:'test',url:'https://feeds.example.org/rss',ownerId:'other'}),/不支持/);
  await assert.rejects(source(rss,{assistantId:'missing'}),/找不到/);assert.equal(requests.length,0);
});

test('DNS answers must all be public and fetch receives the validated connection address',async t=>{
  let calls=0;const {rss}=fixture(t,{lookup:async()=>[{address:'1.1.1.1',family:4},{address:'10.0.0.1',family:4}],fetcher:async()=>{calls++;throw Error('must not fetch')}});
  await assert.rejects(source(rss),/非公网/);assert.equal(calls,0);
  const f=fixture(t),s=await source(f.rss);await f.rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],runId:'read-1'});
  assert.equal(f.requests[0].opts.address,'1.1.1.1');assert.equal(f.requests[0].opts.family,4);assert.equal(f.requests[0].opts.redirect,'manual');assert.equal(f.requests[0].opts.headers['Accept-Encoding'],'identity');
});

test('every redirect is checked and HTTPS downgrades or private redirect hosts are never fetched',async t=>{
  for(const location of ['http://feeds.example.org/plain','https://127.0.0.1/private','https://evil.example.org/private']){
    let calls=0;const {rss}=fixture(t,{lookup:async host=>[{address:host==='evil.example.org'?'192.168.1.1':'1.1.1.1',family:4}],fetcher:async()=>{calls++;return new Response('',{status:302,headers:{location}})}});
    const s=await source(rss);await assert.rejects(rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],runId:'redirect'}),/全部读取失败/);assert.equal(calls,1);
  }
});

test('an approved redirect resolves relative article links against the final feed URL',async t=>{
  const seen=[];const {rss}=fixture(t,{fetcher:async url=>{seen.push(url);return seen.length===1?new Response('',{status:301,headers:{location:'https://new.example.org/feeds/rss'}}):new Response(XML)},parser:async()=>({items:[article('first',{url:'../article/1'})]})});
  const s=await source(rss),r=await rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],runId:'redirect-ok'});assert.equal(r.items[0].url,'https://new.example.org/article/1');assert.equal(seen.length,2);
});

test('XML DTD/entity, HTML pages, compressed and oversized responses fail before the parser',async t=>{
  for(const response of [()=>new Response('<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss>&x;</rss>'),()=>new Response('<html/>',{headers:{'content-type':'text/html'}}),()=>new Response('compressed',{headers:{'content-encoding':'gzip'}}),()=>new Response('small',{headers:{'content-length':String(RSS_LIMITS.bytes+1)}})]){
    let parsed=0;const {rss}=fixture(t,{fetcher:async()=>response(),parser:async()=>{parsed++;return {items:[]}}});const s=await source(rss);await assert.rejects(rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],runId:'bad-xml'}),/全部读取失败/);assert.equal(parsed,0);
  }
});

test('fetch does not mark items delivered; acknowledgement is durable, idempotent and separate from parsing',async t=>{
  const {rss,store,dir}=fixture(t),s=await source(rss),args={assistantId:'daily',sourceIds:[s.id],runId:'delivery-1'};
  const r=await rss.fetchForTask(args);assert.equal(r.items.length,2);assert.equal(store.state.rssDeliveryLedger,undefined);assert.equal(r.contentTrust,'untrusted_source_material');assert.equal(r.items[0].key,r.items[0].id);
  const again=await rss.fetchForTask(args);assert.deepEqual(again,r);
  const beforeAck=await rss.fetchForTask({...args,runId:'delivery-2'});assert.equal(beforeAck.items.length,2,'unsent results cannot be discarded');
  assert.equal(rss.commitDelivery({assistantId:'daily',runId:'delivery-1'}).committed,2);assert.equal(rss.commitDelivery({assistantId:'daily',runId:'delivery-1'}).committed,0);
  const reloaded=new Store(dir),other=new RssSources({store:reloaded,lookup:rss.lookup,fetcher:rss.fetcher,parser:rss.parser});const after=await other.fetchForTask({...args,runId:'delivery-3'});assert.equal(after.items.length,0);
});

test('commit only accepts actual keys from this assistant/run, and can join the caller atomic save',async t=>{
  const {rss,store}=fixture(t),s=await source(rss),r=await rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],runId:'atomic'});
  assert.throws(()=>rss.commitDelivery({assistantId:'game',runId:'atomic'}),/找不到/);assert.throws(()=>rss.commitDelivery({assistantId:'daily',runId:'atomic',itemKeys:['invented']}),/实际读取/);assert.throws(()=>rss.commitDelivery({assistantId:'daily',runId:'atomic',itemKeys:[r.items[0].key,r.items[0].key]}),/实际读取/);
  const before=readFileSync(store.file,'utf8');rss.commitDelivery({assistantId:'daily',runId:'atomic',itemKeys:[r.items[0].key],save:false});assert.equal(readFileSync(store.file,'utf8'),before);assert.equal(store.state.rssPendingFetches.find(x=>x.runId==='atomic').deliveredAt,undefined);
  store.state.notifications.unshift({id:'fixture-atomic-notification'});rss.commitDelivery({assistantId:'daily',runId:'atomic',itemKeys:[r.items[1].key],save:false});store.save();const disk=JSON.parse(readFileSync(store.file));assert.equal(disk.rssDeliveryLedger.length,2);assert.equal(disk.notifications[0].id,'fixture-atomic-notification');
});

test('failed acknowledgement persistence rolls back dedup so a retry can still deliver',async t=>{
  const {rss,store}=fixture(t),s=await source(rss);await rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],runId:'failed-save'});const save=store.save.bind(store);store.save=()=>{throw Error('synthetic disk full')};
  assert.throws(()=>rss.commitDelivery({assistantId:'daily',runId:'failed-save'}),/disk full/);assert.equal(store.state.rssDeliveryLedger?.length||0,0);assert.deepEqual(store.state.rssPendingFetches[0].committedKeys,[]);store.save=save;assert.equal(rss.commitDelivery({assistantId:'daily',runId:'failed-save'}).committed,2);
});

test('host transaction rollback restores prior delivery state without saving or touching unrelated state',async t=>{
  const {rss,store}=fixture(t),s=await source(rss);await rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],runId:'host-rollback'});
  store.state.rssDeliveryLedger=[{ownerId:'local-user',assistantId:'game',key:'prior-delivery',linkKey:'prior-link'}];store.save();
  const before=readFileSync(store.file,'utf8'),snapshot=rss.snapshotDelivery();rss.commitDelivery({assistantId:'daily',runId:'host-rollback',save:false});store.state.notifications.unshift({id:'host-owned'});
  assert.equal(store.state.rssDeliveryLedger.length,3);rss.restoreDelivery(snapshot);assert.deepEqual(store.state.rssDeliveryLedger,snapshot.ledger);assert.deepEqual(store.state.rssPendingFetches,snapshot.pending);assert.equal(store.state.notifications[0].id,'host-owned');assert.equal(readFileSync(store.file,'utf8'),before);
  assert.equal(rss.commitDelivery({assistantId:'daily',runId:'host-rollback'}).committed,2);
  delete store.state.rssDeliveryLedger;const absent=rss.snapshotDelivery();store.state.rssDeliveryLedger=[];rss.restoreDelivery(absent);assert.equal(Object.hasOwn(store.state,'rssDeliveryLedger'),false);
});

test('discarding a terminal unsent snapshot is assistant-scoped, leaves delivery ledger intact and rolls back failed persistence',async t=>{
  const {rss,store}=fixture(t),s=await source(rss);await rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],runId:'terminal-unsent'});await rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],runId:'already-delivered'});rss.commitDelivery({assistantId:'daily',runId:'already-delivered'});
  const ledger=structuredClone(store.state.rssDeliveryLedger);assert.equal(rss.discardPending({assistantId:'game',runId:'terminal-unsent'}).removed,false);assert.equal(store.state.rssPendingFetches.length,2);
  const save=store.save.bind(store);store.save=()=>{throw Error('synthetic discard disk failure')};assert.throws(()=>rss.discardPending({assistantId:'daily',runId:'terminal-unsent'}),/disk failure/);assert.equal(store.state.rssPendingFetches.length,2);assert.deepEqual(store.state.rssDeliveryLedger,ledger);store.save=save;
  const before=readFileSync(store.file,'utf8');assert.equal(rss.discardPending({assistantId:'daily',runId:'terminal-unsent',save:false}).removed,true);assert.equal(readFileSync(store.file,'utf8'),before);assert.deepEqual(store.state.rssDeliveryLedger,ledger);store.save();assert.equal(JSON.parse(readFileSync(store.file)).rssPendingFetches.length,1);assert.equal(rss.discardPending({assistantId:'daily',runId:'terminal-unsent'}).removed,false);
});

test('cross-source canonical links are deduplicated within and after a delivered run',async t=>{
  const {rss}=fixture(t,{parser:async()=>({items:[article('first',{url:'https://news.example.org/a?utm_source=fixture'})]})});
  const a=await source(rss),b=await source(rss,{url:'https://other.example.org/feed',name:'Other'}),args={assistantId:'daily',sourceIds:[a.id,b.id],runId:'cross-1'};
  const r=await rss.fetchForTask(args);assert.equal(r.items.length,1);assert.equal(r.items[0].url,'https://news.example.org/a');rss.commitDelivery({assistantId:'daily',runId:'cross-1'});assert.equal((await rss.fetchForTask({...args,runId:'cross-2'})).items.length,0);
});

test('partial feed errors remain explicit and all failures cannot be summarized as empty successful news',async t=>{
  const {rss,store}=fixture(t,{fetcher:async url=>url.includes('bad.example.org')?new Response('fail',{status:503}):new Response(XML)});const a=await source(rss),b=await source(rss,{url:'https://bad.example.org/feed',name:'Unavailable'});
  const r=await rss.fetchForTask({assistantId:'daily',sourceIds:[a.id,b.id],runId:'partial'});assert.equal(r.partial,true);assert.equal(r.errors.length,1);assert.equal(r.errors[0].sourceId,b.id);assert.equal(r.items.length,2);
  await assert.rejects(rss.fetchForTask({assistantId:'daily',sourceIds:[b.id],runId:'all-failed'}),e=>e.code==='RSS_ALL_SOURCES_FAILED');assert.equal(store.state.rssPendingFetches.some(x=>x.runId==='all-failed'),false);
});

test('scope and run identity are checked before a cached result can be replayed',async t=>{
  const {rss,requests}=fixture(t),s=await source(rss);await rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],runId:'scope'});const count=requests.length;
  await assert.rejects(rss.fetchForTask({assistantId:'game',sourceIds:[s.id],runId:'scope'}),/其他助手/);await assert.rejects(rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],limit:1,runId:'scope'}),/执行编号/);assert.equal(requests.length,count);
});

test('simultaneous source saves cannot exceed the per-assistant limit',async t=>{
  const {rss}=fixture(t),results=await Promise.allSettled(Array.from({length:22},(_,i)=>source(rss,{url:'https://feeds.example.org/'+i})));assert.equal(results.filter(x=>x.status==='fulfilled').length,20);assert.equal(rss.list({assistantId:'daily'}).items.length,20);
});

test('concurrent reads of one run share a snapshot, while changed arguments are rejected',async t=>{
  let finish;const wait=new Promise(r=>{finish=r});let fetches=0;const {rss}=fixture(t,{fetcher:async()=>{fetches++;await wait;return new Response(XML)}}),s=await source(rss),args={assistantId:'daily',sourceIds:[s.id],runId:'concurrent'};
  const a=rss.fetchForTask(args),b=rss.fetchForTask(args);await assert.rejects(rss.fetchForTask({...args,limit:1}),/执行编号/);finish();assert.deepEqual(await a,await b);assert.equal(fetches,1);
});

test('article output is bounded plain source material with public links only',async t=>{
  const {rss}=fixture(t,{parser:async()=>({items:[article('unsafe',{url:'https://127.0.0.1/a'}),article('nolink',{url:''}),...Array.from({length:80},(_,i)=>article(String(i),{title:'<b>Title</b>',summary:'<script>do not expose</script>'+('x'.repeat(5000))}))]})}),s=await source(rss),r=await rss.fetchForTask({assistantId:'daily',sourceIds:[s.id],runId:'bounds',limit:30});
  assert.ok(r.items.length<=30);assert.ok(r.items.every(i=>i.title==='Title'&&i.summary.length<=1600&&!i.summary.includes('script')&&!i.url.includes('127.0.0.1')));assert.ok(r.items.reduce((n,i)=>n+i.summary.length+i.title.length,0)<=RSS_LIMITS.snapshotCharacters);
});
