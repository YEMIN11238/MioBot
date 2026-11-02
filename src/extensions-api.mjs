import {productText} from '../shared/product-text.mjs';

export async function extensionRequest(path,method='GET',body,signal){
  const response=await fetch('/api'+path,{method,headers:{'X-Personal-Agent':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),...(signal?{signal}:{})});
  const value=await response.json().catch(()=>({error:'扩展服务没有返回有效结果。'}));
  if(!response.ok)throw new Error(productText(value.error||'操作没有完成，请重试。'));
  return value;
}

export const extensionItems=value=>Array.isArray(value)?value:Array.isArray(value?.items)?value.items:[];
export const extensionStateLabel=item=>!item?'正在检查':item.installed!==true?'安装状态待确认':item.status==='error'?'配置异常':!item.enabled?'已内置 · 未启用':({ready:'已启用 · 已就绪',needs_configuration:'已启用 · 待配置',disabled:'已内置 · 未启用'}[item.status]||'已内置 · 待检查');
export const extensionUsable=(items,assistant,id)=>items.some(item=>item.id===id&&item.installed===true&&item.enabled===true&&item.status==='ready')&&assistant?.skills?.includes(id)===true;
export const officialDeepSeekConnections=items=>(Array.isArray(items)?items:[]).filter(item=>{try{const url=new URL(item.apiBase);return url.protocol==='https:'&&url.hostname==='api.deepseek.com'&&!url.username&&!url.password;}catch{return false;}});
export const sourceURL=value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.href:'';}catch{return '';}};
export const privateMediaURL=value=>{try{if(typeof value!=='string'||!value.startsWith('/api/media/'))return '';const url=new URL(value,'https://miobot.invalid');return url.origin==='https://miobot.invalid'&&/^\/api\/media\/(audio|stickers)\/[^/]+$/.test(url.pathname)?url.pathname+url.search:'';}catch{return '';}};

export async function uploadBody(file,{assistantId,limitMiB=10}={}){
  if(!file||file.size<1)throw new Error('请选择非空文件。');
  if(file.size>limitMiB*1024*1024)throw new Error('单个文件最大 '+limitMiB+' MiB。');
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('文件读取失败，请重新选择。'));reader.readAsDataURL(file);});
  const suffix=file.name.toLowerCase().split('.').at(-1),mime=file.type||({txt:'text/plain',md:'text/markdown',pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'}[suffix])||'application/octet-stream';
  return {name:file.name,mime,data,assistantId};
}
