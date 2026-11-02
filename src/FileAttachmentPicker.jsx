import React,{useEffect,useState} from 'react';
import {FileText,LoaderCircle,Plus,RefreshCw,Trash2,Upload} from 'lucide-react';
import {extensionItems,extensionRequest,uploadBody} from './extensions-api.mjs';
import {PrivateMedia} from './ExtensionMedia.jsx';

/** Both libraries are private to the selected assistant. */
export function AssistantLibrary({assistantId,kind='files',onError,onNotice,selectable=false,selectedIds=[],onSelect,onDelete,allowUpload=true}){
  const [items,setItems]=useState([]),[selected,setSelected]=useState(selectedIds),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState(null);
  const stickers=kind==='stickers',collection=stickers?'/stickers':'/files';
  async function load(signal){const value=await extensionRequest(collection+'?assistantId='+encodeURIComponent(assistantId),'GET',undefined,signal);if(!signal?.aborted)setItems(extensionItems(value));return value;}
  useEffect(()=>{const controller=new AbortController();setItems([]);setSelected(selectedIds);setPreview(null);setError('');setBusy(true);load(controller.signal).catch(err=>{if(err.name!=='AbortError')setError(err.message);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();},[assistantId,kind]);
  async function upload(event){
    const file=event.target.files?.[0];event.target.value='';if(!file)return;setBusy(true);setError('');
    try{const body=await uploadBody(file,{assistantId,limitMiB:stickers?5:10});const result=await extensionRequest(stickers?'/stickers/upload':'/files','POST',body);await load();onNotice?.(stickers?'已加入当前助手的私有图库':'文件已上传，解析结果已更新');if(!stickers&&(result.status==='parsed'||result.item?.status==='parsed'))setPreview(result.item||result);}
    catch(err){setError(err.message);onError?.(err.message);}finally{setBusy(false);}
  }
  async function remove(item){
    if(!window.confirm(stickers?'从当前助手的私有图库删除这张表情？':'删除当前助手的这份文件？已有聊天中引用的历史内容仍会保留。'))return;
    setBusy(true);setError('');try{await extensionRequest(collection+'/'+encodeURIComponent(item.id)+'?assistantId='+encodeURIComponent(assistantId),'DELETE');setSelected(current=>current.filter(id=>id!==item.id));if(preview?.id===item.id)setPreview(null);await load();onDelete?.(item.id);onNotice?.('已删除');}catch(err){setError(err.message);onError?.(err.message);}finally{setBusy(false);}
  }
  async function showPreview(item){
    if(item.preview||item.textPreview){setPreview(item);return;}
    setBusy(true);setError('');try{const value=await extensionRequest('/files/'+encodeURIComponent(item.id)+'?assistantId='+encodeURIComponent(assistantId));setPreview(value.item||value);}catch(err){setError(err.message);onError?.(err.message);}finally{setBusy(false);}
  }
  function choose(item,checked){setError('');if(checked&&stickers){setSelected([item.id]);return;}if(checked&&selected.length>=5){setError('一次最多选择 5 个附件。');return;}setSelected(current=>checked?[...current,item.id]:current.filter(id=>id!==item.id));}
  return <section className={'assistant-library '+(stickers?'is-stickers':'')} aria-label={stickers?'当前助手的私有图库':'当前助手的文件库'}><div className="assistant-library-toolbar"><label className={'extension-upload '+(!allowUpload?'is-disabled':'')}><Upload size={15}/>{stickers?'上传表情':'上传文件'}<input type="file" aria-label={stickers?'上传当前助手的表情':'上传当前助手的文件'} accept={stickers?'image/png,image/jpeg,image/gif,image/webp':'.txt,.md,.pdf,.docx'} disabled={busy||!allowUpload||!assistantId} onChange={upload}/></label><button type="button" className="cs-button is-secondary" disabled={busy||!assistantId} onClick={async()=>{setBusy(true);setError('');try{await load();}catch(err){setError(err.message);}finally{setBusy(false);}}}><RefreshCw size={14}/>刷新</button></div><p className="extension-small">{stickers?'仅保存你手动上传的 PNG、JPG、GIF 或 WebP，每张最大 5 MiB。不会自动收集聊天图片。':'支持 TXT、Markdown、PDF、DOCX，每份最大 10 MiB。文件只属于当前助手，解析成功后才可附到消息。'}</p>{busy&&<p className="extension-small"><LoaderCircle size={14} className="spin"/>处理中…</p>}{error&&<p role="alert" className="extension-error">{error}</p>}<div className="assistant-library-items">{items.map(item=><article key={item.id} className={selected.includes(item.id)?'is-selected':''}>{selectable&&<input type="checkbox" aria-label={'选择'+item.name} checked={selected.includes(item.id)} disabled={busy||!stickers&&item.status!=='parsed'} onChange={event=>choose(item,event.target.checked)}/>}{stickers?<div className="assistant-library-image"><PrivateMedia url={item.url} mime={item.mime} name={item.name}/></div>:<span className="assistant-library-file-icon"><FileText size={23}/></span>}<div className="assistant-library-item-copy"><strong>{item.name}</strong>{!stickers&&<small>{item.status==='parsed'?'已解析':item.status==='error'?'解析失败':'处理中'}</small>}{item.error&&<small role="alert">{item.error}</small>}{!stickers&&item.status==='parsed'&&<button type="button" disabled={busy} onClick={()=>showPreview(item)}>查看解析预览</button>}</div><button type="button" className="icon-button" aria-label={'删除'+item.name} disabled={busy} onClick={()=>remove(item)}><Trash2 size={15}/></button></article>)}</div>{!busy&&!items.length&&<p className="extension-small">{stickers?'还没有上传表情。':'当前助手还没有文件。'}</p>}{preview&&<details className="extension-file-preview" open><summary>{preview.name} · 解析预览</summary><pre>{preview.preview||preview.textPreview||'当前文件未返回预览文本。'}</pre></details>}{selectable&&<div className="assistant-library-selection"><span>已选 {selected.length} 项</span><button type="button" className="cs-button" disabled={busy||!selected.length} onClick={()=>onSelect?.(items.filter(item=>selected.includes(item.id)))}><Plus size={15}/>添加到消息</button></div>}</section>;
}

export default function FileAttachmentPicker(props){return <AssistantLibrary {...props} selectable/>;}
