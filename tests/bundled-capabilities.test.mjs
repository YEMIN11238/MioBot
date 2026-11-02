import test from 'node:test';
import assert from 'node:assert/strict';
import {BASE_SKILLS,applyBundledCapabilities,bundledCapabilityStatus} from '../server/bundled-capabilities.mjs';

function fixture(){
  let saves=0;
  const store={state:{extensions:{memory:false,reminders:false,web:false,voice:false,stickers:true,files:false},settings:{defaultConnectionId:'preferred'},assistants:[{id:'daily',enabled:true,persona:'保留原人格',skills:['long_memory'],care:{enabled:false}},{id:'game',enabled:true,persona:'保留游戏人格',skills:['minecraft','voice','stickers']},{id:'career',enabled:false,persona:'保留未开启助手',skills:[]}],tasks:[{id:'paused',status:'paused'},{id:'cancelled',status:'cancelled'},{id:'overdue',status:'overdue'}],modelConnections:[],extensionConfig:{}},secrets:{modelConnections:{},extensions:{}},save(){saves++;}};
  function connection(id,apiBase='https://api.deepseek.com/v1',key='synthetic-secret-'+id){store.state.modelConnections.push({id,apiBase,model:'fixture-model',hasKey:true});store.secrets.modelConnections[id]={key:[key]};}
  return {store,connection,saves:()=>saves};
}

test('base capabilities are mandatory and idempotent without changing persona, enabled state, specialized skills, tasks or care',()=>{
  const {store,saves}=fixture(),before=structuredClone(store.state);
  assert.deepEqual(BASE_SKILLS,['memory','reminders','humanize','web']);assert.equal(Object.isFrozen(BASE_SKILLS),true);
  assert.deepEqual(applyBundledCapabilities(store),{changed:true});
  for(const assistant of store.state.assistants){for(const id of BASE_SKILLS)assert.ok(assistant.skills.includes(id));assert.equal(assistant.persona,before.assistants.find(a=>a.id===assistant.id).persona);}
  assert.deepEqual(store.state.assistants[1].skills,['minecraft','voice','stickers',...BASE_SKILLS]);
  assert.equal(store.state.assistants[2].enabled,false);
  assert.deepEqual(store.state.tasks,before.tasks);assert.deepEqual(store.state.assistants.map(a=>a.care),before.assistants.map(a=>a.care));
  assert.deepEqual(store.state.extensions,{memory:true,reminders:true,web:true,voice:false,stickers:true,files:false});
  assert.deepEqual(applyBundledCapabilities(store),{changed:false});assert.equal(saves(),0);
});

test('automatic search picks the valid saved official default before the first official alternative and stores no key',()=>{
  const {store,connection}=fixture();connection('first');connection('preferred');
  store.state.extensionValidation={web:{status:'passed',at:'2026-11-01T00:00:00Z'}};
  const secrets=JSON.stringify(store.secrets);
  applyBundledCapabilities(store);
  assert.deepEqual(store.state.extensionConfig.web,{provider:'deepseek',connectionId:'preferred',maxResults:5});
  assert.equal(store.state.extensionValidation.web,undefined);assert.equal(JSON.stringify(store.secrets),secrets);
  assert.equal(JSON.stringify(store.state).includes('synthetic-secret'),false);
  assert.deepEqual(applyBundledCapabilities(store),{changed:false});
});

test('invalid default falls back to the first usable official connection, never to a proxy or a stale hasKey flag',()=>{
  const {store,connection}=fixture();connection('preferred','https://third-party.example/v1');connection('empty');store.secrets.modelConnections.empty.key=[];
  connection('first-real','https://api.deepseek.com');connection('later-real');
  applyBundledCapabilities(store);assert.equal(store.state.extensionConfig.web.connectionId,'first-real');
});

test('valid explicit DeepSeek or Tavily choices survive default changes and preserve their configuration',()=>{
  for(const provider of ['deepseek','tavily']){
    const {store,connection}=fixture();connection('selected');connection('preferred');
    const config=provider==='deepseek'?{provider,connectionId:'selected',maxResults:3}:{provider,maxResults:8};
    store.state.extensionConfig.web=config;store.secrets.extensions.web={key:'synthetic-tavily-key'};
    store.state.extensionValidation={web:{status:'passed',at:'2026-11-01T00:00:00Z'}};
    applyBundledCapabilities(store);assert.equal(store.state.extensionConfig.web,config);assert.equal(store.state.extensionValidation.web.status,'passed');
    store.state.settings.defaultConnectionId='preferred';assert.deepEqual(applyBundledCapabilities(store),{changed:false});assert.equal(store.state.extensionConfig.web,config);
  }
});

test('an existing independent Tavily key without legacy configuration is retained without copying or changing secrets',()=>{
  const {store,connection}=fixture();delete store.state.extensionConfig;store.secrets.extensions.web={key:'synthetic-tavily-key'};connection('preferred');
  const secrets=JSON.stringify(store.secrets);applyBundledCapabilities(store);
  assert.deepEqual(store.state.extensionConfig.web,{provider:'tavily',maxResults:5});assert.equal(JSON.stringify(store.secrets),secrets);
  assert.deepEqual(applyBundledCapabilities(store),{changed:false});
});

test('legacy missing configuration and credentials still enable the base skills but truthfully require search configuration',()=>{
  const store={state:{assistants:[{id:'legacy'}]}};
  assert.deepEqual(applyBundledCapabilities(store),{changed:true});assert.equal(store.secrets,undefined);
  assert.deepEqual(store.state.assistants[0].skills,[...BASE_SKILLS]);assert.equal(store.state.extensions.web,true);
  const status=bundledCapabilityStatus(store,{status:'ready'});assert.equal(status.web.status,'needs_configuration');assert.equal(status.web.tested,false);
  assert.equal(status.web.runtimeReady,true);assert.deepEqual(applyBundledCapabilities(store),{changed:false});
});

test('malformed URLs, unofficial hosts, credentials in URLs and malformed keys never auto-configure DeepSeek',()=>{
  for(const apiBase of ['not a URL','http://api.deepseek.com/v1','https://api.deepseek.com.evil.example/v1','https://user@api.deepseek.com/v1','https://api.deepseek.com:8443/v1','https://api.deepseek.com/v1?token=synthetic','https://api.deepseek.com/v1#fragment','https://api.deepseek.com./v1']){
    const {store,connection}=fixture();connection('preferred',apiBase);applyBundledCapabilities(store);assert.equal(bundledCapabilityStatus(store).web.status,'needs_configuration',apiBase);assert.equal(store.state.extensionConfig.web,undefined);
  }
  for(const key of ['', '   ', 'unsafe\ncredential', 'x'.repeat(2001), {not:'a string'}]){
    const {store,connection}=fixture();connection('preferred');store.secrets.modelConnections.preferred.key=[key];applyBundledCapabilities(store);assert.equal(bundledCapabilityStatus(store).web.status,'needs_configuration');
  }
});

test('revoking a saved key clears stale success evidence or rebinds to a remaining eligible official connection',()=>{
  const {store,connection}=fixture();connection('preferred');applyBundledCapabilities(store);
  store.state.extensionValidation={web:{status:'passed'}};store.secrets.modelConnections.preferred.key=[];
  assert.deepEqual(applyBundledCapabilities(store),{changed:true});assert.equal(bundledCapabilityStatus(store,{status:'ready'}).web.status,'needs_configuration');assert.equal(store.state.extensionValidation.web,undefined);
  connection('replacement');applyBundledCapabilities(store);assert.equal(store.state.extensionConfig.web.connectionId,'replacement');assert.equal(bundledCapabilityStatus(store).web.status,'configured');
});

test('configured accounts and a ready runtime are distinct from actual API verification and status never exposes keys',()=>{
  const {store,connection}=fixture();connection('preferred');applyBundledCapabilities(store);
  store.state.extensionValidation={web:{status:'passed',at:'2026-11-02T00:00:00Z',error:'synthetic-secret-preferred'}};
  const state=JSON.stringify(store.state),status=bundledCapabilityStatus(store,{status:'ready'});
  assert.equal(status.memory.status,'ready');assert.equal(status.reminders.status,'ready');assert.equal(status.web.status,'configured');
  assert.equal(status.web.configurationStatus,'configured');assert.equal(status.web.verificationStatus,'untested');assert.equal(status.web.tested,false);
  assert.deepEqual(status.web.lastTest,{status:'passed',at:'2026-11-02T00:00:00Z'});assert.equal(status.web.runtimeReady,true);
  assert.equal(JSON.stringify(status).includes('synthetic-secret'),false);assert.equal(JSON.stringify(store.state),state);
  assert.equal(bundledCapabilityStatus(store,{status:'stopped'}).web.runtimeReady,false);
});

test('ambiguous connection IDs and inherited credential properties cannot supply an automatic account',()=>{
  const {store,connection}=fixture();connection('preferred');store.state.modelConnections.push({...store.state.modelConnections[0]});
  applyBundledCapabilities(store);assert.equal(bundledCapabilityStatus(store).web.status,'needs_configuration');
  store.state.modelConnections.pop();store.secrets.modelConnections=Object.create({preferred:{key:['synthetic-inherited-key']}});
  applyBundledCapabilities(store);assert.equal(bundledCapabilityStatus(store).web.status,'needs_configuration');
});
