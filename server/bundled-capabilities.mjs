export const BASE_SKILLS=Object.freeze(['memory','reminders','humanize','web']);

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>object(value)&&Object.hasOwn(value,key);
function validKey(value){return typeof value==='string'&&value.trim().length>0&&value.length<=2000&&!/[\x00-\x1f\x7f]/.test(value);}
function savedKey(store,id){
  const connections=store.secrets?.modelConnections;
  if(!own(connections,id))return undefined;
  const value=connections[id]?.key;
  // Match the actual search adapter's first nonempty saved key selection.
  return Array.isArray(value)?value.find(item=>typeof item==='string'&&item.trim()):value;
}
function officialConnection(store,id){
  if(typeof id!=='string'||!id||id.length>150)return null;
  const matches=(Array.isArray(store.state.modelConnections)?store.state.modelConnections:[]).filter(item=>object(item)&&item.id===id);
  if(matches.length!==1||typeof matches[0].apiBase!=='string'||!validKey(savedKey(store,id)))return null;
  try{
    const url=new URL(matches[0].apiBase);
    if(url.protocol!=='https:'||url.hostname!=='api.deepseek.com'||url.username||url.password||url.search||url.hash||url.port&&url.port!=='443')return null;
    return matches[0];
  }catch{return null;}
}
function searchConfiguration(store){
  const config=object(store.state.extensionConfig?.web)?store.state.extensionConfig.web:{};
  if(config.provider==='deepseek')return {provider:'deepseek',configured:!!officialConnection(store,config.connectionId),connectionId:typeof config.connectionId==='string'?config.connectionId:''};
  if(config.provider===undefined||config.provider==='tavily')return {provider:config.provider||null,configured:validKey(store.secrets?.extensions?.web?.key)};
  return {provider:null,configured:false};
}

/** Upgrade mandatory capabilities in memory only. The caller owns persistence. */
export function applyBundledCapabilities(store){
  if(!object(store?.state))throw new Error('基础能力需要有效的应用状态');
  const state=store.state;let changed=false;
  if(!object(state.extensions)){state.extensions={};changed=true;}
  for(const id of ['memory','reminders','web'])if(state.extensions[id]!==true){state.extensions[id]=true;changed=true;}
  for(const assistant of Array.isArray(state.assistants)?state.assistants:[]){
    if(!object(assistant))continue;
    const current=Array.isArray(assistant.skills)?assistant.skills:[],missing=BASE_SKILLS.filter(id=>!current.includes(id));
    if(!Array.isArray(assistant.skills)||missing.length){assistant.skills=[...current,...missing];changed=true;}
  }
  if(!object(state.extensionConfig)){state.extensionConfig={};changed=true;}
  const before=searchConfiguration(store),config=object(state.extensionConfig.web)?state.extensionConfig.web:{};
  let replacement;
  if(before.configured){
    // Existing valid user choices always win, even after changing chat defaults.
    if(!config.provider)replacement={provider:'tavily',maxResults:Number.isInteger(config.maxResults)&&config.maxResults>=1&&config.maxResults<=8?config.maxResults:5};
  }else{
    const preferred=officialConnection(store,state.settings?.defaultConnectionId);
    const first=preferred||(Array.isArray(state.modelConnections)?state.modelConnections:[]).map(item=>object(item)?officialConnection(store,item.id):null).find(Boolean);
    if(first)replacement={provider:'deepseek',connectionId:first.id,maxResults:Number.isInteger(config.maxResults)&&config.maxResults>=1&&config.maxResults<=8?config.maxResults:5};
  }
  if(replacement){state.extensionConfig.web=replacement;changed=true;}
  // Old test receipts must not appear to verify a different/newly missing service.
  if((replacement||!searchConfiguration(store).configured)&&own(state.extensionValidation,'web')){delete state.extensionValidation.web;changed=true;}
  return {changed};
}

/** No API call, key material, or runtime-ready flag can certify a search account. */
export function bundledCapabilityStatus(store,runtime){
  const runtimeReady=runtime?.status==='ready',search=searchConfiguration(store),storedTest=store.state.extensionValidation?.web;
  const lastTest=object(storedTest)&&['passed','failed'].includes(storedTest.status)?{status:storedTest.status,...(typeof storedTest.at==='string'&&Number.isFinite(Date.parse(storedTest.at))?{at:storedTest.at}:{})}:undefined;
  return {
    memory:{status:'ready',provider:'builtin',reason:'基础跨会话记忆已内置，无需额外向量服务；增强记忆沿用已有配置。',configurationStatus:'configured',verificationStatus:'not_applicable',runtimeReady},
    reminders:{status:'ready',provider:'builtin',reason:'一次性提醒已内置；需要后台持续运行，外部接收渠道仍需验证。',configurationStatus:'configured',verificationStatus:'not_applicable',runtimeReady},
    web:{status:search.configured?'configured':'needs_configuration',provider:search.provider,...(search.connectionId?{connectionId:search.connectionId}:{}),reason:search.configured?'搜索服务已配置；是否可用以实际搜索结果为准，配置不等于测试通过。':'网页检索已内置；请保存带密钥的官方DeepSeek连接，或在高级设置配置Tavily。',configurationStatus:search.configured?'configured':'needs_configuration',verificationStatus:'untested',tested:false,runtimeReady,...(lastTest?{lastTest}:{})},
  };
}
