/** Reduce delivery events without exposing unfinished provider output. */
export function applyChatStreamEvent(stream,event){
  if(!stream||stream.finished)return stream;
  if(event.type==='start')return {...stream,messageId:event.messageId||event.message?.id||stream.messageId,stage:'正在回复…'};
  if(event.type==='stage'&&typeof event.stage==='string')return {...stream,stage:event.stage};
  if(event.type==='delta'){
    if(stream.parts?.length)return stream;
    return {...stream,text:stream.text+String(event.text||event.data||'')};
  }
  if(event.type==='part'){
    const parts=stream.parts||[],index=event.index;
    if(!Number.isInteger(index)||index<0||index>parts.length||index>2||typeof event.text!=='string'||!event.text.trim())return stream;
    if(parts[index]===event.text)return stream;
    const next=[...parts];next[index]=event.text;
    return {...stream,parts:next,text:next.join('\n\n'),stage:'正在继续回复…',mode:'parts'};
  }
  if(['done','error','cancelled'].includes(event.type))return {...stream,finished:true};
  return stream;
}

/** A polling refresh can see the completed row before the stream closes. */
export function belongsToActiveStream(message,stream){
  return !!stream&&(stream.messageId?message.id===stream.messageId:message.status==='streaming');
}
