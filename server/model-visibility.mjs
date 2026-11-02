/** Provider control is separate from the chat UI's reasoning-display flag. */
export function applyManagedModelVisibility(connection,source){
  const out=structuredClone(source);
  let url;try{url=new URL(connection.apiBase);}catch{return out;}
  if(connection.type==='openai_chat_completion'&&url.protocol==='https:'&&url.hostname==='api.deepseek.com'&&!url.username&&!url.password){
    const extra=out.custom_extra_body&&typeof out.custom_extra_body==='object'&&!Array.isArray(out.custom_extra_body)?out.custom_extra_body:{};
    out.custom_extra_body={...extra,thinking:{...(extra.thinking&&typeof extra.thinking==='object'&&!Array.isArray(extra.thinking)?extra.thinking:{}),type:'disabled'}};
  }
  return out;
}
