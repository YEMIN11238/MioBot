import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {startServer} from '../server/index.mjs';import {Store} from '../server/store.mjs';

async function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'miobot-bundled-http-')),network=[];
  const store=new Store(root);for(const id of ['memory','reminders','web','workflows'])store.state.extensions[id]=false;
  store.state.tasks=[{id:'paused',assistantId:'daily',status:'paused',channel:'web',dueAt:new Date(Date.now()+86400000).toISOString(),logs:[]}];store.save();
  const app=await startServer({dataRoot:root,port:0,fetcher:async input=>{network.push(String(input));throw Error('fixture native engine is not started');}});
  t.after(async()=>{await app.close();rmSync(root,{recursive:true,force:true});});
  const api=async(path,method='GET',body)=>{const response=await fetch(app.url+'/api'+path,{method,headers:{'X-Personal-Agent':'1','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()};};return {app,api,network};
}

test('fresh and migrated HTTP instances keep base capabilities always available without restoring paused work',async t=>{
  const {app,api}=await fixture(t);const state=(await api('/state')).body;
  for(const assistant of state.assistants)for(const skill of ['memory','reminders','humanize','web','workflows'])assert.ok(assistant.skills.includes(skill));
  for(const id of ['memory','reminders','web','workflows']){assert.equal(state.extensions[id],true);assert.equal((await api('/extensions/'+id,'PATCH',{enabled:false})).status,409);}
  assert.equal(state.bundledCapabilities.web.status,'needs_configuration');assert.equal(state.bundledCapabilities.web.tested,false);
  const edited=await api('/assistants/game','PATCH',{skills:[]});assert.equal(edited.status,200);assert.deepEqual(new Set(edited.body.skills),new Set(['memory','reminders','humanize','web','workflows']));
  const created=await api('/assistants','POST',{name:'Fresh bot',skills:[],persona:'fixture persona'});assert.equal(created.status,201);assert.ok(created.body.skills.includes('web'));
  assert.equal(app.store.state.tasks[0].status,'paused');assert.equal(app.store.assistant('daily').care.enabled,false);
});

test('saving a single official model connection automatically configures search without sending its key back or calling search',async t=>{
  const {api,network}=await fixture(t);const saved=await api('/model-connections','POST',{name:'fixture official',template:'openai',type:'openai_chat_completion',provider:'openai',apiBase:'https://api.deepseek.com/v1',model:'fixture',key:'fixture-private-api-key'});assert.equal(saved.status,201);
  const state=(await api('/state')).body;assert.equal(state.extensionConfig.web.provider,'deepseek');assert.equal(state.extensionConfig.web.connectionId,saved.body.id);assert.equal(state.bundledCapabilities.web.status,'configured');assert.equal(state.bundledCapabilities.web.tested,false);assert.ok(!JSON.stringify(state).includes('fixture-private-api-key'));assert.ok(network.every(url=>new URL(url).hostname==='127.0.0.1'));
  const chat=(await api('/chats','POST',{assistantId:'daily'})).body;
  const memory=await api('/chats/'+chat.id+'/messages','POST',{text:'记住我们的跨会话暗号是紫云喝可乐'});assert.equal(memory.status,200);assert.equal(memory.body.text,'好，记住啦。');assert.equal((await api('/state')).body.memories.length,1);
});
