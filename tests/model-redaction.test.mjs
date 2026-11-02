import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Connections,splitConfig,STRUCTURAL_CONFIG_FIELDS} from '../server/connections.mjs';
import {AstrBot} from '../server/astrbot.mjs';

function withStore(run){
  const root=mkdtempSync(join(tmpdir(),'miobot-model-redaction-'));
  const store=new Store(root);
  return Promise.resolve().then(()=>run({root,store})).finally(()=>rmSync(root,{recursive:true,force:true}));
}

test('hidden protocol metadata remains public while hidden webhook IDs and real credentials stay private',()=>{
  const schema=Object.fromEntries([...STRUCTURAL_CONFIG_FIELDS].map(key=>[key,{type:'string',invisible:true}]));
  schema.webhook_uuid={type:'string',invisible:true};
  const config={provider:'deepseek',type:'openai_chat_completion',provider_type:'chat_completion',provider_source_id:'fixture-source',webhook_uuid:'fixture-private-webhook',key:['fixture-private-api-key'],custom_headers:{Authorization:'fixture-private-authorization'}};
  const result=splitConfig(config,schema);
  for(const field of STRUCTURAL_CONFIG_FIELDS){assert.equal(result.safe[field],config[field]);assert.ok(!(field in result.secrets));}
  assert.equal(result.secrets.webhook_uuid,'fixture-private-webhook');
  assert.deepEqual(result.secrets.key,['fixture-private-api-key']);
  assert.equal(result.secrets.custom_headers.Authorization,'fixture-private-authorization');
  assert.ok(!JSON.stringify(result.safe).includes('fixture-private-'));
});

test('legacy credential metadata does not mask model IDs but actual keys, tokens and custom headers are redacted',()=>withStore(({root,store})=>{
  store.setSecrets({runtimeToken:'runtime-secret',modelConnections:{legacy:{provider:'deepseek',type:'openai_chat_completion',provider_type:'chat_completion',provider_source_id:'fixture-source',key:['sk-fixture-secret'],token:'token-secret',custom_headers:{Authorization:'header-secret',type:'private-header-type'}}}});
  const runtime=new AstrBot({root,store,fetcher:async()=>{throw new Error('No network access in this test');}});
  const raw='Models: deepseek-v4-flash, deepseek-v4-pro; protocol openai_chat_completion. Key sk-fixture-secret; token token-secret; auth header-secret; custom type private-header-type; runtime runtime-secret.';
  const sanitized=runtime.safeError(new Error(raw));
  assert.ok(sanitized.includes('deepseek-v4-flash'));
  assert.ok(sanitized.includes('deepseek-v4-pro'));
  assert.ok(sanitized.includes('openai_chat_completion'));
  for(const secret of ['sk-fixture-secret','token-secret','header-secret','private-header-type','runtime-secret'])assert.ok(!sanitized.includes(secret),`${secret} must remain redacted`);
  assert.ok(sanitized.includes('[已隐藏]'));
}));

test('saving a legacy model removes misplaced protocol secrets, keeps a blank edited key, and preserves private headers',()=>withStore(async({root,store})=>{
  const original={id:'legacy-deepseek',name:'DeepSeek fixture',template:'deepseek',type:'openai_chat_completion',provider:'deepseek',apiBase:'https://fixture.invalid/v1',model:'v4.1 flash',config:{},validation:{status:'unavailable'}};
  store.state.modelConnections.push(original);
  store.state.settings.defaultConnectionId=original.id;
  store.setSecrets({modelConnections:{[original.id]:{provider:'deepseek',type:'openai_chat_completion',provider_type:'chat_completion',provider_source_id:'fixture-source',key:['fixture-saved-key'],custom_headers:{Authorization:'fixture-saved-header'}}}});
  store.save();
  const runtime=new AstrBot({root,store,fetcher:async()=>{throw new Error('Offline fixture uses bundled public schemas');}});
  const connections=new Connections(store,runtime);
  const saved=await connections.saveModel({model:'deepseek-v4-flash',key:''},original.id);
  assert.equal(saved.model,'deepseek-v4-flash');
  assert.equal(saved.hasKey,true);
  const secrets=store.secrets.modelConnections[original.id];
  for(const field of STRUCTURAL_CONFIG_FIELDS)assert.ok(!(field in secrets),`legacy ${field} must be removed`);
  assert.deepEqual(secrets.key,['fixture-saved-key']);
  assert.equal(secrets.custom_headers.Authorization,'fixture-saved-header');
  assert.equal(store.connection(original.id).config.provider,'deepseek');
  assert.equal(store.connection(original.id).config.type,'openai_chat_completion');
  const publicState=JSON.stringify(store.snapshot()),stateOnDisk=readFileSync(join(root,'state.json'),'utf8');
  for(const secret of ['fixture-saved-key','fixture-saved-header']){assert.ok(!publicState.includes(secret));assert.ok(!stateOnDisk.includes(secret));}
  const reloaded=new Store(root);
  assert.deepEqual(reloaded.secrets.modelConnections[original.id].key,['fixture-saved-key']);
  assert.ok(!('provider' in reloaded.secrets.modelConnections[original.id]));
}));
