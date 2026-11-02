import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync,mkdirSync,symlinkSync,writeFileSync,statSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.mjs';
import {Extensions} from '../server/extensions.mjs';
import {validWav} from '../server/media-tools.mjs';
import {stageBundledCapabilities} from '../server/assistant-runtime.mjs';

const project=resolve(import.meta.dirname,'..'),python=process.env.MIOBOT_TEST_PYTHON?resolve(process.env.MIOBOT_TEST_PYTHON):join(project,'.runtime/astrbot-source/.venv/bin/python');
const samples=mkdtempSync(join(tmpdir(),'miobot-extension-samples-'));
execFileSync(python,[join(project,'tests/helpers/generate-research-fixtures.py'),samples]);
after(()=>rmSync(samples,{recursive:true,force:true}));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function wav(){const bytes=Buffer.alloc(44+320);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(320,40);return bytes;}
async function fixture(run){
  const root=mkdtempSync(join(tmpdir(),'miobot-extensions-')),store=new Store(root),requests=[],speech={status:200,bytes:wav()},searchCalls=[];
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push({path:req.url,body:JSON.parse(raw),authorization:req.headers.authorization});res.writeHead(speech.status,{'Content-Type':'audio/wav'});res.end(speech.bytes);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const runtime={root:project,paths:()=>({python})},ext=new Extensions({store,runtime,researchOptions:{lookup:async()=>[{address:'8.8.8.8',family:4}],fetcher:async(url,options)=>{searchCalls.push({url,options});return new Response(JSON.stringify({results:[{title:'Fixture official guide',url:'https://source.example.com/guide',content:'Fixture text'}]}),{status:200,headers:{'Content-Type':'application/json'}});},now:0}});
  const route=(path,method='GET',body={},query={})=>ext.route({path,method,body,query}),voiceConfig={apiBase:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-speech',voice:'fixture-voice',speed:1.1,allowLocalProvider:true};
  const uploadFile=(name,bytes=readFileSync(join(samples,name)),assistantId='daily')=>route('/api/files','POST',{name,mime:({txt:'text/plain',md:'text/markdown',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'})[name.split('.').at(-1)],data:bytes.toString('base64'),assistantId});
  const uploadSticker=(assistantId='daily')=>route('/api/stickers/upload','POST',{name:'开心.png',mime:'image/png',data:png.toString('base64'),assistantId,tags:['开心']});
  try{await run({root,store,runtime,ext,route,voiceConfig,requests,speech,searchCalls,uploadFile,uploadSticker});}
  finally{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
}
function noPrivate(value,root){const text=JSON.stringify(value);assert.ok(!text.includes(root),'public JSON cannot contain private storage paths');assert.ok(!text.includes('fixture-independent-key'),'public JSON cannot contain credentials');assert.ok(!text.includes('ownerId'),'public JSON cannot contain internal ownership records');}

test('six cards describe actual built-in components, default switches and independent configuration without provider calls',async()=>fixture(async({route,store,requests,searchCalls,root})=>{
  const response=await route('/api/extensions');assert.equal(response.status,200);assert.deepEqual(response.body.items.map(item=>item.id),['memory','reminders','voice','stickers','web','files']);
  for(const item of response.body.items){assert.equal(item.installed,true);if(['voice','stickers','files'].includes(item.id)){assert.equal(item.enabled,false);assert.equal(item.status,'disabled');}}
  assert.equal(response.body.items.find(item=>item.id==='voice').configurationStatus,'needs_configuration');assert.equal(response.body.items.find(item=>item.id==='files').configurationStatus,'ready');
  assert.equal(await route('/api/extensions/memory','PATCH',{enabled:false}),null);assert.equal(await route('/api/extensions/reminders','PATCH',{enabled:false}),null);assert.equal(await route('/unhandled'),null);
  assert.deepEqual(store.state.files,[]);assert.deepEqual(store.state.stickers,[]);assert.deepEqual(store.state.mediaAudio,[]);assert.deepEqual(store.secrets.extensions,{});assert.equal(requests.length+searchCalls.length,0);noPrivate(response.body,root);
}));

test('configuration and secret saving are separate from enabling and never trigger a paid request',async()=>fixture(async({route,store,voiceConfig,requests,root})=>{
  const saved=await route('/api/extensions/voice','PATCH',{config:voiceConfig,secrets:{key:'fixture-independent-key'}});assert.equal(saved.status,200);assert.equal(saved.body.item.enabled,false);assert.deepEqual(saved.body.item.secretFields,['key']);assert.equal(requests.length,0);noPrivate(saved.body,root);
  assert.equal(statSync(store.secretFile).mode&0o777,0o600);assert.equal(JSON.parse(readFileSync(store.secretFile)).extensions.voice.key,'fixture-independent-key');
  assert.equal((await route('/api/extensions/voice','PATCH',{secrets:{key:''}})).status,200);assert.equal(store.secrets.extensions.voice.key,'fixture-independent-key');
  assert.equal((await route('/api/extensions/voice','PATCH',{enabled:true})).body.item.status,'ready');assert.equal(store.state.assistants[0].skills.includes('voice'),false,'global switch does not grant assistant permission');
  assert.equal((await route('/api/extensions/voice','PATCH',{secrets:{key:null}})).status,200);assert.equal(store.secrets.extensions.voice.key,undefined);
  for(const body of [{enabled:'true'},{config:{apiBase:'http://169.254.169.254'}},{config:{apiBase:'https://x.invalid/?key=hidden'}},{config:{model:'casual model label'}},{config:{speed:99}},{config:{path:'/private'}},{secrets:{key:'unsafe\nsecret'}},{ownerId:'other'}]){const response=await route('/api/extensions/voice','PATCH',body);assert.equal(response.status,400,JSON.stringify(body));noPrivate(response.body,root);}
  assert.equal((await route('/api/extensions/web','PATCH',{config:{provider:'other'}})).status,400);assert.equal((await route('/api/extensions/web','PATCH',{config:{maxResults:10}})).status,400);assert.equal(requests.length,0);
}));

test('explicit voice test creates real playable audio and authenticated media metadata without enabling either switch',async()=>fixture(async({route,voiceConfig,store,requests,speech,root})=>{
  await route('/api/extensions/voice','PATCH',{config:voiceConfig,secrets:{key:'fixture-independent-key'}});
  const response=await route('/api/extensions/voice/test','POST',{assistantId:'daily',text:'这是一次真实音频协议测试。'});assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.body.ok,true);assert.equal(response.body.mime,'audio/wav');assert.equal(requests.length,1);assert.equal(requests[0].path,'/v1/audio/speech');assert.equal(requests[0].body.speed,1.1);assert.equal(requests[0].authorization,'Bearer fixture-independent-key');
  const audio=response.body.attachments.audio[0];assert.equal(response.body.audioUrl,audio.url);assert.equal(store.state.extensions.voice,false);assert.ok(!store.assistant('daily').skills.includes('voice'));noPrivate(response.body,root);
  const url=new URL(audio.url,'http://127.0.0.1'),asset=await route(url.pathname,'GET',{},url.searchParams);assert.equal(asset.status,200);assert.equal(validWav(asset.bytes),true);assert.equal(asset.mime,'audio/wav');assert.equal(asset.filename,audio.filename);
  assert.equal((await route(url.pathname,'GET',{},new URLSearchParams({assistantId:'game'}))).status,404);assert.equal((await route('/api/extensions/voice/test','POST',{assistantId:'missing',text:'test'})).status,404);
  speech.status=401;speech.bytes=Buffer.from('fixture-independent-key');const failed=await route('/api/extensions/voice/test','POST',{assistantId:'daily',text:'测试失败'});assert.equal(failed.status,422);assert.equal(failed.body.ok,false);noPrivate(failed.body,root);assert.equal(store.state.extensionValidation.voice.status,'failed');
}));

test('search test returns real provider results and preserves default bundled capabilities',async()=>fixture(async({route,store,searchCalls,root})=>{
  assert.equal((await route('/api/extensions/web/test','POST',{assistantId:'daily',text:'MioBot'})).status,409);assert.equal(searchCalls.length,0);
  await route('/api/extensions/web','PATCH',{config:{provider:'tavily',maxResults:3},secrets:{key:'fixture-independent-key'}});
  const response=await route('/api/extensions/web/test','POST',{assistantId:'daily',text:'Minecraft wooden planks'});assert.equal(response.status,200);assert.equal(response.body.results.length,1);assert.equal(response.body.results[0].url,'https://source.example.com/guide');assert.equal(searchCalls.length,1);assert.equal(searchCalls[0].url,'https://api.tavily.com/search');assert.equal(JSON.parse(searchCalls[0].options.body).max_results,3);assert.equal(store.state.extensions.web,true);assert.ok(store.assistant('daily').skills.includes('web'));noPrivate(response.body,root);
  assert.equal((await route('/api/extensions/web/test','POST',{assistantId:'daily',text:'x'.repeat(501)})).status,400);assert.equal(searchCalls.length,1);
}));

test('actual TXT, Markdown, PDF and DOCX uploads parse using a staged real parser with private metadata and no enable side effects',async()=>fixture(async({uploadFile,route,root,store})=>{
  for(const name of ['sample.txt','sample.md','sample.pdf','sample.docx']){const response=await uploadFile(name);assert.equal(response.status,201,JSON.stringify(response));assert.equal(response.body.item.status,'parsed');assert.match(response.body.item.textPreview,/MioBot/);assert.equal(response.body.item.assistantId,'daily');noPrivate(response.body,root);const record=store.state.files.find(item=>item.id===response.body.item.id);assert.equal(basename(record.path),record.id+name.slice(name.lastIndexOf('.')));assert.equal(statSync(record.path).mode&0o777,0o600);assert.equal(record.ownerId,'local-user');assert.match(record.text,/MioBot/);}
  assert.ok(existsSync(join(root,'astrbot/data/plugins/astrbot_plugin_miobot_research/parse_document.py')));assert.ok(existsSync(join(root,'astrbot/data/plugins/astrbot_plugin_miobot_research/.miobot-bundle.json')));
  assert.ok(stageBundledCapabilities({root:project,runtimeRoot:join(root,'astrbot'),instanceId:store.state.instanceId}).some(item=>item.id==='astrbot_plugin_miobot_research'&&item.status==='staged'),'uploading before runtime start must leave a managed, restartable bundle');assert.equal(store.state.extensions.files,false);assert.ok(!store.assistant('daily').skills.includes('files'));
  const own=await route('/api/files','GET',{},new URLSearchParams({assistantId:'daily'}));assert.equal(own.body.items.length,4);assert.equal((await route('/api/files','GET',{},new URLSearchParams({assistantId:'game'}))).body.items.length,0);noPrivate(own.body,root);
  const id=own.body.items[0].id;assert.equal((await route('/api/files/'+id,'GET',{},new URLSearchParams({assistantId:'game'}))).status,404);assert.equal((await route('/api/files/'+id,'GET',{},new URLSearchParams({assistantId:'daily'}))).body.item.status,'parsed');
}));

test('unreadable and disguised documents retain truthful parse failures and cannot become parsed attachments',async()=>fixture(async({uploadFile,store,route})=>{
  for(const [name,code] of [['scanned.pdf','OCR_REQUIRED'],['encrypted.pdf','ENCRYPTED_FILE'],['binary.txt','INVALID_FILE'],['active.docx','ACTIVE_CONTENT']]){const response=await uploadFile(name);assert.equal(response.status,422,JSON.stringify(response));assert.equal(response.body.code,code);assert.equal(response.body.item.status,'error');assert.equal(response.body.item.textPreview,'');}
  assert.equal(store.state.files.length,4);assert.ok(store.state.files.every(file=>file.status==='error'&&!file.text));
  const id=store.state.files[0].id,path=store.state.files[0].path;assert.equal((await route('/api/files/'+id,'DELETE',{},new URLSearchParams({assistantId:'daily'}))).status,200);assert.equal(existsSync(path),false);
}));

test('upload boundaries reject path names, injected owners, malformed base64, MIME mismatch and oversized bodies',async()=>fixture(async({route,store,uploadFile,root})=>{
  const base={name:'readme.txt',mime:'text/plain',data:Buffer.from('MioBot').toString('base64'),assistantId:'daily'};
  for(const patch of [{name:'../escape.txt'},{name:'a\\escape.txt'},{data:'YWJj\n'},{data:'data:text/plain;base64,YWJj'},{data:'a==='},{data:''},{ownerId:'other'},{mime:'image/png'},{assistantId:'missing'},{data:Buffer.alloc(10*1024*1024+1).toString('base64')}]){const result=await route('/api/files','POST',{...base,...patch});assert.ok([400,404].includes(result.status),JSON.stringify(result));noPrivate(result.body,root);}
  assert.equal(store.state.files.length,0);assert.equal((await uploadFile('binary.exe',Buffer.from('MZ fake'))).status,400);
  const invalid=await route('/api/stickers/upload','POST',{name:'fake.png',mime:'image/png',assistantId:'daily',data:Buffer.from('<svg onload=alert(1)>').toString('base64')});assert.equal(invalid.status,400);assert.equal(store.state.stickers.length,0);
}));

test('private sticker uploads and media reads work while disabled; deleting historical or active attachments is refused',async()=>fixture(async({uploadSticker,uploadFile,route,store,root})=>{
  const uploaded=await uploadSticker();assert.equal(uploaded.status,201);const item=uploaded.body.item;assert.deepEqual(item.tags,['开心']);noPrivate(item,root);assert.equal(store.state.extensions.stickers,false);
  assert.equal((await route('/api/stickers','GET',{},new URLSearchParams({assistantId:'daily'}))).body.items.length,1);assert.equal((await route('/api/stickers','GET',{},new URLSearchParams({assistantId:'game'}))).body.items.length,0);
  const url=new URL(item.url,'http://127.0.0.1'),asset=await route(url.pathname,'GET',{},url.searchParams);assert.equal(asset.status,200);assert.deepEqual(asset.bytes,png);assert.equal((await route(url.pathname,'GET',{},new URLSearchParams({assistantId:'game'}))).status,404);
  const chat=store.createChat('daily');store.message(chat.id,'assistant','表情',{attachments:{stickers:[{id:item.id,url:item.url}]}});const retained=await route('/api/stickers/'+item.id,'DELETE',{},new URLSearchParams({assistantId:'daily'}));assert.equal(retained.status,409);assert.equal(existsSync(store.state.stickers[0].path),true);assert.equal((await route('/api/stickers/'+item.id,'DELETE',{},new URLSearchParams({assistantId:'game'}))).status,404);
  const file=(await uploadFile('sample.txt')).body.item;chat.activeFileIds=[file.id];assert.equal((await route('/api/files/'+file.id,'DELETE',{},new URLSearchParams({assistantId:'daily'}))).status,409);delete chat.activeFileIds;const path=store.state.files[0].path;assert.equal((await route('/api/files/'+file.id,'DELETE',{},new URLSearchParams({assistantId:'daily'}))).status,200);assert.equal(existsSync(path),false);
}));

test('symlinked storage and deletion paths cannot write, serve or delete outside the owned library',async()=>fixture(async({root,route,uploadSticker,uploadFile,store})=>{
  const outside=mkdtempSync(join(tmpdir(),'miobot-ext-outside-'));
  try{
    symlinkSync(outside,join(root,'files'));assert.equal((await uploadFile('sample.txt')).status,409);assert.deepEqual(store.state.files,[]);
    mkdirSync(join(root,'media'));symlinkSync(outside,join(root,'media/stickers'));assert.equal((await uploadSticker()).status,409);assert.deepEqual(store.state.stickers,[]);
    const id=randomUUID(),outsideFile=join(outside,'keep.png');writeFileSync(outsideFile,png);store.state.stickers.push({id,path:outsideFile,assistantId:'daily',ownerId:'local-user',mime:'image/png',name:'outside'});
    assert.equal((await route('/api/media/stickers/'+id,'GET',{},new URLSearchParams({assistantId:'daily'}))).status,404);assert.equal((await route('/api/stickers/'+id,'DELETE',{},new URLSearchParams({assistantId:'daily'}))).status,409);assert.deepEqual(readFileSync(outsideFile),png);
  }finally{rmSync(outside,{recursive:true,force:true});}
}));

test('DeepSeek search selects an existing official connection without copying a key or granting assistant access',async()=>fixture(async({route,store,searchCalls,root})=>{
  store.state.modelConnections.push({id:'official-fixture',name:'Official fixture',apiBase:'https://api.deepseek.com/v1',type:'openai_chat_completion',config:{}});
  store.secrets.modelConnections['official-fixture']={key:['fixture-deepseek-private']};
  const saved=await route('/api/extensions/web','PATCH',{config:{provider:'deepseek',connectionId:'official-fixture',maxResults:5}});
  assert.equal(saved.status,200);assert.equal(saved.body.item.configurationStatus,'ready');assert.equal(saved.body.item.enabled,true);assert.equal(store.assistant('daily').skills.includes('web'),true);
  assert.equal(store.secrets.extensions.web,undefined);assert.equal(JSON.stringify(saved.body).includes('fixture-deepseek-private'),false);noPrivate(saved.body,root);
  const tested=await route('/api/extensions/web/test','POST',{assistantId:'daily',text:'MioBot integration fixture'});assert.equal(tested.status,200,JSON.stringify(tested.body));assert.equal(tested.body.provider,'deepseek');assert.equal(searchCalls.length,1);assert.equal(searchCalls[0].url,'https://api.deepseek.com/v1/tools/search');assert.equal(store.state.extensions.web,true);assert.equal(store.assistant('daily').skills.includes('web'),true);
  store.state.modelConnections.find(c=>c.id==='official-fixture').apiBase='https://relay.example/v1';
  assert.equal((await route('/api/extensions','GET')).body.items.find(c=>c.id==='web').configurationStatus,'needs_configuration');
  const invalid=await route('/api/extensions/web','PATCH',{config:{provider:'deepseek',connectionId:'official-fixture'}});assert.equal(invalid.status,400);
}));
