export const BUNDLED_CAPABILITY_IDS=['memory','reminders','web'];
export const OPTIONAL_SKILL_IDS=['voice','stickers','files','minecraft'];

export function bundledCapability(data,id){
  const value=data?.bundledCapabilities?.[id];
  if(!value||typeof value!=='object')return {status:'unknown',ready:false,label:id==='web'?'状态待确认':'已内置',reason:''};
  const ready=['ready','configured'].includes(value.status),verified=value.verificationStatus==='passed';
  return {...value,ready,verified,label:value.status==='configured'?(verified?'已验证':'已连接'):ready?'已就绪':value.status==='needs_configuration'?'需要配置':value.status==='error'?'暂不可用':'状态待确认',reason:typeof value.reason==='string'?value.reason:''};
}

export function searchAvailabilityNotice(data){
  const state=bundledCapability(data,'web');
  if(state.ready||state.status==='unknown')return null;
  const reason=state.reason||'当前账号还没有可用的网页搜索服务。';
  return {key:JSON.stringify([data?.instanceId||'local',state.status,state.provider||'',reason]),text:'网页搜索暂不可用：'+reason+' 普通聊天仍可继续。'};
}
