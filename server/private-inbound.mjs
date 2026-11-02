import {randomUUID} from 'node:crypto';

// AstrBot 4.29.3 MessageSession: platform_meta.id:message_type:session_id.
// aiocqhttp, qq_official and telegram private adapters use sender ID as session.
// Discord instead uses the DM channel ID; no sender binding can be inferred.
const SUPPORTED=new Set(['aiocqhttp','qq_official','telegram']);
const OWNER='local-user';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
function identity(value,label,max=512){
  if(typeof value!=='string'||!value||value.length>max||value.trim()!==value||/[\u0000-\u001f\u007f]/.test(value))fail('INVALID_PRIVATE_EVENT',label+'无效');
  return value;
}

/**
 * Record only a host-authenticated native private event. The caller must verify
 * the internal bridge token before calling; this function does not accept model
 * supplied assistant, recipient, timestamp or owner overrides.
 *
 * Mapping follows AstrBot.syncChannel/sendChannel exactly: sendChannel replaces
 * target's first component with its stored managed nativeId. Only its canonical
 * adapter name or exact nativeId is accepted as that target component here.
 */
export function recordPrivateInbound(store,payload,{now=Date.now()}={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('INVALID_PRIVATE_EVENT','私聊事件无效');
  const platform=identity(payload.platform,'平台',60);
  if(platform==='discord')fail('PRIVATE_SENDER_BINDING_REQUIRED','Discord 私聊使用独立会话编号，尚未完成发送者绑定，不能安全接通此能力。');
  if(!SUPPORTED.has(platform))fail('UNSUPPORTED_PRIVATE_PLATFORM','这个平台尚未接通经过验证的私人助手私聊。');
  const umo=identity(payload.umo,'原生会话',1024),sessionId=identity(payload.sessionId,'私聊会话编号'),senderId=identity(payload.senderId,'发送者编号'),messageId=identity(payload.messageId,'原生消息编号');
  if(typeof payload.userText!=='string'||!payload.userText.trim()||payload.userText.length>16000)fail('INVALID_PRIVATE_EVENT','私聊消息应为不超过16000字的非空原文');
  const pieces=umo.split(':');
  if(pieces.length!==3||pieces[1]!=='FriendMessage'||pieces[2]!==sessionId||sessionId!==senderId)fail('PRIVATE_SESSION_MISMATCH','只能使用当前发送者本人经过验证的原生私聊会话。');
  const nativeId=pieces[0];
  const matching=(store.state.channels||[]).filter(channel=>{
    if(channel.type!==platform||channel.nativeId!==nativeId||channel.nativeId!==`pa-${store.state.instanceId}-${channel.id}`)return false;
    if(channel.enabled!==true||channel.supportProactive!==true||channel.status!=='verified'||!Number.isFinite(Date.parse(channel.verifiedAt)))return false;
    if(channel.ownerId!==undefined&&channel.ownerId!==OWNER)return false;
    if(typeof channel.target!=='string')return false;
    const target=channel.target.split(':');
    return target.length===3&&[platform,nativeId].includes(target[0])&&target[1]==='FriendMessage'&&target[2]===senderId;
  });
  if(matching.length!==1)fail(matching.length?'AMBIGUOUS_PRIVATE_CHANNEL':'PRIVATE_CHANNEL_NOT_VERIFIED',matching.length?'私聊匹配了多个渠道，请先修正绑定。':'没有找到属于这个发送者且已经验证的私聊渠道。');
  const channel=matching[0],assistant=store.state.assistants.find(item=>item.id===channel.assistantId);
  if(!assistant||assistant.enabled!==true)fail('PRIVATE_ASSISTANT_DISABLED','这个私聊绑定的助手不存在或尚未启用。');
  const candidates=store.state.chats.filter(chat=>chat.origin==='channel'&&chat.channelId===channel.id&&chat.nativeUmo===umo&&chat.assistantId===assistant.id);
  if(candidates.length>1||candidates.some(chat=>chat.ownerId!==OWNER||chat.nativeSenderId!==senderId||chat.nativePlatform!==platform))fail('PRIVATE_CHAT_BINDING_MISMATCH','私聊记录绑定存在冲突，不能沿用其他身份的聊天。');
  let chat=candidates[0];
  if(chat){
    const previous=chat.messages.filter(message=>message.role==='user'&&message.nativeMessageId===messageId);
    if(previous.length>1)fail('DUPLICATE_PRIVATE_MESSAGE','原生消息编号重复，请检查私聊记录。');
    if(previous.length){
      if(previous[0].text!==payload.userText)fail('PRIVATE_MESSAGE_ID_CONFLICT','相同原生消息编号对应的内容不一致，已拒绝改写。');
      return {chat,user:previous[0],channel,assistant};
    }
  }
  const at=new Date(now).toISOString(),fresh=!chat;
  if(fresh){
    chat={id:randomUUID(),assistantId:assistant.id,ownerId:OWNER,origin:'channel',channelId:channel.id,nativeUmo:umo,nativeSenderId:senderId,nativePlatform:platform,title:String(channel.name||'私人助手').slice(0,60)+' · 私聊',createdAt:at,messages:[],runStatus:'idle'};
    store.state.chats.unshift(chat);
  }
  const user={id:randomUUID(),role:'user',text:payload.userText,status:'complete',source:'channel',ownerId:OWNER,nativeMessageId:messageId,createdAt:at};
  chat.messages.push(user);
  try{store.save();}catch(error){
    chat.messages.pop();if(fresh)store.state.chats.splice(store.state.chats.indexOf(chat),1);
    throw error;
  }
  return {chat,user,channel,assistant};
}
