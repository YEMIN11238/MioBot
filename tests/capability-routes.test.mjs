import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {startServer} from '../server/index.mjs';

async function fixture(run){
  const data=mkdtempSync(join(tmpdir(),'miobot-capability-routes-'));
  const app=await startServer({root:resolve(import.meta.dirname,'..'),dataRoot:data,port:0});
  const request=async(path,body={})=>{const r=await fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Personal-Agent':'1'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
  try{await run(app,request);}finally{await app.close();rmSync(data,{recursive:true,force:true});}
}
const gameTools=['miobot_mc_item','miobot_mc_recipe','miobot_mc_guide'];
const memoryTools=['recall_long_term_memory','memorize_long_term_memory'];

test('readiness checks real registration and embedding availability rather than saved capability switches',async()=>fixture(async(app,request)=>{
  let embeddingCalls=0;
  app.store.state.capabilities.memory={status:'configured',embeddingProviderId:'fixture-vector'};
  app.runtime.authenticate=async()=>{};
  app.runtime.request=async path=>{if(path==='/tools')return [...gameTools,...memoryTools].map(name=>({name,active:true}));if(path==='/providers/test'){embeddingCalls++;return {status:'available'};}throw Error(path);};
  const ready=await request('/api/capabilities/verify');assert.equal(ready.status,200);assert.equal(ready.value.game.status,'ready');assert.equal(ready.value.memory.status,'ready');assert.equal(embeddingCalls,1);
  app.runtime.request=async path=>{if(path==='/tools')return gameTools.map(name=>({name,active:true}));throw Error('embedding must not be called without a registered memory tool');};
  const missing=await request('/api/capabilities/verify');assert.equal(missing.value.game.status,'ready');assert.equal(missing.value.memory.status,'error');assert.match(missing.value.memory.error,/记忆插件/);assert.equal(embeddingCalls,1);
}));

test('an unavailable vector model does not claim long-term memory ready or disable independent game queries',async()=>fixture(async(app,request)=>{
  app.store.state.capabilities.memory={status:'configured',embeddingProviderId:'fixture-vector'};
  app.runtime.authenticate=async()=>{};
  app.runtime.request=async path=>path==='/tools'?[...gameTools,...memoryTools].map(name=>({name,active:true})):{status:'unavailable',error:'fixture: embedding unsupported'};
  const {value}=await request('/api/capabilities/verify');assert.equal(value.memory.status,'error');assert.match(value.memory.error,/embedding unsupported/);assert.equal(value.game.status,'ready');
}));

test('internal game bridge rejects missing tokens, cross-site calls and inactive sessions without producing a tool trace',async()=>fixture(async app=>{
  const url=app.url+'/internal/game-tools',token=app.runtime.toolBridge.token;
  for(const headers of [{},{'X-MioBot-Tool-Token':token,Origin:app.url},{'X-MioBot-Tool-Token':token}]){
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({sessionId:'unrelated-session',name:'recipe_lookup',args:{query:'箱子'}})});assert.equal(r.status,403);
  }
  assert.equal(app.store.state.capabilities.game.lastRun,undefined);
}));
