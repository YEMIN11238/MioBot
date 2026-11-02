import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,symlinkSync,statSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';
import {handleMediaTool,readMediaAsset,validStickerBytes,validWav} from '../server/media-tools.mjs';

function wav(){const bytes=Buffer.alloc(44+320);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(320,40);return bytes;}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
async function fixture(run){
  const root=mkdtempSync(join(tmpdir(),'miobot-media-')),store=new Store(root),requests=[],controls={status:200,delay:0,bytes:wav(),headers:{},onRequest:null};
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;requests.push({path:req.url,headers:req.headers,body:JSON.parse(raw||'{}')});controls.onRequest?.();if(controls.delay)await new Promise(r=>setTimeout(r,controls.delay));res.writeHead(controls.status,{'Content-Type':'application/octet-stream',...controls.headers});res.end(controls.bytes);});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const assistant=store.assistant('daily');assistant.skills.push('voice','stickers');store.state.extensions.voice=true;store.state.extensions.stickers=true;
  store.state.extensionConfig={voice:{apiBase:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture-speech',voice:'fixture-voice',allowLocalProvider:true}};
  store.secrets.extensions={voice:{key:'fixture-only-key-never-live'}};
  const chat=store.createChat('daily');store.message(chat.id,'user','给我发一条语音和一个表情',{status:'complete'});
  const scope={assistantId:'daily',ownerId:'fixture-owner',chatId:chat.id,userRequestedVoice:true,userRequestedSticker:true};
  const putSticker=({ownerId=scope.ownerId,assistantId=scope.assistantId,bytes=png,mime='image/png',path:otherPath}={})=>{const id=randomUUID(),directory=join(root,'media/stickers');mkdirSync(directory,{recursive:true});const path=otherPath||join(directory,id+'.png');if(!otherPath)writeFileSync(path,bytes);const record={id,path,mime,name:'fixture开心',tags:['开心'],ownerId,assistantId};store.state.stickers||=[];store.state.stickers.push(record);return record;};
  try{await run({root,store,scope,chat,assistant,server,requests,controls,putSticker});}
  finally{server.closeAllConnections?.();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
}

test('media generation is off unless global, current assistant and current explicit request all allow it',async()=>fixture(async({store,scope,assistant,requests})=>{
  store.state.extensions.voice=false;assert.equal((await handleMediaTool(store,scope,'voice_reply',{text:'你好'})).error.code,'CAPABILITY_DISABLED');store.state.extensions.voice=true;
  assert.equal((await handleMediaTool(store,{...scope,userRequestedVoice:false},'voice_reply',{text:'你好'})).error.code,'EXPLICIT_REQUEST_REQUIRED');
  assistant.skills=assistant.skills.filter(x=>x!=='voice');assert.equal((await handleMediaTool(store,scope,'voice_reply',{text:'你好'})).error.code,'CAPABILITY_DISABLED');assistant.skills.push('voice');
  store.state.extensionConfig.voice={};assert.equal((await handleMediaTool(store,scope,'voice_reply',{text:'你好'})).error.code,'NEEDS_CONFIGURATION');assert.equal(requests.length,0);
}));

test('real loopback Speech HTTP produces a validated playable WAV, private record and idempotent public attachment',async()=>fixture(async({root,store,scope,requests})=>{
  const first=await handleMediaTool(store,scope,'voice_reply',{text:'你好，这是一段测试语音。'});assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.audio.mime,'audio/wav');assert.equal(requests.length,1);
  assert.deepEqual(requests[0].body,{model:'fixture-speech',voice:'fixture-voice',input:'你好，这是一段测试语音。',response_format:'wav'});assert.equal(requests[0].path,'/v1/audio/speech');assert.equal(requests[0].headers.authorization,'Bearer fixture-only-key-never-live');
  assert.ok(!JSON.stringify(first).includes(root));assert.ok(!JSON.stringify(first).includes('fixture-only-key-never-live'));assert.ok(!('ownerId' in first.audio));
  const record=store.state.mediaAudio[0];assert.equal(record.ownerId,scope.ownerId);assert.equal(statSync(record.path).mode&0o777,0o600);
  const asset=await readMediaAsset(store,scope,{kind:'audio',id:first.audio.id});assert.equal(asset.ok,true);assert.equal(validWav(asset.bytes),true);
  const retry=await handleMediaTool(store,scope,'voice_reply',{text:'你好，这是一段测试语音。'});assert.equal(retry.reused,true);assert.equal(retry.audio.id,first.audio.id);assert.equal(requests.length,1);
  assert.equal((await handleMediaTool(store,scope,'voice_reply',{text:'换成另外一句'})).error.code,'ALREADY_GENERATED');
  assert.equal((await readMediaAsset(store,{...scope,ownerId:'other'},{kind:'audio',id:first.audio.id})).error.code,'NOT_FOUND');assert.equal((await readMediaAsset(store,{...scope,assistantId:'game'},{kind:'audio',id:first.audio.id})).error.code,'NOT_FOUND');
  store.state.extensions.voice=false;assert.equal((await readMediaAsset(store,scope,{kind:'audio',id:first.audio.id})).ok,true,'turning off future generation does not erase earlier owned audio');
}));

test('concurrent tool retries use one Speech request and cannot replace its spoken text',async()=>fixture(async({store,scope,requests,controls})=>{
  controls.delay=50;const [a,b,c]=await Promise.all([handleMediaTool(store,scope,'voice_reply',{text:'同一句'}),handleMediaTool(store,scope,'voice_reply',{text:'同一句'}),handleMediaTool(store,scope,'voice_reply',{text:'不同句'})]);assert.equal(a.ok,true);assert.equal(b.audio.id,a.audio.id);assert.equal(c.error.code,'ALREADY_GENERATED');assert.equal(requests.length,1);
}));

test('disabling voice during generation suppresses delivery and never re-enables the switch',async()=>fixture(async({store,scope,controls})=>{
  controls.onRequest=()=>{store.state.extensions.voice=false;};const result=await handleMediaTool(store,scope,'voice_reply',{text:'这条不应交付'});assert.equal(result.error.code,'CAPABILITY_DISABLED');assert.equal(store.state.mediaAudio?.length||0,0);assert.equal(store.state.extensions.voice,false);
}));

test('private and redirected provider targets, forged audio, failed HTTP and oversized bodies cannot become successful speech',async()=>fixture(async({store,scope,requests,controls,server})=>{
  for(const address of ['http://127.0.0.1:'+server.address().port,'https://169.254.169.254','https://10.0.0.1','https://[::ffff:127.0.0.1]','https://[64:ff9b::7f00:1]','https://[2002:7f00:1::]']){store.state.extensionConfig.voice={apiBase:address,model:'fixture',voice:'fixture',allowLocalProvider:false};const result=await handleMediaTool(store,scope,'voice_reply',{text:'测试'});assert.equal(result.error.code,'UNSAFE_ENDPOINT',address);}
  store.state.extensionConfig.voice={apiBase:'https://speech.fixture.invalid/v1',model:'fixture',voice:'fixture',allowLocalProvider:false};
  assert.equal((await handleMediaTool(store,scope,'voice_reply',{text:'测试'},{lookup:async()=>[{address:'93.184.216.34',family:4},{address:'127.0.0.1',family:4}]})).error.code,'UNSAFE_ENDPOINT');assert.equal(requests.length,0);
  store.state.extensionConfig.voice={apiBase:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',voice:'fixture',allowLocalProvider:true};
  controls.status=302;controls.headers={Location:'http://127.0.0.1:1/secret'};assert.equal((await handleMediaTool(store,scope,'voice_reply',{text:'测试'})).error.code,'UPSTREAM_REDIRECT');assert.equal(requests.length,1);
  controls.status=401;controls.headers={};controls.bytes=Buffer.from('fixture-only-key-never-live');const failed=await handleMediaTool(store,scope,'voice_reply',{text:'测试'});assert.equal(failed.error.code,'SPEECH_FAILED');assert.ok(!JSON.stringify(failed).includes('fixture-only-key-never-live'));
  controls.status=200;controls.bytes=Buffer.from('{"file":"not audio"}');assert.equal((await handleMediaTool(store,scope,'voice_reply',{text:'测试'})).error.code,'INVALID_AUDIO');
  controls.headers={'Content-Length':13*1024*1024};controls.bytes=wav();assert.equal((await handleMediaTool(store,scope,'voice_reply',{text:'测试'})).error.code,'AUDIO_TOO_LARGE');assert.equal(store.state.mediaAudio?.length||0,0);
}));

test('manual voice test is an explicit one-off action and never turns either capability switch on',async()=>fixture(async({store,scope,assistant,requests})=>{
  store.state.extensions.voice=false;assistant.skills=assistant.skills.filter(x=>x!=='voice');const manual={...scope,manualTest:true,chatId:'extension-test',requestId:randomUUID()};
  assert.equal((await handleMediaTool(store,{...manual,userRequestedVoice:false},'voice_reply',{text:'试音'})).error.code,'EXPLICIT_REQUEST_REQUIRED');
  const result=await handleMediaTool(store,manual,'voice_reply',{text:'试音'});assert.equal(result.ok,true);assert.equal(requests.length,1);assert.equal(store.state.extensions.voice,false);assert.ok(!assistant.skills.includes('voice'));
  store.state.extensions.stickers=false;assert.equal((await handleMediaTool(store,manual,'send_sticker',{})).error.code,'CAPABILITY_DISABLED');
  store.state.extensions.stickers=true;assert.equal((await handleMediaTool(store,manual,'send_sticker',{})).error.code,'INVALID_SCOPE');
  const game=store.createChat('game');assert.equal((await handleMediaTool(store,{...manual,chatId:game.id},'voice_reply',{text:'试音'})).error.code,'INVALID_SCOPE');
}));

test('stickers come only from the current owner and assistant library and do not randomly select a picture',async()=>fixture(async({store,scope,putSticker})=>{
  assert.equal((await handleMediaTool(store,scope,'send_sticker',{})).error.code,'NEEDS_STICKERS');const own=putSticker(),other=putSticker({ownerId:'someone-else'}),game=putSticker({assistantId:'game'});
  const choices=await handleMediaTool(store,scope,'send_sticker',{});assert.equal(choices.error.code,'STICKER_SELECTION_REQUIRED');assert.deepEqual(choices.stickers.map(s=>s.id),[own.id]);assert.ok(!('sticker' in choices));
  const sent=await handleMediaTool(store,scope,'send_sticker',{stickerId:own.id});assert.equal(sent.ok,true);assert.equal(sent.sticker.id,own.id);assert.equal(sent.sticker.mime,'image/png');
  assert.ok(!JSON.stringify(sent).includes(own.path));assert.equal((await readMediaAsset(store,scope,{kind:'sticker',id:own.id})).bytes.equals(png),true);
  for(const id of [other.id,game.id,randomUUID()])assert.equal((await handleMediaTool(store,scope,'send_sticker',{stickerId:id})).error.code,'NOT_FOUND');
  assert.equal((await handleMediaTool(store,{...scope,userRequestedSticker:false},'send_sticker',{stickerId:own.id})).error.code,'EXPLICIT_REQUEST_REQUIRED');
}));

test('sticker paths, symlinks, HTML bytes and model-supplied recipient or URL cannot bypass the media boundary',async()=>fixture(async({root,store,scope,putSticker})=>{
  const owned=putSticker();for(const extra of [{path:owned.path},{url:'https://example.invalid/image.png'},{ownerId:'someone-else'},{assistantId:'game'}])assert.equal((await handleMediaTool(store,scope,'send_sticker',{stickerId:owned.id,...extra})).error.code,'INVALID_ARGS');
  assert.equal((await handleMediaTool(store,scope,'voice_reply',{text:'你好',apiBase:'https://example.invalid'})).error.code,'INVALID_ARGS');
  const bad=putSticker({bytes:Buffer.from('<html><script>bad</script></html>')});assert.equal((await handleMediaTool(store,scope,'send_sticker',{stickerId:bad.id})).error.code,'NOT_FOUND');
  const outside=join(root,'outside.png');writeFileSync(outside,png);const wrong=putSticker({path:outside});assert.equal((await handleMediaTool(store,scope,'send_sticker',{stickerId:wrong.id})).error.code,'NOT_FOUND');
  const id=randomUUID(),path=join(root,'media/stickers',id+'.png');symlinkSync(outside,path);store.state.stickers.push({id,path,mime:'image/png',name:'symlink',ownerId:scope.ownerId,assistantId:scope.assistantId});assert.equal((await handleMediaTool(store,scope,'send_sticker',{stickerId:id})).error.code,'NOT_FOUND');
  assert.equal(validStickerBytes(png,'image/png'),true);assert.equal(validStickerBytes(Buffer.from('<svg onload=bad>'),'image/png'),false);
}));

test('voice generation refuses symlinked media storage without writing outside the application',async()=>fixture(async({root,store,scope})=>{
  const outside=mkdtempSync(join(tmpdir(),'miobot-audio-outside-'));
  try{symlinkSync(outside,join(root,'media'));const result=await handleMediaTool(store,scope,'voice_reply',{text:'这份音频不能写到外面。'});assert.equal(result.ok,false);assert.deepEqual(readdirSync(outside),[]);assert.equal(store.state.mediaAudio?.length||0,0);}finally{rmSync(outside,{recursive:true,force:true});}
}));
