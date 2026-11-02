// Real pinned native plugin HTTP boundary, isolated temporary data, no model.
import {mkdtempSync,mkdirSync,cpSync,readFileSync,readdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {Store} from '../../server/store.mjs';
import {AstrBot} from '../../server/astrbot.mjs';
import {proactiveDeliveryKey} from '../../integrations/proactive/policy.mjs';

const root=resolve(import.meta.dirname,'../..'),data=mkdtempSync(join(tmpdir(),'miobot-native-proactive-'));
const picker=createServer();await new Promise(r=>picker.listen(0,'127.0.0.1',r));const port=picker.address().port;await new Promise(r=>picker.close(r));
const plugin='astrbot_plugin_miobot_proactive',source=join(root,'integrations/proactive',plugin),target=join(data,'astrbot/data/plugins',plugin);
const fingerprint=directory=>{const hash=createHash('sha256');function visit(dir,prefix=''){for(const item of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(item.name==='__pycache__'||item.name.endsWith('.pyc')||item.name==='.miobot-bundle.json')continue;const path=join(dir,item.name),name=prefix+item.name;if(item.isDirectory())visit(path,name+'/');else if(item.isFile()){hash.update(name+'\0');hash.update(readFileSync(path));}}}visit(directory);return hash.digest('hex');};
mkdirSync(target,{recursive:true});cpSync(source,target,{recursive:true,filter:path=>!path.includes('__pycache__')&&!path.endsWith('.pyc')});writeFileSync(join(target,'.miobot-bundle.json'),JSON.stringify({bundleId:plugin,version:'0.1.0',fingerprint:fingerprint(source)}));
mkdirSync(join(data,'astrbot/data'),{recursive:true});cpSync(join(root,'.runtime/native-runtime/astrbot/astrbot/dashboard/dist'),join(data,'astrbot/data/dist'),{recursive:true});
const store=new Store(data);store.state.settings={...store.state.settings,runtimeUrl:`http://127.0.0.1:${port}`,location:'local'};store.save();
process.env.MIOBOT_MANAGED_PROACTIVE='1';const runtime=new AstrBot({root,store});
const payload={scope:{instanceId:'fixture',assistantId:'companion',userId:'owner',sessionId:'fixture-chat',channelId:'web'},care:{enabled:true,idleMinutes:120,quietStart:23,quietEnd:8,maxPerDay:1},now:'2026-11-02T12:00:00+08:00',lastUserAt:'2026-11-02T08:00:00+08:00',sentToday:0,messages:[{role:'user',text:'今天有点累。'}]};
try{
  await runtime.start();const listed=await runtime.request('/plugins');assert.ok(listed.some(p=>p.name===plugin&&p.activated));
  const status=await runtime.request(`/plugins/extensions/${plugin}/status`);assert.equal(status.ready,true);assert.equal(status.scheduler,'miobot-service-only');assert.equal(status.telemetry,false);
  const allowed=await runtime.request(`/plugins/extensions/${plugin}/policy`,{method:'POST',body:payload});assert.equal(allowed.allowed,true);assert.match(allowed.prompt,/会话场景：私聊/);assert.match(allowed.prompt,/2026年11月02日 周一 12:00/);assert.equal(allowed.scopeKey,proactiveDeliveryKey(payload.scope));
  const quiet=await runtime.request(`/plugins/extensions/${plugin}/policy`,{method:'POST',body:{...payload,now:'2026-11-02T23:00:00+08:00'}});assert.equal(quiet.allowed,false);assert.equal(quiet.reason,'quiet_hours');assert.equal(quiet.prompt,undefined);
  const unanswered=await runtime.request(`/plugins/extensions/${plugin}/policy`,{method:'POST',body:{...payload,lastCareAt:'2026-11-02T10:00:00+08:00'}});assert.equal(unanswered.allowed,false);assert.equal(unanswered.reason,'awaiting_user_reply');
  await assert.rejects(()=>runtime.request(`/plugins/extensions/${plugin}/policy`,{method:'POST',body:{...payload,scope:{...payload.scope,userId:''}}}),/标识无效/);
  const unauth=await fetch(runtime.base()+`/api/v1/plugins/extensions/${plugin}/policy`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.ok([401,403].includes(unauth.status));
  console.log(JSON.stringify({success:true,engine:'AstrBot4.29.3',plugin,statusReady:true,actualUpstreamCore:true,authenticatedNativeHTTP:true,invalidScopeRefused:true,quietAndUnansweredBlocked:true,scopeKeyMatchesNode:true,paidRequests:0,outboundMessages:0,nativeSchedulerStarted:false},null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
finally{const child=runtime.child;runtime.stop();if(child&&child.exitCode===null)await new Promise(r=>{const timer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');r();},5000);child.once('exit',()=>{clearTimeout(timer);r();});});rmSync(data,{recursive:true,force:true});}
