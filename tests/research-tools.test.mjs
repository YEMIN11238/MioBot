import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,statSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {Store} from '../server/store.mjs';
import {handleResearchTool,parseFile,publicAddress,publicSourceURL} from '../server/research-tools.mjs';

const root=resolve(import.meta.dirname,'..'),python=process.env.MIOBOT_TEST_PYTHON?resolve(process.env.MIOBOT_TEST_PYTHON):join(root,'.runtime/astrbot-source/.venv/bin/python');
const samples=mkdtempSync(join(tmpdir(),'miobot-research-samples-'));
execFileSync(python,[join(root,'tests/helpers/generate-research-fixtures.py'),samples]);
after(()=>rmSync(samples,{recursive:true,force:true}));
const lookup=async host=>host==='mixed.example.com'?[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]:[{address:'8.8.8.8',family:4}];
async function fixture(run){const dir=mkdtempSync(join(tmpdir(),'miobot-research-test-')),store=new Store(dir),chat=store.createChat('daily');store.assistant('daily').skills.push('web','files');store.state.extensions.web=true;store.state.extensions.files=true;store.state.files=[];const scope={assistantId:'daily',chatId:chat.id,ownerId:'fixture-owner',python:{executable:python}};const upload=sample=>{const id=randomUUID(),ext=sample.slice(sample.lastIndexOf('.')),path=join(dir,'files',id+ext);mkdirSync(join(dir,'files'),{recursive:true});cpSync(join(samples,sample),path);const file={id,assistantId:'daily',ownerId:'fixture-owner',path,name:sample,size:statSync(path).size};store.state.files.push(file);return file;};try{await run({store,scope,upload,dir});}finally{rmSync(dir,{recursive:true,force:true});}}

test('unconfigured search reports needs_configuration and disabled tools never silently go online',async()=>fixture(async({store,scope})=>{
  const noFetch=()=>assert.fail('unconfigured/disabled search must not make a request');
  let r=await handleResearchTool(store,scope,'search_web',{query:'fixture'},{fetcher:noFetch,lookup});assert.equal(r.status,'needs_configuration');assert.equal(r.ok,false);
  store.state.extensions.web=false;r=await handleResearchTool(store,scope,'search_web',{query:'fixture'},{fetcher:noFetch,lookup});assert.equal(r.error.code,'DISABLED');
}));

test('actual local fake search server receives only the fixed provider request; unsafe sources and redirects are rejected',async()=>fixture(async({store,scope})=>{
  const calls=[];let redirect=false;
  const server=createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;calls.push({url:req.url,body:JSON.parse(text),authorization:req.headers.authorization});if(redirect){res.writeHead(302,{Location:'http://127.0.0.1/private'});return res.end();}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({results:[{title:'Official fixture',url:'https://source.example.com/guide',content:'24 wooden planks'},{title:'Private',url:'http://127.0.0.1/admin',content:'must not appear'},{title:'Mixed DNS',url:'https://mixed.example.com/private',content:'must not appear'}]}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  const fetcher=(url,options)=>{assert.equal(url,'https://api.tavily.com/search');assert.equal(options.redirect,'manual');return fetch(base+'/search',options);};
  try{store.secrets.extensions={web:{key:'fixture-no-real-account'}};const r=await handleResearchTool(store,scope,'search_web',{query:'Minecraft materials',maxResults:5},{fetcher,lookup,now:0});assert.equal(r.ok,true);assert.equal(r.results.length,1);assert.equal(r.filteredUnsafeSources,2);assert.equal(r.results[0].url,'https://source.example.com/guide');assert.equal(r.retrievedAt,'1970-01-01T00:00:00.000Z');assert.equal(calls.length,1);assert.equal(calls[0].body.include_raw_content,false);assert.ok(!JSON.stringify(r).includes('fixture-no-real-account'));redirect=true;assert.equal((await handleResearchTool(store,scope,'search_web',{query:'fixture'},{fetcher,lookup})).error.code,'REDIRECT_REFUSED');assert.equal(calls.length,2,'no request is made to redirect target');}
  finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}));

test('public URL guards cover local names, mapped IPs, private ranges, mixed DNS and unusual ports',async()=>{
  for(const address of ['127.0.0.1','10.1.2.3','172.17.0.2','192.168.0.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1'])assert.equal(publicAddress(address),false,address);
  assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
  for(const url of ['file:///etc/passwd','http://2130706433/','http://localhost/','http://service.local/','https://u:p@source.example.com/','https://source.example.com:8443/','https://mixed.example.com/'])assert.equal(await publicSourceURL(url,{lookup}),null,url);
});

test('real TXT, Markdown, PDF and DOCX samples are parsed locally with source labels and no arbitrary file path',async()=>fixture(async({store,scope,upload})=>{
  for(const sample of ['sample.txt','sample.md','sample.pdf','sample.docx']){const file=upload(sample),r=await handleResearchTool(store,scope,'read_file',{fileId:file.id});assert.equal(r.ok,true,JSON.stringify(r));assert.match(r.text,/MioBot/);assert.equal(r.source.fileId,file.id);assert.equal(r.truncated,false);assert.ok(!JSON.stringify(r).includes(file.path));if(sample==='sample.docx')assert.match(r.text,/木板24块/);if(sample==='sample.pdf')assert.match(r.text,/24 wooden planks/);}
  assert.equal((await handleResearchTool(store,scope,'read_file',{fileId:'/etc/passwd'})).error.code,'INVALID_ARGUMENTS');
}));

test('file access is private to the owner and assistant, and symlink escape is refused',async()=>fixture(async({store,scope,upload,dir})=>{
  const file=upload('sample.txt');assert.equal((await handleResearchTool(store,{...scope,ownerId:'other'},'read_file',{fileId:file.id})).error.code,'FILE_NOT_FOUND');
  const game=store.createChat('game');store.assistant('game').skills.push('files');assert.equal((await handleResearchTool(store,{...scope,assistantId:'game',chatId:game.id},'read_file',{fileId:file.id})).error.code,'FILE_NOT_FOUND');
  const id=randomUUID(),outside=join(dir,'outside.txt'),path=join(dir,'files',id+'.txt');writeFileSync(outside,'outside private data');symlinkSync(outside,path);store.state.files.push({id,path,name:'escape.txt',ownerId:scope.ownerId,assistantId:'daily'});assert.equal((await handleResearchTool(store,scope,'read_file',{fileId:id})).error.code,'UNSAFE_FILE');
}));

test('scan-only/encrypted PDFs, disguised binaries and active DOCX content fail truthfully; long text is explicitly truncated',async()=>fixture(async({store,scope,upload})=>{
  for(const [sample,code] of [['scanned.pdf','OCR_REQUIRED'],['encrypted.pdf','ENCRYPTED_FILE'],['binary.txt','INVALID_FILE'],['active.docx','ACTIVE_CONTENT']]){const file=upload(sample),r=await handleResearchTool(store,scope,'read_file',{fileId:file.id});assert.equal(r.ok,false,sample);assert.equal(r.error.code,code,JSON.stringify(r));}
  const file=upload('long.txt'),r=await handleResearchTool(store,scope,'read_file',{fileId:file.id});assert.equal(r.ok,true);assert.equal(r.truncated,true);assert.equal(r.text.length,24000);
}));

test('explicit configuration/file-preview tests can run while the extension stays disabled, but model args cannot grant that permission',async()=>fixture(async({store,scope,upload})=>{
  const file=upload('sample.txt');store.state.extensions.files=false;store.assistant('daily').skills=[];
  assert.equal((await handleResearchTool(store,scope,'read_file',{fileId:file.id,manualTest:true})).ok,false);
  const r=await parseFile(store,{...scope,chatId:undefined},file.id);assert.equal(r.ok,true);assert.equal(store.state.extensions.files,false);assert.deepEqual(store.assistant('daily').skills,[]);
}));

function deepseekConnection(store,{connection={},key=['fixture-miobot-own-deepseek-key']}={}){
  const value={id:'fixture-deepseek-own',apiBase:'https://api.deepseek.com/v1',model:'fixture-chat-model',type:'openai_chat_completion',template:'deepseek',...connection};
  store.state.modelConnections=[value,{id:'fixture-other-account',apiBase:'https://api.deepseek.com/v1',model:'other'}];
  store.state.extensionConfig={web:{provider:'deepseek',connectionId:value.id,maxResults:5}};
  store.secrets.modelConnections={[value.id]:{key},'fixture-other-account':{key:['fixture-other-account-never-use']}};
  store.secrets.extensions={web:{key:'fixture-tavily-never-use-for-deepseek'}};store.secrets.research={tavilyApiKey:'fixture-legacy-search-never-use-for-deepseek'};store.secrets.modelKey='fixture-legacy-chat-never-use-for-deepseek';return value;
}
function noSearchSecrets(value){
  const text=JSON.stringify(value);for(const key of ['fixture-miobot-own-deepseek-key','fixture-other-account-never-use','fixture-tavily-never-use-for-deepseek','fixture-legacy-search-never-use-for-deepseek','fixture-legacy-chat-never-use-for-deepseek','fixture-scope-never-use-for-deepseek'])assert.ok(!text.includes(key),'search result/error must never expose a credential');
}

test('DeepSeek uses only its selected MioBot official connection and the actual local HTTP fixture sees the exact fixed search contract',async()=>fixture(async({store,scope})=>{
  deepseekConnection(store);const calls=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({path:req.url,body:JSON.parse(raw),authorization:req.headers.authorization});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({results:[{title:'Long summary source',url:'https://source.example.com/deepseek',summary:'官方返回给模型的较长摘要。',snippet:'较短的界面摘要。',content:'不得抓取或假装阅读全文。'},{title:'Snippet fallback',url:'https://source.example.com/fallback',summary:'',snippet:'只有短摘要时真实返回短摘要。'},{title:'Private source',url:'http://127.0.0.1/private',summary:'must be filtered'},{title:'Mixed DNS',url:'https://mixed.example.com/private',summary:'must be filtered'}]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const fetcher=(url,options)=>{assert.equal(url,'https://api.deepseek.com/v1/tools/search');assert.equal(options.redirect,'manual');assert.equal(options.method,'POST');assert.equal(options.headers['Content-Type'],'application/json');return fetch(`http://127.0.0.1:${server.address().port}/v1/tools/search`,options);};
  try{
    const query='🚀'.repeat(128),result=await handleResearchTool(store,{...scope,searchConfig:{apiKey:'fixture-scope-never-use-for-deepseek'}},'search_web',{query,maxResults:8},{fetcher,lookup,now:0});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(calls.length,1);assert.equal(calls[0].path,'/v1/tools/search');assert.deepEqual(calls[0].body,{query,count:8,need_content:false});assert.equal(calls[0].authorization,'Bearer fixture-miobot-own-deepseek-key');assert.equal([...calls[0].body.query].length,128);assert.equal(calls[0].body.query.length,256,'astral Unicode symbols must not be counted as two characters');
    assert.equal(result.provider,'deepseek');assert.deepEqual(result.source,{kind:'search_provider',provider:'deepseek',url:'https://api.deepseek.com/v1/tools/search'});assert.equal(result.results.length,2);assert.equal(result.filteredUnsafeSources,2);assert.equal(result.results[0].snippet,'官方返回给模型的较长摘要。');assert.equal(result.results[1].snippet,'只有短摘要时真实返回短摘要。');assert.ok(!JSON.stringify(result.results).includes('不得抓取'));assert.equal(result.retrievedAt,'1970-01-01T00:00:00.000Z');assert.equal(result.chargeType,'per_successful_nonempty_request');assert.equal(result.upstreamNonempty,true);assert.deepEqual(result.pricing,{currency:'CNY',unitPrice:0.005,condition:'http_200_nonempty_results',actualChargeVerified:false,reference:'https://api-docs.deepseek.com/zh-cn/guides/search/'});noSearchSecrets(result);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}));

test('DeepSeek query limits count real Unicode characters, forbid malformed surrogates and model credential overrides, and stop before HTTP',async()=>fixture(async({store,scope})=>{
  deepseekConnection(store);let calls=0;const fetcher=async()=>{calls++;return Response.json({results:[]});};
  for(const args of [{query:'🚀'.repeat(129)},{query:'中'.repeat(129)},{query:'   '},{query:0},{query:'bad\ud800'},{query:'\udc00'},{query:'valid',maxResults:0},{query:'valid',maxResults:9},{query:'valid',maxResults:1.5},{query:'valid',apiKey:'model-may-not-select-credentials'},{query:'valid',connectionId:'fixture-other-account'},{query:'valid',provider:'tavily'},{query:'valid',url:'https://api.deepseek.com/v1/tools/search'}]){const result=await handleResearchTool(store,scope,'search_web',args,{fetcher,lookup});assert.equal(result.ok,false);assert.equal(result.error.code,'INVALID_ARGUMENTS',JSON.stringify(args));noSearchSecrets(result);}
  assert.equal(calls,0);
  const result=await handleResearchTool(store,scope,'search_web',{query:'  '+ '🧑‍🚀'.repeat(42)+'  '},{fetcher,lookup});assert.equal(result.ok,true,'ZWJ components count as Unicode code points, not grapheme clusters or UTF-16 units');assert.equal([...result.query].length,126);assert.equal(calls,1);
}));

test('missing, nonofficial or credentialless DeepSeek connections never fall back to other accounts, scope keys or Tavily',async()=>fixture(async({store,scope})=>{
  let calls=0;const fetcher=()=>{calls++;assert.fail('invalid DeepSeek configuration must not call any paid provider');};
  const scenarios=[
    ()=>{delete store.state.extensionConfig.web.connectionId;},
    ()=>{store.state.extensionConfig.web.connectionId='does-not-exist';},
    ()=>{store.state.modelConnections[0].apiBase='https://api.deepseek.com.evil.example/v1';},
    ()=>{store.state.modelConnections[0].apiBase='https://third-party-relay.example/v1';},
    ()=>{store.state.modelConnections[0].apiBase='http://api.deepseek.com/v1';},
    ()=>{store.state.modelConnections[0].apiBase='https://user@api.deepseek.com/v1';},
    ()=>{store.state.modelConnections[0].apiBase='https://api.deepseek.com:8443/v1';},
    ()=>{store.state.modelConnections[0].apiBase='https://api.deepseek.com/v1?key=hidden';},
    ()=>{store.state.modelConnections[0].apiBase='not-a-url';},
    ()=>{delete store.secrets.modelConnections['fixture-deepseek-own'];},
    ()=>{store.secrets.modelConnections['fixture-deepseek-own'].key=[];},
    ()=>{store.secrets.modelConnections['fixture-deepseek-own'].key=['unsafe\ncredential'];},
    ()=>{store.secrets.modelConnections['fixture-deepseek-own'].key={nested:'not-a-string'};},
    ()=>{store.state.modelConnections.push({...store.state.modelConnections[0]});},
    ()=>{store.state.extensionConfig.web.provider='unknown-paid-service';},
  ];
  for(const configure of scenarios){deepseekConnection(store);configure();const result=await handleResearchTool(store,{...scope,searchConfig:{apiKey:'fixture-scope-never-use-for-deepseek'}},'search_web',{query:'test'},{fetcher,lookup});assert.equal(result.ok,false);assert.equal(result.status,'needs_configuration');assert.equal(result.error.code,'NEEDS_CONFIGURATION');noSearchSecrets(result);}
  assert.equal(calls,0);
}));

test('DeepSeek HTTP failures, unsafe DNS, redirects, invalid or oversized results remain explicit failures without provider switching or secret echoes',async()=>fixture(async({store,scope})=>{
  deepseekConnection(store);let calls=0;
  const search=fetcher=>handleResearchTool(store,scope,'search_web',{query:'fixture'},{fetcher:async(url,options)=>{calls++;assert.equal(url,'https://api.deepseek.com/v1/tools/search');assert.equal(options.redirect,'manual');return fetcher();},lookup});
  for(const status of [401,402,429,503]){const result=await search(()=>new Response('fixture-miobot-own-deepseek-key',{status}));assert.equal(result.ok,false);assert.equal(result.error.code,'SEARCH_UNAVAILABLE');assert.match(result.error.message,new RegExp('HTTP '+status));assert.match(result.error.message,/DeepSeek/);noSearchSecrets(result);}
  const redirected=await search(()=>new Response('',{status:302,headers:{Location:'https://api.tavily.com/search'}}));assert.equal(redirected.error.code,'REDIRECT_REFUSED');
  const invalid=await search(()=>Response.json({wrong:'fixture-miobot-own-deepseek-key'}));assert.equal(invalid.error.code,'INVALID_RESPONSE');noSearchSecrets(invalid);
  const tooLarge=await search(()=>new Response('{}',{headers:{'Content-Length':String(1024*1024+1)}}));assert.equal(tooLarge.error.code,'RESPONSE_TOO_LARGE');
  const count=calls,unsafe=await handleResearchTool(store,scope,'search_web',{query:'fixture'},{fetcher:()=>assert.fail('private API DNS must prevent HTTP'),lookup:async()=>[{address:'127.0.0.1',family:4}]});assert.equal(unsafe.error.code,'UNSAFE_ENDPOINT');assert.equal(calls,count);
  const failed=await search(()=>{throw Error('fixture-miobot-own-deepseek-key upstream error body');});assert.equal(failed.error.code,'RESEARCH_UNAVAILABLE');noSearchSecrets(failed);assert.equal(calls,8,'each actual failure gets one provider call and no automatic retry or fallback');
}));

test('DeepSeek empty results and safety-filtered nonempty results expose the billing condition without inventing a charge',async()=>fixture(async({store,scope})=>{
  deepseekConnection(store);
  const empty=await handleResearchTool(store,scope,'search_web',{query:'empty'},{fetcher:async()=>Response.json({results:[]}),lookup});assert.equal(empty.ok,true);assert.equal(empty.total,0);assert.equal(empty.upstreamNonempty,false);assert.equal(empty.pricing.actualChargeVerified,false);
  const filtered=await handleResearchTool(store,scope,'search_web',{query:'filtered'},{fetcher:async()=>Response.json({results:[{url:'http://169.254.169.254/metadata',summary:'not public'}]}),lookup});assert.equal(filtered.ok,true);assert.equal(filtered.total,0);assert.equal(filtered.filteredUnsafeSources,1);assert.equal(filtered.upstreamNonempty,true,'an upstream nonempty response can meet provider billing conditions even if every source is filtered locally');assert.equal(filtered.pricing.actualChargeVerified,false);
}));

test('DeepSeek never reflects its selected credential through provider result titles, summaries or source links',async()=>fixture(async({store,scope})=>{
  deepseekConnection(store);const key='fixture-miobot-own-deepseek-key';
  const result=await handleResearchTool(store,scope,'search_web',{query:'fixture'},{fetcher:async()=>Response.json({results:[{title:'Provider echoed '+key,url:'https://source.example.com/safe',summary:'Never display '+key},{title:'Credential in URL',url:'https://source.example.com/?token='+key,summary:'must be filtered'}]}),lookup});assert.equal(result.ok,true);assert.equal(result.results.length,1);assert.equal(result.filteredUnsafeSources,1);assert.match(result.results[0].title,/已隐藏/);assert.match(result.results[0].snippet,/已隐藏/);noSearchSecrets(result);
}));

test('explicit Tavily configuration keeps its original request and credentials when a separate DeepSeek connection also exists',async()=>fixture(async({store,scope})=>{
  deepseekConnection(store);store.state.extensionConfig.web={provider:'tavily'};let calls=0;
  const result=await handleResearchTool(store,scope,'search_web',{query:'x'.repeat(500),maxResults:3},{lookup,fetcher:async(url,options)=>{calls++;assert.equal(url,'https://api.tavily.com/search');assert.equal(options.headers.Authorization,'Bearer fixture-tavily-never-use-for-deepseek');assert.deepEqual(JSON.parse(options.body),{query:'x'.repeat(500),search_depth:'basic',max_results:3,include_answer:false,include_raw_content:false,include_images:false});return Response.json({results:[{title:'Tavily fixture',url:'https://source.example.com/tavily',content:'Original Tavily content field',summary:'Do not use the DeepSeek branch'}]});}});
  assert.equal(result.ok,true);assert.equal(result.provider,'tavily');assert.equal(result.results[0].snippet,'Original Tavily content field');assert.equal(result.chargeType,'provider_plan');assert.equal(result.pricing,undefined);assert.equal(calls,1);noSearchSecrets(result);
}));

test('public source URL checking stays strict by default and proxy DNS opt-in never permits literal or genuine private addresses',async()=>{
  const proxy=async()=>[{address:'198.18.7.63',family:4}];
  assert.equal(publicAddress('198.18.7.63'),false);assert.equal(publicAddress('198.19.255.255'),false);
  assert.equal(await publicSourceURL('https://source.example.com/guide',{lookup:proxy}),null,'the general helper must retain its strict default');
  assert.equal(await publicSourceURL('https://source.example.com/guide',{lookup:proxy,allowProxyDNS:true}),'https://source.example.com/guide');
  assert.equal(await publicSourceURL('https://source.example.com/guide',{lookup:async()=>[{address:'198.19.255.255',family:4}],allowProxyDNS:true}),'https://source.example.com/guide');
  for(const address of ['198.18.7.63','198.19.255.255','127.0.0.1','10.0.0.1','169.254.169.254'])assert.equal(await publicSourceURL('http://'+address+'/private',{lookup:proxy,allowProxyDNS:true}),null,'literal '+address);
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','100.64.0.1'])assert.equal(await publicSourceURL('https://source.example.com/private',{lookup:async()=>[{address,family:4}],allowProxyDNS:true}),null,'private DNS '+address);
  assert.equal(await publicSourceURL('https://source.example.com/private',{lookup:async()=>[{address:'198.18.7.63',family:4},{address:'10.0.0.1',family:4}],allowProxyDNS:true}),null,'a mixed private response must not be accepted as a proxy answer');
});

test('search explicitly supports desktop Fake-IP DNS for fixed providers and returned domains without fetching source pages',async()=>fixture(async({store,scope})=>{
  for(const provider of ['deepseek','tavily']){
    deepseekConnection(store);store.state.extensionConfig.web.provider=provider;const calls=[],lookups=[];
    const fakeDNS=async host=>{lookups.push(host);if(host==='private.example.com')return [{address:'10.1.2.3',family:4}];if(host==='mixed.example.com')return [{address:'198.18.7.63',family:4},{address:'127.0.0.1',family:4}];return [{address:'198.18.7.63',family:4}];};
    const fetcher=async(url,options)=>{calls.push(url);assert.equal(url,provider==='deepseek'?'https://api.deepseek.com/v1/tools/search':'https://api.tavily.com/search');assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,provider==='deepseek'?'Bearer fixture-miobot-own-deepseek-key':'Bearer fixture-tavily-never-use-for-deepseek');return Response.json({results:[{title:'Public domain through desktop proxy',url:'https://source.example.com/guide',summary:'DeepSeek summary',content:'Tavily summary'},{title:'Fake-IP literal',url:'http://198.18.7.63/private',summary:'unsafe'},{title:'Other Fake-IP literal',url:'https://198.19.1.2/private',summary:'unsafe'},{title:'Real private DNS',url:'https://private.example.com/private',summary:'unsafe'},{title:'Mixed private DNS',url:'https://mixed.example.com/private',summary:'unsafe'}]});};
    const result=await handleResearchTool(store,scope,'search_web',{query:'desktop proxy fixture',maxResults:8},{fetcher,lookup:fakeDNS});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.provider,provider);assert.equal(result.results.length,1);assert.equal(result.results[0].url,'https://source.example.com/guide');assert.equal(result.filteredUnsafeSources,4);assert.equal(calls.length,1,'returned source URLs must never be fetched');assert.ok(lookups.includes(provider==='deepseek'?'api.deepseek.com':'api.tavily.com'));assert.ok(lookups.includes('source.example.com'));assert.ok(!lookups.includes('198.18.7.63'),'literal Fake-IP is refused before DNS');noSearchSecrets(result);
  }
  deepseekConnection(store);const rejected=await handleResearchTool(store,scope,'search_web',{query:'private API DNS'},{fetcher:()=>assert.fail('a genuinely private API DNS result must prevent the provider request'),lookup:async()=>[{address:'169.254.169.254',family:4}]});assert.equal(rejected.error.code,'UNSAFE_ENDPOINT');
}));
