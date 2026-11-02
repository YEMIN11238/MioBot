import {createHash} from 'node:crypto';

export const PROACTIVE_SOURCE={repo:'https://github.com/Pancakes-Labs/astrbot_plugin_proactive_chat',revision:'635fc18eeb84e3c7b58661425359244552286835',version:'v1.2.6',integration:'miobot-policy-v1'};

/** Detect only explicit changes to unsolicited care, never ordinary reminders. */
export function careInstruction(value){
  if(typeof value!=='string'||value.length>2000)return null;
  const text=value.trim().replace(/[。！!，,\s]+$/u,'');
  if(!text||/[“「『"].*[”」』"]/u.test(text))return null;
  // A polite request to stop is still an explicit revocation of consent.
  const directStop=text.replace(/^(?:你)?(?:能不能|可不可以|能否)\s*/u,'').replace(/[?？]$/u,'');
  if(/^(?:(?:请|以后|现在|先|暂时|你)\s*)*(?:别|不要|不用再|停止|关闭|关掉)(?:(?:再|来|主动|偶尔|给我|跟我)\s*)*(?:打扰(?:我)?|找我(?:聊天|说话)?|叫我|发消息|主动(?:关心|聊天|消息)(?:我)?)(?:了|啦|吧|哈|谢谢)?$/u.test(directStop))return {action:'disable',enabled:false,source:'explicit_user_instruction'};
  if(/[?？]$|(?:什么|怎么|为什么|是不是|能不能|会不会|可以吗|的吗|什么意思)/u.test(text))return null;
  const pieces=text.split(/[，,。！!；;\n]/u).map(x=>x.trim()).filter(Boolean);
  let action=null;
  for(const piece of pieces){
    if(/^(?:(?:请|以后|现在|先|暂时|接下来|今天|今晚|你|还是)\s*)*(?:别|不要|不用再|停止|关闭|关掉)(?:(?:再|来|主动|偶尔|给我|跟我|找我|的|这个|消息|聊天|关心)\s*)*(?:打扰(?:我)?|找我(?:聊天|说话)?|叫我|发消息|主动(?:关心|聊天|消息)(?:我)?)(?:了|啦|吧|哈|谢谢)?$/u.test(piece))action='disable';
    if(/^(?:(?:请|以后|现在|从现在开始|你|还是|可以|允许|帮我)\s*)*(?:(?:偶尔|主动|有空时|有空的时候)\s*)+(?:(?:来)?找我(?:聊聊天|聊天|说话)?|叫叫我|叫我|关心(?:一下)?我|和我聊聊)(?:吧|哈|了|哦|就行|就好|即可)?$/u.test(piece)||/^(?:请|帮我|现在)?(?:开启|打开|恢复)(?:主动关心|主动聊天|主动消息|偶尔关心)(?:吧|了)?$/u.test(piece))action='enable';
  }
  return action?{action,enabled:action==='enable',source:'explicit_user_instruction'}:null;
}

/** Shared algorithm with the native adapter. No fallback scope is permitted. */
export function proactiveDeliveryKey(scope){
  const keys=['instanceId','assistantId','userId','sessionId','channelId'];
  if(!scope||keys.some(k=>typeof scope[k]!=='string'||!scope[k].trim()||scope[k].length>500))throw new Error('主动关心缺少明确的助手、用户或接收会话');
  return 'miobot-proactive:v1:'+createHash('sha256').update(JSON.stringify(keys.map(k=>scope[k]))).digest('hex');
}
