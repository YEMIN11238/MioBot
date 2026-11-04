import {randomUUID,createHash} from 'node:crypto';
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import {execFile} from 'node:child_process';
import {existsSync,lstatSync,realpathSync,mkdirSync,readFileSync,writeFileSync,cpSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicAddress} from './research-tools.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..'),OWNER='local-user';
export const RSS_LIMITS=Object.freeze({sourcesPerAssistant:20,bytes:2*1024*1024,itemsPerRun:30,snapshotCharacters:20000,pendingPerAssistant:100,ledgerPerAssistant:5000,redirects:3});
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hash=x=>createHash('sha256').update(x).digest('hex');
const fail=(code,message,status=400)=>{throw Object.assign(new Error(message),{code,status});};
const cloned=x=>structuredClone(x);
function fields(value,allowed){if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('INVALID_RSS_ARGUMENTS','RSS 参数包含不支持的字段。');}
function text(value,label,max){if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))fail('INVALID_RSS_ARGUMENTS',label+'无效。');return value.trim();}
function syntaxURL(value,{article=false}={}){
  if(typeof value!=='string'||value.length>4096)fail('UNSAFE_FEED_URL','请填写公开的 HTTPS RSS/Atom 地址。');
  let url;try{url=new URL(value);}catch{fail('UNSAFE_FEED_URL','请填写有效的 HTTPS RSS/Atom 地址。');}
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||!host||/^(?:localhost|metadata\.google\.internal)$|\.(?:localhost|local|internal|lan|home|invalid|test)$/.test(host))fail('UNSAFE_FEED_URL','RSS 只接受公开 HTTPS 地址，不接受本机、内网或带登录凭据的地址。');
  if(!article&&[...url.searchParams.keys()].some(k=>/token|password|secret|api[-_]?key|access[-_]?key|signature|credential|^(?:key|auth|authorization)$/i.test(k)))fail('PRIVATE_FEED_NOT_SUPPORTED','当前仅接入公开信息源，请勿把含访问凭据的私人订阅链接放入资料。');
  if(isIP(host)&&!publicAddress(host))fail('UNSAFE_FEED_URL','RSS 地址不能指向非公网地址。');
  url.hash='';return url;
}

/** Use the already-validated address for this TLS request; DNS cannot rebind
 * between the policy check and the HTTP connection. Redirects stay in the host. */
function pinnedFetch(url,{address,family,signal,headers}){
  return new Promise((resolveRequest,reject)=>{
    const request=httpsRequest(url,{method:'GET',headers,signal,lookup:(_host,options,callback)=>{
      if(typeof options==='function'){callback=options;options={};}
      callback(null,options?.all?[{address,family}]:address,family);
    }},response=>{
      const h=new Headers();for(const [key,value] of Object.entries(response.headers))if(value!==undefined)h.set(key,Array.isArray(value)?value.join(', '):String(value));
      resolveRequest(new Response(Readable.toWeb(response),{status:response.statusCode||502,headers:h}));
    });
    request.on('error',reject);request.end();
  });
}

async function readBounded(response){
  if(Number(response.headers.get('content-length')||0)>RSS_LIMITS.bytes){await response.body?.cancel();fail('FEED_TOO_LARGE','RSS 返回内容超过 2 MB。',422);}
  const chunks=[];let size=0;
  for await(const chunk of response.body||[]){size+=chunk.length;if(size>RSS_LIMITS.bytes)fail('FEED_TOO_LARGE','RSS 返回内容超过 2 MB。',422);chunks.push(chunk);}
  const buffer=Buffer.concat(chunks);if(!buffer.length)fail('INVALID_FEED','RSS 返回内容为空。',422);
  if(buffer.includes(0)||/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(buffer.toString('utf8')))fail('UNSAFE_FEED_DOCUMENT','RSS 文档含有不接受的 DTD 或实体声明。',422);
  return buffer;
}

function plain(value,limit){return String(value||'').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,' ').replace(/<[^>]*>/g,' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').replace(/\s+/g,' ').trim().slice(0,limit);}
function canonicalLink(value){const url=new URL(value);for(const key of [...url.searchParams.keys()])if(/^utm_|^(?:fbclid|gclid|spm)$/i.test(key))url.searchParams.delete(key);return url.href;}

export class RssSources{
  constructor({store,runtime=null,root=ROOT,fetcher=null,lookup=dnsLookup,parser=null,python=null,now=()=>Date.now()}={}){
    if(!store?.state)throw new Error('RSS needs an application store');
    this.store=store;this.runtime=runtime;this.root=root;this.fetcher=!fetcher||fetcher===globalThis.fetch?pinnedFetch:fetcher;this.lookup=lookup;this.parser=parser;this.python=python;this.now=now;this.fetching=new Map();
  }
  assistant(id){const a=this.store.state.assistants?.find(x=>x.id===id);if(!a)fail('RSS_ASSISTANT_NOT_FOUND','找不到这个助手。',404);return a;}
  list({assistantId}={}){this.assistant(assistantId);return {items:(this.store.state.rssSources||[]).filter(s=>s.ownerId===OWNER&&s.assistantId===assistantId).map(({requestId,...s})=>cloned(s))};}
  async resolveURL(value,{article=false,cache=new Map()}={}){
    const url=syntaxURL(value,{article}),host=url.hostname.replace(/^\[|\]$/g,'');
    if(cache.has(host))return {url,...cache.get(host)};
    let addresses,timer;
    try{addresses=isIP(host)?[{address:host,family:isIP(host)}]:await Promise.race([this.lookup(host,{all:true,verbatim:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('DNS timeout')),2000)})]);}
    catch{fail('RSS_DNS_FAILED','RSS 域名解析失败，请检查公开订阅地址。',422);}finally{clearTimeout(timer);}
    if(!Array.isArray(addresses)||!addresses.length||addresses.length>32||addresses.some(a=>!publicAddress(a.address)))fail('UNSAFE_FEED_URL','RSS 域名解析到了非公网地址。',422);
    const pinned={address:addresses[0].address,family:addresses[0].family||isIP(addresses[0].address)};cache.set(host,pinned);return {url,...pinned};
  }
  async create(input){
    fields(input,['assistantId','url','name','requestId']);const {assistantId}=input;this.assistant(assistantId);
    const name=text(input.name||'我的信息源','信息源名称',120),url=syntaxURL(input.url).href;
    const requestId=input.requestId===undefined?'':text(input.requestId,'请求编号',100);
    const sources=this.store.state.rssSources||[],owned=sources.filter(s=>s.ownerId===OWNER&&s.assistantId===assistantId);
    const previous=requestId&&owned.find(s=>s.requestId===requestId);
    if(previous){if(previous.url!==url||previous.name!==name)fail('RSS_REQUEST_REUSED','同一个请求编号不能保存不同的信息源。',409);return cloned(previous);}
    const same=owned.find(s=>s.url===url);if(same)return cloned(same);
    if(owned.length>=RSS_LIMITS.sourcesPerAssistant)fail('RSS_SOURCE_LIMIT','每个助手最多保存 20 个 RSS 信息源。',409);
    await this.resolveURL(url);
    // Recheck after DNS, because simultaneous saves must share the same limit.
    const latest=this.store.state.rssSources||[],count=latest.filter(s=>s.ownerId===OWNER&&s.assistantId===assistantId),duplicate=count.find(s=>s.url===url||requestId&&s.requestId===requestId);
    if(duplicate){if(requestId&&duplicate.requestId===requestId&&(duplicate.url!==url||duplicate.name!==name))fail('RSS_REQUEST_REUSED','同一个请求编号不能保存不同的信息源。',409);return cloned(duplicate);}
    if(count.length>=RSS_LIMITS.sourcesPerAssistant)fail('RSS_SOURCE_LIMIT','每个助手最多保存 20 个 RSS 信息源。',409);
    const source={id:randomUUID(),ownerId:OWNER,assistantId,url,name,createdAt:new Date(this.now()).toISOString(),status:'saved',verification:'not_tested',...(requestId?{requestId}:{})};
    const old=this.store.state.rssSources;this.store.state.rssSources=[...latest,source];try{this.store.save();}catch(e){if(old===undefined)delete this.store.state.rssSources;else this.store.state.rssSources=old;throw e;}return cloned(source);
  }
  remove(id,assistantId){this.assistant(assistantId);const all=this.store.state.rssSources||[],source=all.find(s=>s.id===id&&s.ownerId===OWNER&&s.assistantId===assistantId);if(!source)fail('RSS_SOURCE_NOT_FOUND','找不到属于这位助手的信息源。',404);this.store.state.rssSources=all.filter(s=>s!==source);try{this.store.save();}catch(e){this.store.state.rssSources=all;throw e;}return {ok:true};}
  parserScript(){
    const base=realpathSync(this.store.root),target=join(base,'rsshub-parser'),marker=join(target,'.miobot-rss-parser.json');
    const files=['parse_feed.py','upstream/models.py','upstream/xml_parser.py'];
    for(const dir of [target,join(target,'upstream')])if(existsSync(dir)&&(!lstatSync(dir).isDirectory()||lstatSync(dir).isSymbolicLink()||realpathSync(dir)!==dir))fail('RSS_PARSER_STORAGE_UNSAFE','RSS 解析目录不可用。',409);
    if(existsSync(target)&&!existsSync(marker))fail('RSS_PARSER_STORAGE_UNSAFE','RSS 解析目录已有其他资料，未覆盖。',409);
    let receipt;try{if(existsSync(marker))receipt=JSON.parse(readFileSync(marker,'utf8'));}catch{fail('RSS_PARSER_STORAGE_UNSAFE','RSS 解析校验记录无效。',409);}
    for(const file of files){const p=join(target,file);if(existsSync(p)){const stat=lstatSync(p);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!receipt?.files?.[file]||hash(readFileSync(p))!==receipt.files[file])fail('RSS_PARSER_STORAGE_UNSAFE','RSS 解析文件已被手动修改，未覆盖。',409);}}
    mkdirSync(join(target,'upstream'),{recursive:true,mode:0o700});const hashes={};
    for(const file of files){const src=join(this.root,'integrations/rsshub',file),p=join(target,file);if(!existsSync(src))fail('RSS_PARSER_UNAVAILABLE','内置 RSS 解析组件缺失，请更新 MioBot。',409);cpSync(src,p);hashes[file]=hash(readFileSync(src));}
    writeFileSync(marker,JSON.stringify({files:hashes}),{mode:0o600});return join(target,'parse_feed.py');
  }
  async parse(xml,{url,signal}={}){
    if(this.parser)return this.parser({xml,url,signal});
    const paths=typeof this.python==='function'?this.python():this.python||this.runtime?.paths?.(),python=typeof paths==='string'?paths:paths?.python||paths?.executable;
    if(!python||!existsSync(python))fail('RSS_PARSER_UNAVAILABLE','RSS 解析环境未准备好，请检查内置后台。',409);
    const script=this.parserScript(),env={...process.env,...(paths?.home?{PYTHONHOME:paths.home}:{}),...(paths?.packages?{PYTHONPATH:paths.packages}:{}),PYTHONDONTWRITEBYTECODE:'1'};
    const value=await new Promise((resolveParse,reject)=>{const child=execFile(python,[script],{env,signal,timeout:7000,maxBuffer:2*1024*1024},(error,stdout)=>{if(error)return reject(Object.assign(Error('RSS 解析超时或失败。'),{code:'RSS_PARSE_FAILED',status:422}));try{resolveParse(JSON.parse(stdout));}catch{reject(Object.assign(Error('RSS 解析结果无效。'),{code:'RSS_PARSE_FAILED',status:422}));}});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({data:xml.toString('base64')}));});
    if(!value?.ok)fail(value?.code==='PARSER_DEPENDENCY_MISSING'?'RSS_PARSER_UNAVAILABLE':'INVALID_FEED',value?.code==='PARSER_DEPENDENCY_MISSING'?'RSS 解析依赖尚未安装，请更新内置后台。':'这个地址没有返回有效的 RSS/Atom 内容。',422);return value;
  }
  async fetchSource(source,{signal,cache}={}){
    let current=source.url;
    const timeout=AbortSignal.timeout(12000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
    for(let hop=0;hop<=RSS_LIMITS.redirects;hop++){
      const {url,address,family}=await this.resolveURL(current,{cache});
      const response=await this.fetcher(url.href,{address,family,signal:combined,redirect:'manual',headers:{Accept:'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9','Accept-Encoding':'identity','User-Agent':'MioBot RSS/0.8'}});
      if(response.status>=300&&response.status<400){const location=response.headers.get('location');await response.body?.cancel();if(!location||hop===RSS_LIMITS.redirects)fail('RSS_REDIRECT_LIMIT','RSS 重定向次数过多或地址无效。',422);current=new URL(location,url).href;continue;}
      if(!response.ok){await response.body?.cancel();fail('RSS_FETCH_FAILED','RSS 服务返回 HTTP '+response.status+'。',422);}
      if(response.headers.get('content-encoding')&&!/^identity$/i.test(response.headers.get('content-encoding'))){await response.body?.cancel();fail('RSS_ENCODING_UNSUPPORTED','RSS 服务返回了暂不支持的压缩格式。',422);}
      if(/text\/html/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();fail('INVALID_FEED','这个地址返回网页，请使用它的 RSS/Atom 订阅地址。',422);}
      const xml=await readBounded(response),parsed=await this.parse(xml,{url:url.href,signal:combined});const entries=Array.isArray(parsed)?parsed:parsed?.items;
      if(!Array.isArray(entries))fail('RSS_PARSE_FAILED','RSS 解析结果无效。',422);return {entries,url:url.href};
    }
  }
  async fetchForTask(input){
    fields(input,['assistantId','sourceIds','limit','runId','signal']);const a=this.assistant(input.assistantId);if(a.enabled===false)fail('RSS_ASSISTANT_DISABLED','这位助手已停用。',409);
    const runId=text(input.runId,'执行编号',150),limit=input.limit??10;if(!Number.isInteger(limit)||limit<1||limit>RSS_LIMITS.itemsPerRun)fail('INVALID_RSS_ARGUMENTS','每次 RSS 结果数量需要为 1 到 30 条。');
    if(!Array.isArray(input.sourceIds)||!input.sourceIds.length||input.sourceIds.length>RSS_LIMITS.sourcesPerAssistant||input.sourceIds.some(x=>typeof x!=='string')||new Set(input.sourceIds).size!==input.sourceIds.length)fail('INVALID_RSS_ARGUMENTS','请选择 1 到 20 个不重复的信息源。');
    const sources=input.sourceIds.map(id=>{const source=(this.store.state.rssSources||[]).find(s=>s.id===id&&s.ownerId===OWNER&&s.assistantId===a.id);if(!source)fail('RSS_SOURCE_NOT_FOUND','任务选择的信息源不存在或属于其他助手。',404);return source;});
    const old=(this.store.state.rssPendingFetches||[]).find(r=>r.runId===runId&&r.ownerId===OWNER&&r.assistantId===a.id);
    if(old){if(JSON.stringify(old.sourceIds)!==JSON.stringify(input.sourceIds)||old.limit!==limit)fail('RSS_RUN_REUSED','同一个执行编号不能读取不同的信息源。',409);return cloned(old.result);}
    const key=a.id+':'+runId,signature=JSON.stringify({ids:input.sourceIds,limit});if(this.fetching.has(key)){const active=this.fetching.get(key);if(active.signature!==signature)fail('RSS_RUN_REUSED','同一个执行编号不能读取不同的信息源。',409);return active.promise;}
    const promise=this.fetchFresh({assistantId:a.id,sources,limit,runId,signal:input.signal});this.fetching.set(key,{signature,promise});try{return await promise;}finally{this.fetching.delete(key);}
  }
  async fetchFresh({assistantId,sources,limit,runId,signal}){
    const cache=new Map(),outcomes=[];let index=0;
    await Promise.all(Array.from({length:Math.min(3,sources.length)},async()=>{while(index<sources.length){const source=sources[index++];try{outcomes.push({source,...await this.fetchSource(source,{signal,cache})});}catch(e){if(signal?.aborted)throw e;outcomes.push({source,error:{sourceId:source.id,sourceName:source.name,code:e.code||'RSS_FETCH_FAILED',message:/^(RSS_|INVALID_FEED|UNSAFE_|FEED_)/.test(e.code||'')?e.message:'信息源读取失败，请稍后重试。'}});}}}));
    const errors=outcomes.filter(x=>x.error).map(x=>x.error),success=outcomes.filter(x=>!x.error);if(!success.length)throw Object.assign(Error('所选 RSS 信息源全部读取失败，本次没有生成摘要。'),{code:'RSS_ALL_SOURCES_FAILED',status:502,errors});
    const ledger=(this.store.state.rssDeliveryLedger||[]).filter(d=>d.ownerId===OWNER&&d.assistantId===assistantId),delivered=new Set(ledger.map(d=>d.key)),deliveredLinks=new Set(ledger.map(d=>d.linkKey).filter(Boolean));
    const seenKeys=new Set(),seenLinks=new Set(),items=[];let chars=0;
    for(const result of success.sort((x,y)=>sources.indexOf(x.source)-sources.indexOf(y.source))){
      for(const entry of result.entries.slice(0,Math.max(30,limit*3))){
        if(items.length>=limit||chars>=RSS_LIMITS.snapshotCharacters)break;
        if(!object(entry)||!entry.url&&!entry.link)continue;let url;try{url=(await this.resolveURL(new URL(String(entry.url||entry.link),result.url).href,{article:true,cache})).url.href;}catch{continue;}
        const remaining=RSS_LIMITS.snapshotCharacters-chars,title=plain(entry.title,Math.min(300,remaining)),summary=plain(entry.summary||entry.content,Math.min(1600,remaining-title.length));if(!title&&!summary)continue;
        const canonical=canonicalLink(url),linkKey=hash(canonical),identity=String(entry.id||entry.guid||canonical).slice(0,2048),key=hash(result.source.id+'\0'+identity);
        if(delivered.has(key)||deliveredLinks.has(linkKey)||seenKeys.has(key)||seenLinks.has(canonical))continue;
        const date=typeof entry.publishedAt==='string'?Date.parse(entry.publishedAt):NaN;
        items.push({id:key,key,linkKey,title,url:canonical,summary,publishedAt:Number.isFinite(date)?new Date(date).toISOString():null,sourceId:result.source.id,sourceName:result.source.name});seenKeys.add(key);seenLinks.add(canonical);chars+=summary.length+title.length;
      }
    }
    const result={runId,items,errors,partial:errors.length>0,retrievedAt:new Date(this.now()).toISOString(),sourceCount:sources.length,parser:'RSSHub XMLFeedParser',contentTrust:'untrusted_source_material'};
    const pending=this.store.state.rssPendingFetches||[],owned=pending.filter(r=>r.ownerId===OWNER&&r.assistantId===assistantId);if(owned.length>=RSS_LIMITS.pendingPerAssistant)fail('RSS_PENDING_LIMIT','未确认投递的 RSS 执行记录过多，请先处理已有任务。',409);
    const record={ownerId:OWNER,assistantId,runId,sourceIds:sources.map(s=>s.id),limit,result:cloned(result),committedKeys:[],createdAt:new Date(this.now()).toISOString()};
    this.store.state.rssPendingFetches=[...pending,record];try{this.store.save();}catch(e){this.store.state.rssPendingFetches=pending;throw e;}return cloned(result);
  }
  // The host calls these synchronously around its single inbox/run/ledger save.
  // They deliberately do not persist or restore unrelated application state.
  snapshotDelivery(){return {ledger:cloned(this.store.state.rssDeliveryLedger),pending:cloned(this.store.state.rssPendingFetches)};}
  restoreDelivery(snapshot){
    if(!object(snapshot)||!Object.hasOwn(snapshot,'ledger')||!Object.hasOwn(snapshot,'pending')||(snapshot.ledger!==undefined&&!Array.isArray(snapshot.ledger))||(snapshot.pending!==undefined&&!Array.isArray(snapshot.pending)))fail('INVALID_RSS_ARGUMENTS','RSS 投递回滚记录无效。');
    for(const [field,value] of [['rssDeliveryLedger',snapshot.ledger],['rssPendingFetches',snapshot.pending]])if(value===undefined)delete this.store.state[field];else this.store.state[field]=cloned(value);
  }
  discardPending(input){
    fields(input,['assistantId','runId','save']);this.assistant(input.assistantId);const runId=text(input.runId,'执行编号',150);if(input.save!==undefined&&typeof input.save!=='boolean')fail('INVALID_RSS_ARGUMENTS','快照清理方式无效。');
    const previous=this.store.state.rssPendingFetches,pending=previous||[],next=pending.filter(r=>r.ownerId!==OWNER||r.assistantId!==input.assistantId||r.runId!==runId);if(next.length===pending.length)return {ok:true,removed:false};
    this.store.state.rssPendingFetches=next;if(input.save!==false)try{this.store.save();}catch(e){if(previous===undefined)delete this.store.state.rssPendingFetches;else this.store.state.rssPendingFetches=previous;throw e;}return {ok:true,removed:true};
  }
  commitDelivery(input){
    fields(input,['assistantId','runId','itemKeys','save']);this.assistant(input.assistantId);if(input.save!==undefined&&typeof input.save!=='boolean')fail('INVALID_RSS_ARGUMENTS','投递提交方式无效。');
    const pending=this.store.state.rssPendingFetches||[],record=pending.find(r=>r.ownerId===OWNER&&r.assistantId===input.assistantId&&r.runId===input.runId);if(!record)fail('RSS_RUN_NOT_FOUND','找不到属于这位助手的 RSS 执行记录。',404);
    const known=new Map(record.result.items.map(i=>[i.key,i])),keys=input.itemKeys??[...known.keys()];if(!Array.isArray(keys)||keys.length>RSS_LIMITS.itemsPerRun||new Set(keys).size!==keys.length||keys.some(k=>typeof k!=='string'||!known.has(k)))fail('INVALID_RSS_ARGUMENTS','只能提交本次执行实际读取的条目。');
    const snapshot=this.snapshotDelivery(),ledger=this.store.state.rssDeliveryLedger||[],delivered=new Set(ledger.filter(d=>d.ownerId===OWNER&&d.assistantId===input.assistantId).map(d=>d.key)),fresh=keys.filter(k=>!delivered.has(k)),at=new Date(this.now()).toISOString();
    const own=[...ledger.filter(d=>d.ownerId===OWNER&&d.assistantId===input.assistantId),...fresh.map(key=>({ownerId:OWNER,assistantId:input.assistantId,sourceId:known.get(key).sourceId,key,linkKey:known.get(key).linkKey,deliveredAt:at,runId:record.runId}))].slice(-RSS_LIMITS.ledgerPerAssistant);
    this.store.state.rssDeliveryLedger=[...ledger.filter(d=>d.ownerId!==OWNER||d.assistantId!==input.assistantId),...own];record.committedKeys=[...new Set([...(record.committedKeys||[]),...keys])];record.lastAckAt=at;if([...known.keys()].every(k=>record.committedKeys.includes(k)))record.deliveredAt=at;
    // Keep a bounded number of completed snapshots for idempotent commit retries.
    const completed=pending.filter(r=>r.ownerId===OWNER&&r.assistantId===input.assistantId&&r.deliveredAt).sort((a,b)=>Date.parse(b.deliveredAt)-Date.parse(a.deliveredAt));const retain=new Set(completed.slice(0,30));
    this.store.state.rssPendingFetches=pending.filter(r=>r.ownerId!==OWNER||r.assistantId!==input.assistantId||!r.deliveredAt||retain.has(r));
    if(input.save!==false)try{this.store.save();}catch(e){this.restoreDelivery(snapshot);throw e;}
    return {ok:true,committed:fresh.length,duplicate:fresh.length===0};
  }
}
