import React,{useState} from 'react';
import {Globe,X} from 'lucide-react';
import {searchAvailabilityNotice} from './bundled-ui.mjs';

function wasSeen(key){try{return sessionStorage.getItem('miobot-search-notice:'+key)==='seen';}catch{return false;}}
export function SearchAvailabilityNotice({data,onConfigure}){
  const notice=searchAvailabilityNotice(data),[dismissed,setDismissed]=useState('');
  if(!notice||dismissed===notice.key||wasSeen(notice.key))return null;
  function dismiss(){try{sessionStorage.setItem('miobot-search-notice:'+notice.key,'seen');}catch{}setDismissed(notice.key);}
  return <div className="bundled-search-notice" role="status"><Globe size={16}/><p>{notice.text}</p><button type="button" onClick={onConfigure}>高级设置</button><button type="button" aria-label="知道了，不再提示此次搜索配置" onClick={dismiss}><X size={14}/></button></div>;
}
