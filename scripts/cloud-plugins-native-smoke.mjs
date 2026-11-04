// Real pinned engine, isolated data, no model, QQ account or paid request.
import {createServer} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {AstrBot} from '../server/astrbot.mjs';
import {CLOUD_PLUGINS} from '../server/cloud-plugin-bundles.mjs';

const root=resolve(import.meta.dirname,'..'),data=mkdtempSync(join(tmpdir(),'miobot-nine-native-'));
const picker=createServer();await new Promise(r=>picker.listen(0,'127.0.0.1',r));const port=picker.address().port;await new Promise(r=>picker.close(r));
const store=new Store(data);store.state.settings.runtimeUrl='http://127.0.0.1:'+port;
store.state.channels=[{id:'fixture-qq',type:'aiocqhttp',assistantId:'daily',enabled:true,status:'verified',target:'fixture:FriendMessage:10001'}];
store.state.cloudPlugins=Object.fromEntries(CLOUD_PLUGINS.map(p=>[p.id,{enabled:true,channelId:'fixture-qq',config:{}}]));store.save();
mkdirSync(join(data,'astrbot/data'),{recursive:true});writeFileSync(join(data,'astrbot/data/cmd_config.json'),JSON.stringify({disable_metrics:true,platform:[]}));
const runtime=new AstrBot({root,store});let report;
try{
  await runtime.start();const list=await runtime.request('/plugins'),plugins=Array.isArray(list)?list:list.plugins||[];
  const result=CLOUD_PLUGINS.map(p=>({id:p.id,activated:plugins.find(i=>i.name===p.id)?.activated===true,version:plugins.find(i=>i.name===p.id)?.version||''}));
  const errors=result.filter(p=>!p.activated);if(errors.length){const log=readFileSync(join(data,'logs/astrbot.log'),'utf8');const lines=log.split('\n').filter(s=>/ERROR|Error|failed|Failed|not found|ModuleNotFound/.test(s));console.error(lines.slice(-45).join('\n'));}
  assert.deepEqual(errors,[],'all nine enabled bundles must load in the same actual engine');
  const raw=await runtime.request('/tools'),tools=Array.isArray(raw)?raw:raw.tools||[],names=new Set(tools.map(t=>t.name));
  for(const item of CLOUD_PLUGINS)for(const tool of item.tools)assert.ok(names.has(tool),tool+' must be registered');
  assert.equal((await runtime.request('/bots')).bots.length,0,'no real or synthetic QQ bot connection is started');
  report={success:true,plugins:result,tools:CLOUD_PLUGINS.flatMap(p=>p.tools),actualEngine:true,realAccounts:0,modelRequests:0,paidCalls:0};console.log(JSON.stringify(report,null,2));
}catch(e){report={success:false,error:e.message,actualEngine:true,realAccounts:0,modelRequests:0,paidCalls:0};process.exitCode=1;console.error(e.message);}
finally{
  const child=runtime.child;runtime.stop();if(child&&child.exitCode===null)await new Promise(r=>{const timer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');r()},5000);child.once('exit',()=>{clearTimeout(timer);r()})});
  rmSync(data,{recursive:true,force:true});report.temporaryDataRemoved=!existsSync(data);const dir=join(root,'artifacts/cloud-plugin-parity-20261104');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'native-bundle-load.json'),JSON.stringify(report,null,2)+'\n');
}
