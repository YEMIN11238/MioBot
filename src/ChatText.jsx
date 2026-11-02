import React from 'react';
import {chatTextParts,referenceSources} from './chat-text.mjs';

export default function ChatText({text}){
  return <span className="chat-text">{chatTextParts(text).map((part,index)=>part.type==='link'?<a key={index} href={part.url} target="_blank" rel="noreferrer noopener">{part.text}</a>:<React.Fragment key={index}>{part.text}</React.Fragment>)}</span>;
}

export function ReferenceSources({sources}){
  const items=referenceSources(sources);if(!items.length)return null;
  return <details className="chat-reference-sources"><summary>参考来源 · {items.length}</summary><ol>{items.map(item=><li key={item.url}><a href={item.url} target="_blank" rel="noreferrer noopener">{item.title}</a></li>)}</ol></details>;
}
