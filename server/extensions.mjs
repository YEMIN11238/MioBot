import {randomUUID,createHash} from 'node:crypto';
import {mkdir,lstat,realpath,writeFile,unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve,dirname,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isIP} from 'node:net';
import {handleMediaTool,normalizeVoiceConfig,validStickerBytes,readMediaAsset,MEDIA_LIMITS} from './media-tools.mjs';
import {handleResearchTool,parseFile,publicAddress,RESEARCH_PLUGIN,FILE_FORMATS,FILE_LIMIT} from './research-tools.mjs';
import {stageBundledCapabilities,MEMORY_PLUGIN,GAME_PLUGIN,TASK_PLUGIN,MEDIA_PLUGIN,PROACTIVE_PLUGIN,HUMAN_PLUGIN,CLEAN_PLUGIN} from './assistant-runtime.mjs';

const OWNER='local-user',ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const IDS=['memory','reminders','voice','stickers','web','files'];
const NAMES={memory:'手动记忆',reminders:'定时提醒',voice:'语音回复',stickers:'私有表情图库',web:'网页资料检索',files:'文件阅读'};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_EXT={'image/png':'.png','image/jpeg':'.jpg','image/gif':'.gif','image/webp':'.webp'};
const DOC_MIME={'.txt':'text/plain','.md':'text/markdown','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const json=(body,status=200)=>({status,body});
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const queryValue=(query,key)=>typeof query?.get==='function'?query.get(key):query?.[key];
const hash=value=>createHash('sha256').update(value).digest('hex');

function fields(value,allowed,label='提交内容'){
  if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(400,'INVALID_ARGUMENTS',label+'包含不支持的字段。');
}
function nameOf(value){
  if(typeof value!=='string'||!value.trim()||value.length>180||/[\x00-\x1f\x7f/\\]/.test(value)||value==='.'||value==='..')fail(400,'INVALID_NAME','文件名称无效，请使用不含路径的普通文件名。');
  return value.trim();
}
function decodeUpload(value,limit){
  if(typeof value!=='string'||!value||value.length>Math.ceil(limit/3)*4||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))fail(400,'INVALID_UPLOAD','文件数据无效或超过允许大小。');
  const bytes=Buffer.from(value,'base64');
  if(!bytes.length||bytes.length>limit||bytes.toString('base64')!==value)fail(400,'INVALID_UPLOAD','文件数据无效或超过允许大小。');
  return bytes;
}
function extensionError(result){
  return json({ok:false,error:result.error?.message||'这次请求没有完成。',code:result.error?.code||'EXTENSION_FAILED'},result.error?.code==='NEEDS_CONFIGURATION'?409:422);
}
function defaultConfig(id){
  if(id==='voice')return {apiBase:'',model:'',voice:'',speed:1,allowLocalProvider:false,trigger:'on_request'};
  if(id==='web')return {provider:'tavily',maxResults:5};
  return {};
}
function voiceConfig(value){
  fields(value,['apiBase','model','voice','speed','allowLocalProvider','trigger'],'语音配置');
  if(value.trigger!==undefined&&value.trigger!=='on_request')fail(400,'INVALID_CONFIGURATION','语音目前仅支持明确请求时触发。');
  if(value.allowLocalProvider!==undefined&&typeof value.allowLocalProvider!=='boolean')fail(400,'INVALID_CONFIGURATION','本机语音服务授权格式无效。');
  let config;try{config={...normalizeVoiceConfig(value),trigger:'on_request'};}catch{fail(400,'INVALID_CONFIGURATION','语音配置无效，请核对接口地址、准确模型/音色ID及0.25到4的语速。');}
  if(config.apiBase){
    const u=new URL(config.apiBase),host=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
    const local=config.allowLocalProvider&&(host==='localhost'||host==='::1'||/^127\./.test(host));
    if(!local&&(u.protocol!=='https:'||isIP(host)&&!publicAddress(host)||host==='localhost'||/\.(?:local|internal|lan|home)$/.test(host)))fail(400,'UNSAFE_ENDPOINT','语音地址默认需要公开HTTPS服务；只有明确授权的本机服务可以使用回环地址。');
  }
  return config;
}
function normalizeConfig(id,value){
  if(id==='voice')return voiceConfig(value);
  if(id==='web'){
    fields(value,['provider','maxResults','connectionId'],'搜索配置');
    const provider=value.provider||'tavily';
    if(!['tavily','deepseek'].includes(provider)||value.maxResults!==undefined&&(!Number.isInteger(value.maxResults)||value.maxResults<1||value.maxResults>8))fail(400,'INVALID_CONFIGURATION','请选择支持的搜索服务，每次结果数量需要在1到8之间。');
    if(value.connectionId!==undefined&&(typeof value.connectionId!=='string'||value.connectionId.length>150))fail(400,'INVALID_CONFIGURATION','请选择已保存的官方DeepSeek连接。');
    return {provider,maxResults:value.maxResults??5,...(provider==='deepseek'?{connectionId:value.connectionId||''}:{})};
  }
  fields(value,[],'扩展配置');return {};
}
function publicFile(item){
  return {id:item.id,name:item.name,mime:item.mime,status:item.status||'error',textPreview:String(item.textPreview||'').slice(0,6000),size:item.size,assistantId:item.assistantId,createdAt:item.createdAt,truncated:item.truncated===true,...(item.error?{error:String(item.error).slice(0,250)}:{})};
}
function assetURL(kind,id,assistantId){return '/api/media/'+kind+'/'+encodeURIComponent(id)+'?assistantId='+encodeURIComponent(assistantId);}
function publicSticker(item){return {id:item.id,name:item.name,mime:item.mime,size:item.size,tags:item.tags||[],assistantId:item.assistantId,createdAt:item.createdAt,url:assetURL('stickers',item.id,item.assistantId)};}
function inUse(value,id,seen=new Set()){
  if(typeof value==='string')return value===id||value.includes('/'+id+'?')||value.endsWith('/'+id);
  if(!value||typeof value!=='object'||seen.has(value))return false;
  seen.add(value);return Object.values(value).some(item=>inUse(item,id,seen));
}

/** Local authenticated host routes; caller must authenticate before invoking route(). */
export class Extensions{
  constructor({store,runtime,mediaOptions={},researchOptions={}}){
    this.store=store;this.runtime=runtime;this.mediaOptions=mediaOptions;this.researchOptions=researchOptions;
    store.state.extensions||={};store.state.extensionConfig||={};store.state.extensionValidation||={};
    for(const id of ['voice','stickers','web','files']){store.state.extensions[id]??=false;store.state.extensionConfig[id]??=defaultConfig(id);}
    store.state.files||=[];store.state.stickers||=[];store.state.mediaAudio||=[];
    if(!object(store.secrets.extensions))store.setSecrets({extensions:{}});
    store.save();
  }
  assistant(id){
    if(typeof id!=='string'||!this.store.state.assistants.some(item=>item.id===id))fail(404,'ASSISTANT_NOT_FOUND','找不到这个助手。');
    return this.store.assistant(id);
  }
  scope(id){const assistant=this.assistant(id);return {assistantId:assistant.id,ownerId:OWNER};}
  pluginPath(id,file='main.py'){return join(this.runtime?.root||ROOT,'integrations/plugins',id,file);}
  publicConfig(id){
    try{return normalizeConfig(id,{...defaultConfig(id),...(this.store.state.extensionConfig[id]||{})});}catch{return defaultConfig(id);}
  }
  deepseekConnectionReady(id){
    const connection=this.store.state.modelConnections.find(c=>c.id===id);
    try{const url=new URL(connection?.apiBase),keys=this.store.secrets.modelConnections?.[id]?.key;return url.protocol==='https:'&&url.hostname==='api.deepseek.com'&&!url.username&&!url.password&&!url.search&&!url.hash&&(!url.port||url.port==='443')&&Array.isArray(keys)&&keys.some(key=>typeof key==='string'&&key.trim());}catch{return false;}
  }
  card(id){
    const enabled=this.store.state.extensions[id]===true,config=this.publicConfig(id),secrets=this.store.secrets.extensions?.[id]||{};
    const installed=['memory','reminders'].includes(id)||existsSync(this.pluginPath(['voice','stickers'].includes(id)?'astrbot_plugin_miobot_media':RESEARCH_PLUGIN,id==='files'?'parse_document.py':'main.py'));
    let configured=true;
    if(id==='voice')configured=!!(config.apiBase&&config.model&&config.voice&&(secrets.key||config.allowLocalProvider));
    if(id==='web')configured=config.provider==='deepseek'?this.deepseekConnectionReady(config.connectionId):!!secrets.key;
    if(id==='files'){const paths=this.runtime?.paths?.();configured=!!paths?.python&&existsSync(paths.python);}
    return {id,name:NAMES[id],installed,enabled,status:!installed?'error':!enabled?'disabled':configured?'ready':'needs_configuration',configurationStatus:configured?'ready':'needs_configuration',config,secretFields:typeof secrets.key==='string'&&secrets.key?['key']:[],...(this.store.state.extensionValidation[id]?{validation:structuredClone(this.store.state.extensionValidation[id])}:{}),...(!installed?{error:'内置组件缺失，请重新安装MioBot。'}:{})};
  }
  async safeDirectory(segments){
    const base=await realpath(this.store.root);let directory=base;
    for(const segment of segments){directory=join(directory,segment);await mkdir(directory,{recursive:true,mode:0o700});const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory)fail(409,'UNSAFE_STORAGE','资料目录不可用，未写入文件。');}
    return directory;
  }
  async parserScope(scope){
    const paths=this.runtime?.paths?.()||{};
    if(typeof paths.python!=='string'||!existsSync(paths.python))return {...scope,python:{executable:''}};
    const source=this.pluginPath(RESEARCH_PLUGIN,'parse_document.py');
    if(!existsSync(source))return {...scope,python:{executable:''}};
    const runtimeRoot=await this.safeDirectory(['astrbot']),plugins=await this.safeDirectory(['astrbot','data','plugins']);
    await this.safeDirectory(['astrbot','data','config']);const skills=await this.safeDirectory(['astrbot','data','skills']);
    for(const directory of [...[MEMORY_PLUGIN,GAME_PLUGIN,TASK_PLUGIN,RESEARCH_PLUGIN,MEDIA_PLUGIN,PROACTIVE_PLUGIN,HUMAN_PLUGIN,CLEAN_PLUGIN].map(id=>join(plugins,id)),join(skills,'minecraft-guide')]){
      if(existsSync(directory)){const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(directory)!==directory)fail(409,'UNSAFE_STORAGE','文件解析组件的目录不可用。');}
    }
    // Use the same managed staging/fingerprint path as runtime.start(). A lone
    // parser file would look like an unowned plugin and block the next start.
    stageBundledCapabilities({root:this.runtime?.root||ROOT,runtimeRoot,instanceId:this.store.state.instanceId});
    const target=join(plugins,RESEARCH_PLUGIN,'parse_document.py'),stat=await lstat(target);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail(409,'UNSAFE_STORAGE','文件解析组件不可用。');
    return {...scope,parserScript:target,python:{executable:paths.python,env:{...(paths.home?{PYTHONHOME:paths.home}:{}),...(paths.packages?{PYTHONPATH:paths.packages}:{})}}};
  }
  async patch(id,body){
    fields(body,['enabled','config','secrets']);
    if(body.enabled!==undefined&&typeof body.enabled!=='boolean')fail(400,'INVALID_ARGUMENTS','扩展开关需要true或false。');
    const current=this.publicConfig(id),config=body.config===undefined?current:normalizeConfig(id,{...current,...(object(body.config)?body.config:fail(400,'INVALID_CONFIGURATION','扩展配置格式无效。'))});
    if(id==='web'&&config.provider==='deepseek'&&config.connectionId&&!this.deepseekConnectionReady(config.connectionId))fail(400,'INVALID_CONFIGURATION','这条连接不是带有效密钥的官方DeepSeek连接，请先在模型连接中检查。');
    let savedSecrets={...(this.store.secrets.extensions[id]||{})};
    if(body.secrets!==undefined){fields(body.secrets,['key'],'服务密钥');if(!['voice','web'].includes(id)&&Object.keys(body.secrets).length)fail(400,'INVALID_ARGUMENTS','这项扩展不需要服务密钥。');
      if(body.secrets.key!==undefined){const key=body.secrets.key;if(key===null)delete savedSecrets.key;else if(typeof key!=='string'||key.length>2000||/[\x00-\x1f\x7f]/.test(key))fail(400,'INVALID_SECRET','服务密钥格式无效。');else if(key.trim())savedSecrets.key=key.trim();}
    }
    // Validate all fields before either persistence step. Saving never calls a provider.
    if(body.config!==undefined||body.secrets!==undefined)delete this.store.state.extensionValidation[id];
    this.store.state.extensionConfig[id]=config;
    if(body.enabled!==undefined)this.store.state.extensions[id]=body.enabled;
    if(body.secrets!==undefined)this.store.setSecrets({extensions:{...this.store.secrets.extensions,[id]:savedSecrets}});
    this.store.save();return json({ok:true,item:this.card(id)});
  }
  async test(id,body){
    fields(body,['assistantId','text']);const scope={...this.scope(body.assistantId),manualTest:true};
    if(typeof body.text!=='string'||!body.text.trim()||body.text.length>500)fail(400,'INVALID_ARGUMENTS','测试内容需要1到500字。');
    let result;
    if(id==='voice')result=await handleMediaTool(this.store,{...scope,chatId:'extension-test',requestId:randomUUID(),userRequestedVoice:true},'voice_reply',{text:body.text},this.mediaOptions);
    else result=await handleResearchTool(this.store,scope,'search_web',{query:body.text,maxResults:this.publicConfig('web').maxResults},this.researchOptions);
    this.store.state.extensionValidation[id]={status:result.ok?'passed':'failed',at:new Date().toISOString(),...(result.ok?{}:{error:result.error?.message||'测试没有完成。'})};this.store.save();
    if(!result.ok)return extensionError(result);
    if(id==='voice'){const audio={...result.audio,url:assetURL('audio',result.audio.id,scope.assistantId)};return json({ok:true,audioUrl:audio.url,mime:audio.mime,attachments:{audio:[audio]}});}
    return json(result);
  }
  async uploadFile(body){
    fields(body,['name','mime','data','assistantId']);const scope=this.scope(body.assistantId),name=nameOf(body.name),extension=extname(name).toLowerCase();
    if(!FILE_FORMATS.includes(extension))fail(400,'UNSUPPORTED_FORMAT','支持TXT、Markdown、PDF和DOCX文件。');
    if(typeof body.mime!=='string'||![DOC_MIME[extension],'application/octet-stream',...(extension==='.md'?['text/plain']:[]),...(extension==='.docx'?['application/zip']:[])].includes(body.mime))fail(400,'INVALID_MIME','文件类型与名称不一致。');
    const bytes=decodeUpload(body.data,FILE_LIMIT),directory=await this.safeDirectory(['files']),id=randomUUID(),path=join(directory,id+extension);
    await writeFile(path,bytes,{flag:'wx',mode:0o600});
    const record={id,path,name,mime:DOC_MIME[extension],assistantId:scope.assistantId,ownerId:OWNER,size:bytes.length,sha256:hash(bytes),status:'parsing',createdAt:new Date().toISOString()};
    this.store.state.files.push(record);this.store.save();
    let result;try{result=await parseFile(this.store,await this.parserScope(scope),id,this.researchOptions);}catch{result={ok:false,error:{code:'PARSER_UNAVAILABLE',message:'文件解析环境当前不可用，请检查本机后台组件。'}};}
    if(!result.ok){record.status='error';record.error=result.error?.message||'文件解析失败。';this.store.save();return json({ok:false,error:record.error,code:result.error?.code||'FILE_PARSE_FAILED',item:publicFile(record)},422);}
    Object.assign(record,{status:'parsed',text:result.text,textPreview:result.text.slice(0,6000),truncated:result.truncated===true,parsedAt:new Date().toISOString()});this.store.save();
    return json({ok:true,item:publicFile(record)},201);
  }
  async uploadSticker(body){
    fields(body,['name','mime','data','assistantId','tags']);const scope=this.scope(body.assistantId),name=nameOf(body.name);
    if(!Object.hasOwn(IMAGE_EXT,body.mime))fail(400,'UNSUPPORTED_FORMAT','支持PNG、JPEG、GIF和WebP表情图片。');
    const bytes=decodeUpload(body.data,MEDIA_LIMITS.stickerBytes);if(!validStickerBytes(bytes,body.mime))fail(400,'INVALID_IMAGE','图片内容与类型不符，或尺寸/大小超出限制。');
    if(body.tags!==undefined&&(!Array.isArray(body.tags)||body.tags.length>10||body.tags.some(tag=>typeof tag!=='string'||!tag.trim()||tag.length>30)))fail(400,'INVALID_ARGUMENTS','表情标签最多10个，每个1到30字。');
    const directory=await this.safeDirectory(['media','stickers']),id=randomUUID(),path=join(directory,id+IMAGE_EXT[body.mime]);await writeFile(path,bytes,{flag:'wx',mode:0o600});
    const record={id,path,name,mime:body.mime,assistantId:scope.assistantId,ownerId:OWNER,size:bytes.length,sha256:hash(bytes),tags:[...new Set((body.tags||[]).map(tag=>tag.trim()))],createdAt:new Date().toISOString()};this.store.state.stickers.push(record);this.store.save();return json({ok:true,item:publicSticker(record)},201);
  }
  async deleteAsset(kind,id,assistantId){
    const scope=this.scope(assistantId);if(!UUID.test(id))fail(404,'NOT_FOUND','找不到这个资料。');
    const collection=kind==='files'?'files':'stickers',record=this.store.state[collection].find(item=>item.id===id&&item.assistantId===scope.assistantId&&item.ownerId===OWNER);
    if(!record)fail(404,'NOT_FOUND','找不到这个资料。');
    if(record.status==='parsing')fail(409,'ASSET_IN_USE','文件正在解析，请完成后再删除。');
    if(this.store.state.chats.some(chat=>inUse(chat,id)))fail(409,'ASSET_IN_USE','这份资料仍被会话或历史附件引用，暂时不能删除；已有聊天内容会保留。');
    const directory=await this.safeDirectory(collection==='files'?['files']:['media','stickers']),extension=extname(record.path||'').toLowerCase(),expected=join(directory,id+extension);
    if(resolve(record.path||'')!==expected||collection==='files'&&!FILE_FORMATS.includes(extension)||collection==='stickers'&&IMAGE_EXT[record.mime]!==extension)fail(409,'UNSAFE_STORAGE','资料存储位置异常，未删除文件。');
    try{const stat=await lstat(expected);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||await realpath(expected)!==expected)fail(409,'UNSAFE_STORAGE','资料存储位置异常，未删除文件。');await unlink(expected);}catch(error){if(error.code!=='ENOENT')throw error;}
    this.store.state[collection]=this.store.state[collection].filter(item=>item!==record);this.store.save();return json({ok:true});
  }
  async route({path,method='GET',body={},query}={}){
    try{
      if(path==='/api/extensions'&&method==='GET')return json({items:IDS.map(id=>this.card(id))});
      const extension=path?.match(/^\/api\/extensions\/(memory|reminders|voice|stickers|web|files)(?:\/(test))?$/);
      if(extension){const [,id,action]=extension;if(['memory','reminders'].includes(id))return null;if(method==='PATCH'&&!action)return await this.patch(id,body);if(method==='POST'&&action==='test'&&['voice','web'].includes(id))return await this.test(id,body);return null;}
      if(path==='/api/files'){
        if(method==='POST')return await this.uploadFile(body);
        if(method==='GET'){const scope=this.scope(queryValue(query,'assistantId'));return json({items:this.store.state.files.filter(item=>item.assistantId===scope.assistantId&&item.ownerId===OWNER).map(publicFile)});}
      }
      if(path==='/api/stickers/upload'&&method==='POST')return await this.uploadSticker(body);
      if(path==='/api/stickers'&&method==='GET'){const scope=this.scope(queryValue(query,'assistantId'));return json({items:this.store.state.stickers.filter(item=>item.assistantId===scope.assistantId&&item.ownerId===OWNER).map(publicSticker)});}
      const asset=path?.match(/^\/api\/(files|stickers)\/([^/]+)$/);
      if(asset){if(method==='DELETE')return await this.deleteAsset(asset[1],asset[2],queryValue(query,'assistantId'));if(method==='GET'&&asset[1]==='files'){const scope=this.scope(queryValue(query,'assistantId')),record=this.store.state.files.find(item=>item.id===asset[2]&&item.assistantId===scope.assistantId&&item.ownerId===OWNER);if(!record)fail(404,'NOT_FOUND','找不到这个资料。');return json({item:publicFile(record)});}}
      const media=path?.match(/^\/api\/media\/(audio|stickers)\/([^/]+)$/);
      if(media&&method==='GET'){
        const kind=media[1]==='audio'?'audio':'sticker',records=kind==='audio'?this.store.state.mediaAudio:this.store.state.stickers;
        const requested=queryValue(query,'assistantId'),record=records.find(item=>item.id===media[2]&&item.ownerId===OWNER),scope=this.scope(requested||record?.assistantId);
        const result=await readMediaAsset(this.store,scope,{kind,id:media[2]});if(!result.ok)fail(404,'NOT_FOUND',result.error.message);
        return {status:200,bytes:result.bytes,mime:result.mime,filename:media[2]+(kind==='audio'?'.wav':IMAGE_EXT[result.mime])};
      }
      return null;
    }catch(error){return json({ok:false,error:error.status?error.message:'扩展操作未完成，请检查配置或文件后重试。',code:error.code||'EXTENSION_UNAVAILABLE'},error.status||500);}
  }
}
