const normalized=value=>String(value||'').trim().replace(/\/+$/,'');
export function cloudDraftError(url,token,deployment={}){
  let parsed;
  try{parsed=new URL(String(url||'').trim());}catch{return '请填写完整的云端服务地址。';}
  const local=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);
  if(parsed.protocol!=='https:'&&!(local&&parsed.protocol==='http:'))return '云端连接需要 HTTPS 地址。';
  if(parsed.username||parsed.password||parsed.search||parsed.hash)return '服务地址中不能包含账号、密码、查询参数或锚点。';
  const saved=deployment.cloud?.paired&&normalized(url)===normalized(deployment.cloud.url);
  if(!String(token||'').trim()&&!saved)return '首次连接或更换服务器时，请填写连接密钥。';
  return '';
}

export function careDeliveryChannels(channels=[],assistantId){
  return channels.filter(channel=>channel.assistantId===assistantId&&channel.enabled&&channel.supportProactive&&channel.status==='verified');
}
