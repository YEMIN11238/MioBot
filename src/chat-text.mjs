import {sourceURL} from './extensions-api.mjs';

// This intentionally handles links only. Code remains verbatim text.
const codePattern=/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g;
const linkPattern=/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|https?:\/\/[^\s<>"'`]+/gi;

function trimURL(value){
  let result=value.replace(/[.,!?;:，。！？；：、]+$/g,'');
  for(const [open,close] of [['(',')'],['[',']'],['{','}']])while(result.endsWith(close)&&result.split(close).length>result.split(open).length)result=result.slice(0,-1);
  return result;
}

function links(text){
  const parts=[];let cursor=0;
  for(const match of text.matchAll(linkPattern)){
    if(match.index>cursor)parts.push({type:'text',text:text.slice(cursor,match.index)});
    const candidate=match[2]||trimURL(match[0]),url=sourceURL(candidate);
    if(url){parts.push({type:'link',text:match[1]||candidate,url});if(!match[2]&&candidate.length<match[0].length)parts.push({type:'text',text:match[0].slice(candidate.length)});}
    else parts.push({type:'text',text:match[0]});
    cursor=match.index+match[0].length;
  }
  if(cursor<text.length)parts.push({type:'text',text:text.slice(cursor)});
  return parts;
}

export function chatTextParts(value){
  const text=typeof value==='string'?value:String(value??''),parts=[];let cursor=0;
  for(const match of text.matchAll(codePattern)){
    if(match.index>cursor)parts.push(...links(text.slice(cursor,match.index)));
    parts.push({type:'code',text:match[0]});cursor=match.index+match[0].length;
  }
  if(cursor<text.length)parts.push(...links(text.slice(cursor)));
  return parts;
}

export function referenceSources(value){
  const sources=[],seen=new Set();
  for(const item of Array.isArray(value)?value:[]){
    if(!item||typeof item!=='object')continue;
    const url=sourceURL(item.url);if(!url||seen.has(url))continue;
    seen.add(url);sources.push({url,title:typeof item.title==='string'&&item.title.trim()?item.title.trim():new URL(url).hostname,retrievedAt:typeof item.retrievedAt==='string'?item.retrievedAt:''});
    if(sources.length===10)break;
  }
  return sources;
}
