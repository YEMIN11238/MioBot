import React,{useEffect,useState} from 'react';
import {privateMediaURL} from './extensions-api.mjs';

/** Private media is fetched with application authentication before being shown. */
export function PrivateMedia({url,mime,name='',audio=false}){
  const [source,setSource]=useState(''),[error,setError]=useState('');
  useEffect(()=>{
    setSource('');setError('');if(!url)return;
    const controller=new AbortController();let objectURL='';
    const mediaURL=privateMediaURL(url);if(!mediaURL){setError('媒体地址不可用。');return;}
    fetch(mediaURL,{headers:{'X-Personal-Agent':'1'},signal:controller.signal}).then(async response=>{
      if(!response.ok)throw new Error('媒体暂时无法读取。');const blob=await response.blob();
      if(controller.signal.aborted)return;objectURL=URL.createObjectURL(blob.type?blob:new Blob([blob],{type:mime||'application/octet-stream'}));setSource(objectURL);
    }).catch(err=>{if(err.name!=='AbortError')setError(err.message);});
    return()=>{controller.abort();if(objectURL)URL.revokeObjectURL(objectURL);};
  },[url,mime]);
  if(error)return <small className="extension-media-error" role="alert">{error}</small>;
  if(!source)return <small className="extension-media-loading">读取媒体…</small>;
  return audio?<audio controls preload="metadata" src={source} aria-label={name||'语音回复'}/>:<img src={source} alt={name||'私有表情'} loading="lazy"/>;
}

export default function MessageAttachments({message}){
  const attachments=message.attachments||{},audio=Array.isArray(attachments.audio)?attachments.audio:[],stickers=Array.isArray(attachments.stickers)?attachments.stickers:[],files=Array.isArray(attachments.files)?attachments.files:[];
  if(!audio.length&&!stickers.length&&!files.length)return null;
  return <div className="message-attachments">{files.map(file=><span className="message-file-tag" key={file.id}>{file.name||'已附文件'}{file.status==='parsed'?' · 已解析':''}</span>)}{stickers.map(item=><div className="message-sticker" key={item.id||item.url}><PrivateMedia url={item.url} mime={item.mime} name={item.name}/></div>)}{audio.map(item=><div className="message-audio" key={item.id||item.url}><PrivateMedia url={item.url} mime={item.mime} name={item.name} audio/></div>)}</div>;
}
