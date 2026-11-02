import {lookup as dnsLookup} from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import {isIP} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile,lstat,realpath,readFile} from 'node:fs/promises';
import {join,resolve,dirname,basename,extname} from 'node:path';

export const MEDIA_TOOL_NAMES=['voice_reply','send_sticker'];
export const MEDIA_MODEL_TOOLS=['miobot_voice_reply','miobot_send_sticker'];
export const MEDIA_LIMITS={textCharacters:500,audioBytes:12*1024*1024,stickerBytes:5*1024*1024};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_EXT={'image/png':'.png','image/gif':'.gif','image/jpeg':'.jpg','image/webp':'.webp'};
const inFlight=new Map();
const failure=(code,message,extra={})=>({ok:false,error:{code,message},...extra});
const digest=value=>createHash('sha256').update(value).digest('hex');
const ownObject=x=>x&&typeof x==='object'&&!Array.isArray(x);

function checkScope(store,scope){
  if(!scope||!['assistantId','ownerId','chatId'].every(key=>typeof scope[key]==='string'&&scope[key].trim()&&scope[key].length<=200))return null;
  const assistant=store.state.assistants.find(a=>a.id===scope.assistantId);
  const chat=store.state.chats.find(c=>c.id===scope.chatId);
  if(!assistant?.enabled||chat&&chat.assistantId!==assistant.id||!chat&&scope.manualTest!==true)return null;
  return {assistant,chat};
}

function capabilityAllowed(store,scope,name){
  const checked=checkScope(store,scope);
  if(!checked)return failure('INVALID_SCOPE','当前助手或会话没有媒体使用权限。');
  const manualVoiceTest=name==='voice'&&scope.manualTest===true;
  if(!manualVoiceTest&&(store.state.extensions?.[name]!==true||!checked.assistant.skills?.includes(name)))return failure('CAPABILITY_DISABLED',name==='voice'?'语音回复尚未启用，没有生成语音。':'表情功能尚未启用，没有发送图片。');
  if(!manualVoiceTest&&!checked.chat)return failure('INVALID_SCOPE','当前助手或会话没有媒体使用权限。');
  const requested=name==='voice'?scope.userRequestedVoice:scope.userRequestedSticker;
  if(requested!==true)return failure('EXPLICIT_REQUEST_REQUIRED',name==='voice'?'当前没有明确的语音请求，未调用语音服务。':'当前没有明确的表情请求，未发送图片。');
  return checked;
}

/** Save only these public fields; provider credentials are deliberately separate. */
export function normalizeVoiceConfig(config={}){
  if(!ownObject(config))throw new Error('语音配置格式无效。');
  const result={apiBase:String(config.apiBase||'').trim(),model:String(config.model||'').trim(),voice:String(config.voice||'').trim(),allowLocalProvider:config.allowLocalProvider===true};
  if(config.speed!==undefined){if(typeof config.speed!=='number'||!Number.isFinite(config.speed)||config.speed<0.25||config.speed>4)throw new Error('语速需要在0.25到4之间。');result.speed=config.speed;}
  if(result.apiBase){const u=new URL(result.apiBase);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('语音服务地址需要有效的 HTTPS 地址。');result.apiBase=u.href.replace(/\/$/,'');}
  for(const key of ['model','voice'])if(result[key]&&(!/^\S+$/.test(result[key])||result[key].length>150))throw new Error('语音模型和音色需要填写服务商的准确标识。');
  return result;
}

function localAddress(address){
  const clean=address.replace(/^\[|\]$/g,'').toLowerCase();
  if(isIP(clean)===4){const [a,b,c]=clean.split('.').map(Number);return a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===88&&c===99)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113||a>=224;}
  if(isIP(clean)===6){if(clean.startsWith('::ffff:')){const suffix=clean.slice(7);if(isIP(suffix)===4)return localAddress(suffix);const m=suffix.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);if(m){const n=parseInt(m[1],16)*65536+parseInt(m[2],16);return localAddress([n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.'));}}
    return !/^[23][0-9a-f]{0,3}:/.test(clean)||clean.startsWith('2001:db8:')||clean.startsWith('2002:')||clean.startsWith('2001:0:')||clean.startsWith('2001::');}
  return false;
}
const loopback=address=>address==='::1'||/^127\./.test(address);

async function speechEndpoint(config,lookup){
  const url=new URL(config.apiBase.replace(/\/$/,'')+'/audio/speech');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  let records;
  if(isIP(host))records=[{address:host,family:isIP(host)}];
  else{let timer;try{records=await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('ENDPOINT_UNAVAILABLE')),5000);timer.unref?.();})]);}finally{clearTimeout(timer);}}
  if(!Array.isArray(records)||!records.length||records.some(r=>!isIP(r.address)))throw new Error('UNSAFE_ENDPOINT');
  const explicitLoopback=config.allowLocalProvider&&records.every(r=>loopback(r.address));
  if(records.some(r=>localAddress(r.address))&&!explicitLoopback)throw new Error('UNSAFE_ENDPOINT');
  if(url.protocol!=='https:'&&!explicitLoopback)throw new Error('UNSAFE_ENDPOINT');
  return {url,address:records[0].address,family:records[0].family};
}

/** Pin the validated DNS address; redirects and environment proxies are not used. */
function nativePost(endpoint,{headers,body,signal}){
  return new Promise((resolvePromise,reject)=>{
    const transport=endpoint.url.protocol==='https:'?https:http;
    const request=transport.request(endpoint.url,{method:'POST',headers,signal,lookup:(_hostname,options,callback)=>options.all?callback(null,[{address:endpoint.address,family:endpoint.family}]):callback(null,endpoint.address,endpoint.family)},response=>{
      const chunks=[];let size=0;
      const declared=Number(response.headers['content-length']||0);
      if(declared>MEDIA_LIMITS.audioBytes){response.destroy();return reject(new Error('AUDIO_TOO_LARGE'));}
      response.on('data',chunk=>{size+=chunk.length;if(size>MEDIA_LIMITS.audioBytes){response.destroy(new Error('AUDIO_TOO_LARGE'));return;}chunks.push(chunk);});
      response.once('error',reject);
      response.once('end',()=>resolvePromise({status:response.statusCode,bytes:Buffer.concat(chunks)}));
    });
    request.once('error',reject);request.setTimeout(20000,()=>request.destroy(new Error('SPEECH_TIMEOUT')));request.end(body);
  });
}

async function postSpeech(endpoint,options,fetcher){
  if(!fetcher)return nativePost(endpoint,options);
  const response=await fetcher(endpoint.url.href,{method:'POST',headers:options.headers,body:options.body,signal:options.signal,redirect:'manual'});
  const chunks=[];let size=0;
  if(Number(response.headers.get('content-length')||0)>MEDIA_LIMITS.audioBytes)throw new Error('AUDIO_TOO_LARGE');
  for await(const chunk of response.body||[]){size+=chunk.length;if(size>MEDIA_LIMITS.audioBytes)throw new Error('AUDIO_TOO_LARGE');chunks.push(Buffer.from(chunk));}
  return {status:response.status,bytes:Buffer.concat(chunks)};
}

export function validWav(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<46||bytes.length>MEDIA_LIMITS.audioBytes||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')return false;
  let format=false,data=false;
  for(let offset=12;offset+8<=bytes.length;){const tag=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),available=bytes.length-offset-8;
    if(tag==='fmt '){if(length<16||available<16)return false;const encoding=bytes.readUInt16LE(offset+8),channels=bytes.readUInt16LE(offset+10),rate=bytes.readUInt32LE(offset+12),bits=bytes.readUInt16LE(offset+22);format=[1,3,65534].includes(encoding)&&channels>=1&&channels<=8&&rate>=8000&&rate<=192000&&[8,16,24,32,64].includes(bits);}
    if(tag==='data'){data=available>0&&(length===0xffffffff||length<=available);break;}
    if(length>available)return false;offset+=8+length+(length%2);
  }
  return format&&data;
}

export function validStickerBytes(bytes,mime){
  if(!Buffer.isBuffer(bytes)||bytes.length<10||bytes.length>MEDIA_LIMITS.stickerBytes)return false;
  if(mime==='image/png')return bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(16)<=8192&&bytes.readUInt32BE(20)>0&&bytes.readUInt32BE(20)<=8192;
  if(mime==='image/gif')return /^GIF8[79]a$/.test(bytes.toString('ascii',0,6))&&bytes.readUInt16LE(6)>0&&bytes.readUInt16LE(6)<=8192&&bytes.readUInt16LE(8)>0&&bytes.readUInt16LE(8)<=8192;
  if(mime==='image/jpeg')return bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217;
  if(mime==='image/webp')return bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  return false;
}

async function mediaDirectory(store,kind,create=false){
  const canonicalRoot=await realpath(store.root),mediaDir=join(canonicalRoot,'media'),allowedDir=join(mediaDir,kind==='audio'?'audio':'stickers');
  for(const directory of [mediaDir,allowedDir]){if(create)await mkdir(directory,{recursive:true,mode:0o700});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory)throw new Error('INVALID_MEDIA_FILE');}
  return allowedDir;
}
async function safeFile(store,record,kind){
  const allowedDir=await mediaDirectory(store,kind);
  const path=resolve(record.path||'');const ext=extname(path).toLowerCase(),stem=basename(path,ext);
  if(!UUID.test(record.id)||stem!==record.id||kind==='audio'&&ext!=='.wav'||kind==='sticker'&&!(MIME_EXT[record.mime]===ext||record.mime==='image/jpeg'&&ext==='.jpeg'))throw new Error('INVALID_MEDIA_FILE');
  const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>(kind==='audio'?MEDIA_LIMITS.audioBytes:MEDIA_LIMITS.stickerBytes))throw new Error('INVALID_MEDIA_FILE');
  const actual=await realpath(path);if(dirname(actual)!==allowedDir)throw new Error('INVALID_MEDIA_FILE');
  const bytes=await readFile(path);if(kind==='audio'?!validWav(bytes):!validStickerBytes(bytes,record.mime))throw new Error('INVALID_MEDIA_FILE');
  return {bytes,path:actual,mime:record.mime};
}

/** Authenticated HTTP asset routes may use this; model tools never return bytes or paths. */
export async function readMediaAsset(store,scope,{kind,id}){
  if(!scope?.assistantId||!scope?.ownerId||!UUID.test(String(id))||!['audio','sticker'].includes(kind))return failure('NOT_FOUND','媒体不存在或无权读取。');
  const records=kind==='audio'?store.state.mediaAudio||[]:store.state.stickers||[];
  const record=records.find(item=>item.id===id&&item.ownerId===scope.ownerId&&item.assistantId===scope.assistantId);
  if(!record)return failure('NOT_FOUND','媒体不存在或无权读取。');
  try{const content=await safeFile(store,record,kind);return {ok:true,...content,filename:record.filename||record.name||basename(content.path)};}catch{return failure('NOT_FOUND','媒体文件不可用，请重新生成或上传。');}
}

async function voiceReply(store,scope,args,{fetcher,lookup=dnsLookup,signal}={}){
  const allowed=capabilityAllowed(store,scope,'voice');if(allowed.ok===false)return allowed;
  if(!ownObject(args)||Object.keys(args).some(k=>k!=='text')||typeof args.text!=='string'||!args.text.trim()||args.text.length>MEDIA_LIMITS.textCharacters)return failure('INVALID_ARGS','语音内容需为1到500字，不能指定模型、地址或收件人。');
  let config;try{config=normalizeVoiceConfig(store.state.extensionConfig?.voice||{});}catch{return failure('NEEDS_CONFIGURATION','请先保存有效的语音服务地址、模型和音色。');}
  const key=store.secrets.extensions?.voice?.key||'';
  if(!config.apiBase||!config.model||!config.voice||typeof key!=='string'||(!key&&!config.allowLocalProvider))return failure('NEEDS_CONFIGURATION','请先配置独立的语音服务、模型、音色和所需凭据。');
  let endpoint;try{endpoint=await speechEndpoint(config,lookup);}catch(error){return error?.message==='UNSAFE_ENDPOINT'?failure('UNSAFE_ENDPOINT','语音服务地址不可用；默认只允许公开HTTPS服务，本机服务需要明确启用。'):failure('ENDPOINT_UNAVAILABLE','无法解析语音服务地址，请检查网络和配置。');}
  const text=args.text.trim(),turn=scope.manualTest?scope.requestId||randomUUID():scope.userMessageId||allowed.chat?.messages.findLast(m=>m.role==='user')?.id||scope.requestId||randomUUID();
  const requestKey=digest(JSON.stringify([scope.assistantId,scope.ownerId,scope.chatId,turn]));
  const old=(store.state.mediaAudio||[]).find(item=>item.requestKey===requestKey);
  if(old){if(old.textSha256!==digest(text))return failure('ALREADY_GENERATED','这条请求已经生成过语音，请发起新的明确请求后再生成。');const file=await readMediaAsset(store,scope,{kind:'audio',id:old.id});if(!file.ok)return file;return {ok:true,audio:{id:old.id,kind:'audio',mime:old.mime,filename:old.filename,size:old.size},reused:true};}
  const pendingKey=resolve(store.root)+':'+requestKey;
  if(inFlight.has(pendingKey)){const pending=inFlight.get(pendingKey);if(pending.textHash!==digest(text))return failure('ALREADY_GENERATED','这一条请求已有语音正在生成，请等待完成后再提出新的请求。');return pending.promise;}
  const running=(async()=>{try{
    const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(25000)]):AbortSignal.timeout(25000);
    const body=JSON.stringify({model:config.model,voice:config.voice,input:text,response_format:'wav',...(config.speed!==undefined?{speed:config.speed}:{})});
    const result=await postSpeech(endpoint,{headers:{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body)),...(key?{Authorization:'Bearer '+key}:{})},body,signal:requestSignal},fetcher);
    if(result.status>=300&&result.status<400)return failure('UPSTREAM_REDIRECT','语音服务返回了跳转，未跟随跳转或发送语音。');
    if(result.status<200||result.status>=300)return failure('SPEECH_FAILED','语音服务请求失败（HTTP '+result.status+'），没有生成语音。');
    if(!validWav(result.bytes))return failure('INVALID_AUDIO','语音服务未返回有效的WAV音频，没有发送语音。');
    signal?.throwIfAborted();
    const stillAllowed=capabilityAllowed(store,scope,'voice');if(stillAllowed.ok===false)return stillAllowed;
    const id=randomUUID(),filename=id+'.wav',directory=await mediaDirectory(store,'audio',true);
    const path=join(directory,filename);await writeFile(path,result.bytes,{flag:'wx',mode:0o600});
    const record={id,kind:'audio',path,filename,mime:'audio/wav',assistantId:scope.assistantId,ownerId:scope.ownerId,chatId:scope.chatId,size:result.bytes.length,sha256:digest(result.bytes),createdAt:new Date().toISOString(),requestKey,userMessageId:turn,textSha256:digest(text)};
    store.state.mediaAudio||=[];store.state.mediaAudio.push(record);store.save();
    return {ok:true,audio:{id,kind:'audio',mime:record.mime,filename,size:record.size}};
  }catch(error){return failure(error?.message==='AUDIO_TOO_LARGE'?'AUDIO_TOO_LARGE':'SPEECH_FAILED',error?.message==='AUDIO_TOO_LARGE'?'返回音频超过允许大小，没有发送语音。':'语音生成未完成，请检查连接后重试。');}finally{inFlight.delete(pendingKey);}})();
  inFlight.set(pendingKey,{promise:running,textHash:digest(text)});return running;
}

async function sendSticker(store,scope,args){
  const allowed=capabilityAllowed(store,scope,'stickers');if(allowed.ok===false)return allowed;
  if(!ownObject(args)||Object.keys(args).some(k=>k!=='stickerId')||args.stickerId!==undefined&&typeof args.stickerId!=='string')return failure('INVALID_ARGS','只能选择当前助手已授权图库中的表情编号。');
  const own=(store.state.stickers||[]).filter(item=>item.assistantId===scope.assistantId&&item.ownerId===scope.ownerId);
  if(!args.stickerId){if(!own.length)return failure('NEEDS_STICKERS','专属图库为空，请先上传你有权使用的表情。');return failure('STICKER_SELECTION_REQUIRED','请从返回的授权图库中选择真实表情编号，再调用一次；当前尚未发送图片。',{stickers:own.slice(0,30).map(item=>({id:item.id,name:String(item.name||'表情').slice(0,100),mime:item.mime,tags:Array.isArray(item.tags)?item.tags.filter(v=>typeof v==='string').slice(0,10).map(v=>v.slice(0,30)):[]}))});}
  const record=own.find(item=>item.id===args.stickerId);if(!record)return failure('NOT_FOUND','表情不存在或不属于当前助手的专属图库。');
  const file=await readMediaAsset(store,scope,{kind:'sticker',id:record.id});if(!file.ok)return file;
  const stillAllowed=capabilityAllowed(store,scope,'stickers');if(stillAllowed.ok===false)return stillAllowed;
  return {ok:true,sticker:{id:record.id,kind:'sticker',mime:record.mime,name:record.name||'表情',filename:basename(record.path),size:file.bytes.length}};
}

/** Recipient and ownership are supplied by the trusted application bridge. */
export async function handleMediaTool(store,scope,name,args={},options={}){
  if(name==='voice_reply')return voiceReply(store,scope,args,options);
  if(name==='send_sticker')return sendSticker(store,scope,args);
  return failure('UNKNOWN_TOOL','未找到这个媒体工具。');
}
