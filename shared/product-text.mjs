const extensionNames={
  astrbot_plugin_wanna_be_human:'聊天拟人增强',
  astrbot_plugin_dafeiyu_clean:'回复清理',
  astrbot_plugin_livingmemory:'长期记忆',
  astrbot_plugin_miobot_games:'我的世界资料',
};

/** Presentation copy only. Never apply this to protocol values or user content. */
export function productText(value){
  if(typeof value!=='string')return value;
  let text=value;
  for(const [id,label] of Object.entries(extensionNames))text=text.split(id).join(label);
  return text.replace(/(?<![\w./-])AstrBot(?![\w./-])/gi,'MioBot');
}

/** Rebrand only known upstream defaults, before saved user configuration merges. */
export function productTemplateDefaults(config){
  const next=structuredClone(config);
  if(next.start_message==="Hello, I'm AstrBot!")next.start_message="Hello, I'm MioBot!";
  if(next.custom_headers?.['X-Title']==='AstrBot')next.custom_headers['X-Title']='MioBot';
  return next;
}
