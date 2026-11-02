import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,templates} from '../server/store.mjs';
import {startServer,projectRoot} from '../server/index.mjs';
import {nativeFixture} from './helpers/native-fixture.mjs';

const temp = label => mkdtempSync(join(tmpdir(),'pa-'+label+'-'));
async function withApp(run,{prepare}={}){
  const dataRoot=temp('connections'),fixture=nativeFixture();
  prepare?.(dataRoot);
  const app=await startServer({root:projectRoot,dataRoot,port:0,fetcher:fixture.fetcher});
  const raw=(path,method='GET',body)=>fetch(app.url+'/api'+path,{method,headers:{'X-Personal-Agent':'1','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const request=async(...args)=>{const r=await raw(...args);return {status:r.status,body:await r.json()};};
  try{await run({app,fixture,request,raw,dataRoot});}finally{await app.close();rmSync(dataRoot,{recursive:true,force:true});}
}
const model=(name,key,extra={})=>({name,template:'openai',type:'openai_chat_completion',provider:'openai',apiBase:'https://fixture.invalid/v1',model:'fixture-'+name,key,...extra});
async function events(response){assert.equal(response.status,200);const raw=await response.text();return raw.split('\n').filter(x=>x.startsWith('data:')).map(x=>JSON.parse(x.slice(5).trim()));}

test('schema-1 migration preserves existing content and moves the legacy key into isolated model credentials',()=>{
  const root=temp('migration');
  try{
    const old={schema:1,instanceId:'old-instance',assistants:structuredClone(templates),chats:[{id:'legacy-chat',assistantId:'daily',nativeSession:'original-session',messages:[{id:'original-message',role:'user',text:'retain this conversation'}]}],memories:[{id:'legacy-memory',assistantId:'daily',content:'retain this memory',shared:false}],tasks:[],notifications:[],extensions:{memory:true,reminders:true},settings:{location:'local',runtimeUrl:'http://127.0.0.1:26185',modelBase:'https://fixture.invalid/v1',model:'legacy-model'}};
    writeFileSync(join(root,'state.json'),JSON.stringify(old));writeFileSync(join(root,'credentials.json'),JSON.stringify({modelKey:'legacy-fixture-secret',runtimeToken:'fixture-runtime-secret'}));
    const store=new Store(root),snapshot=store.snapshot();
    assert.ok(store.state.schema>=2);assert.equal(snapshot.instanceId,'old-instance');
    assert.deepEqual(snapshot.chats,old.chats);assert.deepEqual(snapshot.memories,old.memories);
    assert.equal(snapshot.modelConnections.length,1);
    const connection=snapshot.modelConnections[0];assert.equal(connection.model,'legacy-model');assert.equal(connection.hasKey,true);
    assert.equal(snapshot.settings.defaultConnectionId,connection.id);
    assert.ok(!JSON.stringify(snapshot).includes('legacy-fixture-secret'));assert.ok(!JSON.stringify(snapshot).includes('fixture-runtime-secret'));
    const disk=readFileSync(join(root,'state.json'),'utf8');assert.ok(!disk.includes('legacy-fixture-secret'));
    assert.equal(new Store(root).state.modelConnections.length,1,'migration must be idempotent');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('an unconfigured schema-1 installation starts with no ghost model and can configure its first real connection',async()=>withApp(async({app,request})=>{
  let snapshot=(await request('/state')).body;
  assert.equal(snapshot.schema,2);assert.deepEqual(snapshot.modelConnections,[]);assert.ok(!snapshot.settings.defaultConnectionId);
  assert.equal(new Store(app.store.root).state.modelConnections.length,0,'reloading a blank migration must remain blank');
  const created=await request('/model-connections','POST',model('first-real','fixture-first-real-key'));
  assert.equal(created.status,201);snapshot=(await request('/state')).body;
  assert.equal(snapshot.modelConnections.length,1);assert.equal(snapshot.settings.defaultConnectionId,created.body.id);
  assert.notEqual(created.body.id,'default-model');assert.equal(snapshot.modelConnections[0].hasKey,true);
},{prepare:root=>writeFileSync(join(root,'state.json'),JSON.stringify({schema:1,instanceId:'blank-legacy',assistants:structuredClone(templates),chats:[],memories:[],tasks:[],notifications:[],extensions:{memory:true,reminders:true},settings:{location:'local',runtimeUrl:'http://127.0.0.1:26185',modelBase:'https://api.deepseek.com/v1',model:'deepseek-chat'}}))}));

test('multiple connections keep credentials separate and require actual model validation',async()=>withApp(async({app,fixture,request,dataRoot})=>{
  const first=await request('/model-connections','POST',model('one','fixture-secret-one',{config:{custom_headers:{Authorization:'fixture-nested-header-secret'}}}));
  const second=await request('/model-connections','POST',model('two','fixture-secret-two',{type:'googlegenai_chat_completion',provider:'google',template:'google_gemini'}));
  assert.equal(first.status,201);assert.equal(second.status,201);assert.notEqual(first.body.id,second.body.id);
  let snapshot=(await request('/state')).body;
  assert.equal(snapshot.modelConnections.length,2);assert.equal(snapshot.modelConnections[0].validation.status,'untested');
  assert.ok(!JSON.stringify(snapshot).includes('fixture-secret-one'));assert.ok(!JSON.stringify(snapshot).includes('fixture-secret-two'));
  assert.ok(!JSON.stringify(snapshot).includes('fixture-nested-header-secret'),'custom authorization headers are credentials too');
  assert.ok(!readFileSync(join(dataRoot,'state.json'),'utf8').includes('fixture-secret-'));
  const testResult=await request('/model-connections/'+first.body.id+'/test','POST');assert.equal(testResult.status,200);
  snapshot=(await request('/state')).body;assert.equal(snapshot.modelConnections.find(x=>x.id===first.body.id).validation.status,'available');
  assert.equal(snapshot.modelConnections.find(x=>x.id===second.body.id).validation.status,'untested');
  fixture.controls.testStatus='unavailable';fixture.controls.testError='fixture rejected fixture-secret-two';await request('/model-connections/'+second.body.id+'/test','POST');
  snapshot=(await request('/state')).body;assert.equal(snapshot.modelConnections.find(x=>x.id===second.body.id).validation.status,'unavailable');
  assert.equal(snapshot.modelConnections.find(x=>x.id===first.body.id).validation.status,'available');
  assert.ok(!JSON.stringify(snapshot).includes('fixture-secret-two'),'provider error messages must be redacted before persistence');
  assert.ok(fixture.calls.some(c=>c.path==='/providers/test'),'validation must reach the native test endpoint');
  await request('/model-connections/'+first.body.id,'PATCH',{name:'one renamed',key:''});
  assert.equal((await request('/state')).body.modelConnections.find(x=>x.id===first.body.id).hasKey,true,'blank edit must not erase a saved key');
}));

test('assistant and chat model selection route independently; memory edits retain the same native session',async()=>withApp(async({app,fixture,request,raw})=>{
  const a=(await request('/model-connections','POST',model('a','fixture-key-a'))).body;
  const b=(await request('/model-connections','POST',model('b','fixture-key-b'))).body;
  assert.equal((await request('/assistants/daily','PATCH',{defaultConnectionId:a.id})).status,200);
  assert.equal((await request('/assistants/game','PATCH',{defaultConnectionId:b.id})).status,200);
  const daily=(await request('/chats','POST',{assistantId:'daily'})).body;
  const game=(await request('/chats','POST',{assistantId:'game'})).body;
  const first=await events(await raw('/chats/'+daily.id+'/messages/stream','POST',{text:'first turn',requestId:'fixture-request-1'}));
  assert.ok(first.some(e=>e.type==='part'&&e.text));assert.ok(!first.some(e=>e.type==='delta'),'humanized replies expose reviewed parts, not raw model deltas');assert.equal(first.at(-1).type,'done');
  const session=app.store.chat(daily.id).nativeSession;
  const memory=(await request('/memories','POST',{assistantId:'daily',content:'prefer short answers'})).body;
  await request('/memories/'+memory.id,'PATCH',{content:'prefer detailed answers'});
  assert.equal(app.store.chat(daily.id).nativeSession,session);
  await events(await raw('/chats/'+daily.id+'/messages/stream','POST',{text:'second turn',requestId:'fixture-request-2'}));
  await events(await raw('/chats/'+game.id+'/messages/stream','POST',{text:'game turn',requestId:'fixture-request-3'}));
  const nativeChats=fixture.calls.filter(c=>c.path==='/chat');
  assert.equal(nativeChats[0].body.flags.enable_reasoning,false);assert.equal(nativeChats[0].body.enable_reasoning,false);
  assert.equal(nativeChats[0].body.selected_model,'fixture-a');assert.equal(nativeChats[1].body.session_id,nativeChats[0].body.session_id);
  assert.equal(nativeChats[2].body.selected_model,'fixture-b');assert.notEqual(nativeChats[0].body.selected_provider,nativeChats[2].body.selected_provider);
  assert.ok([...fixture.personas.values()].some(p=>p.system_prompt.includes('prefer detailed answers')));
  await request('/chats/'+daily.id,'PATCH',{connectionId:b.id});
  await events(await raw('/chats/'+daily.id+'/messages/stream','POST',{text:'override turn',requestId:'fixture-request-4'}));
  assert.equal(fixture.calls.filter(c=>c.path==='/chat').at(-1).body.selected_model,'fixture-b');
  assert.equal(app.store.assistant('daily').defaultConnectionId,a.id,'chat override must not rewrite the assistant default');
}));

test('failed streamed replies retry without duplicating the user message',async()=>withApp(async({app,fixture,request,raw})=>{
  const connection=(await request('/model-connections','POST',model('retry','fixture-retry-key'))).body;
  await request('/assistants/daily','PATCH',{defaultConnectionId:connection.id});
  const chat=(await request('/chats','POST',{assistantId:'daily'})).body;
  fixture.controls.failChat=true;
  const failed=await events(await raw('/chats/'+chat.id+'/messages/stream','POST',{text:'please retry this',requestId:'fixture-failed-request'}));
  assert.equal(failed.at(-1).type,'error');
  assert.equal(app.store.chat(chat.id).messages.filter(m=>m.role==='user').length,1);
  fixture.controls.failChat=false;
  const retried=await events(await raw('/chats/'+chat.id+'/retry/stream','POST',{requestId:'fixture-retry-request'}));
  assert.equal(retried.at(-1).type,'done');assert.equal(app.store.chat(chat.id).messages.filter(m=>m.role==='user').length,1);
  const disallowed=await raw('/chats/'+chat.id+'/retry/stream','POST',{requestId:'fixture-extra-retry'});
  if(disallowed.headers.get('Content-Type')?.includes('event-stream'))assert.equal((await events(disallowed)).at(-1).type,'error');else assert.equal(disallowed.status,400);
  assert.equal(app.store.chat(chat.id).messages.filter(m=>m.role==='user').length,1);
}));

test('stopping an in-flight reply ends the stream and allows a single retry',async()=>withApp(async({app,fixture,request,raw})=>{
  const connection=(await request('/model-connections','POST',model('cancel','fixture-cancel-key'))).body;
  await request('/assistants/daily','PATCH',{defaultConnectionId:connection.id});
  const chat=(await request('/chats','POST',{assistantId:'daily'})).body;
  fixture.controls.delay=150;
  const response=await raw('/chats/'+chat.id+'/messages/stream','POST',{text:'stop this response',requestId:'fixture-cancel-request'});
  const deadline=Date.now()+2000;
  while(!fixture.calls.some(c=>c.path==='/chat')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.ok(fixture.calls.some(c=>c.path==='/chat'),'the model request must be in flight before cancellation');
  assert.equal((await request('/chats/'+chat.id+'/cancel','POST')).status,200);
  const stopped=await events(response);assert.equal(stopped.at(-1).type,'cancelled');
  assert.ok(fixture.calls.some(c=>/^\/chat\/sessions\/[^/]+\/stop$/.test(c.path)),'cancellation must also reach the native engine');
  assert.equal(app.store.chat(chat.id).messages.filter(m=>m.role==='user').length,1);
  fixture.controls.delay=0;
  const retry=await events(await raw('/chats/'+chat.id+'/retry/stream','POST',{requestId:'fixture-after-cancel'}));
  assert.equal(retry.at(-1).type,'done');assert.equal(app.store.chat(chat.id).messages.filter(m=>m.role==='user').length,1);
}));

test('stopping between paced parts persists only the text already shown',async()=>withApp(async({app,fixture,request,raw})=>{
  const connection=(await request('/model-connections','POST',model('paced-cancel','fixture-paced-key'))).body;
  await request('/assistants/daily','PATCH',{defaultConnectionId:connection.id});
  const chat=(await request('/chats','POST',{assistantId:'daily'})).body;
  fixture.controls.responseText='我在呢\n这句应当还没有出现\n这句也不该提前保存';
  const response=await raw('/chats/'+chat.id+'/messages/stream','POST',{text:'测试分条停止',requestId:'paced-cancel'});
  const reader=response.body.getReader(),decoder=new TextDecoder();let content='';
  while(!content.includes('"type":"part"')){const chunk=await reader.read();assert.ok(!chunk.done);content+=decoder.decode(chunk.value,{stream:true});}
  assert.equal(app.store.chat(chat.id).messages.at(-1).text,'我在呢');
  assert.equal((await request('/chats/'+chat.id+'/cancel','POST')).status,200);
  while(true){const chunk=await reader.read();if(chunk.done)break;content+=decoder.decode(chunk.value,{stream:true});}
  const rows=content.split('\n').filter(x=>x.startsWith('data:')).map(x=>JSON.parse(x.slice(5)));
  assert.equal(rows.filter(e=>e.type==='part').length,1);assert.equal(rows.at(-1).type,'cancelled');
  const saved=app.store.chat(chat.id).messages.at(-1);assert.equal(saved.status,'cancelled');assert.equal(saved.text,'我在呢');assert.deepEqual(saved.parts,['我在呢']);
}));

test('saved or sent channels are never claimed received until explicit acknowledgement',async()=>withApp(async({app,fixture,request})=>{
  const catalog=await request('/catalog/channels');assert.equal(catalog.status,200);assert.ok(catalog.body.types.some(t=>t.type==='telegram'));
  const connection=(await request('/model-connections','POST',model('channel','fixture-channel-model-key'))).body;
  await request('/assistants/daily','PATCH',{defaultConnectionId:connection.id});
  const created=await request('/channels','POST',{name:'fixture telegram',type:'telegram',config:{token:'fixture-channel-token'},assistantId:'daily',target:'telegram:FriendMessage:12345',enabled:false});
  assert.equal(created.status,201);const id=created.body.id;
  let snapshot=(await request('/state')).body;let channel=snapshot.channels.find(c=>c.id===id);
  assert.notEqual(channel.status,'verified');assert.ok(!JSON.stringify(snapshot).includes('fixture-channel-token'));
  assert.ok((await request('/channels/'+id+'/confirm-received','POST')).status>=400,'a channel cannot be acknowledged before any test was sent');
  assert.equal((await request('/channels/'+id+'/test-send','POST')).status,400,'disabled channels cannot send');
  await request('/channels/'+id,'PATCH',{enabled:true});
  const connect=await request('/channels/'+id+'/connect','POST');assert.equal(connect.status,200);
  snapshot=(await request('/state')).body;assert.notEqual(snapshot.channels.find(c=>c.id===id).status,'verified');
  await request('/channels/'+id+'/test-send','POST');
  snapshot=(await request('/state')).body;channel=snapshot.channels.find(c=>c.id===id);assert.equal(channel.status,'sent');assert.ok(channel.lastSentAt);assert.ok(!channel.verifiedAt);
  assert.ok(fixture.calls.some(c=>c.path==='/im/messages'));
  const confirmed=await request('/channels/'+id+'/confirm-received','POST');assert.equal(confirmed.status,200);
  snapshot=(await request('/state')).body;assert.equal(snapshot.channels.find(c=>c.id===id).status,'verified');
  fixture.controls.sendFails=true;const failed=await request('/channels/'+id+'/test-send','POST');assert.ok(failed.status>=400);
  assert.notEqual((await request('/state')).body.channels.find(c=>c.id===id).status,'sent','failed adapter send must not retain a success state for this attempt');
  const passive=(await request('/channels','POST',{name:'passive fixture',type:'fixture-passive',config:{password:'fixture-passive-secret'},assistantId:'daily',target:'fixture-passive:FriendMessage:12345'})).body;
  const sendCount=fixture.calls.filter(c=>c.path==='/im/messages').length;
  assert.ok((await request('/channels/'+passive.id+'/test-send','POST')).status>=400,'passive adapters do not support proactive tests');
  assert.equal(fixture.calls.filter(c=>c.path==='/im/messages').length,sendCount);
}));

test('targetless channels bind all incoming sessions; later edits sync their model and persona without losing saved changes on failure',async()=>withApp(async({app,fixture,request})=>{
  const a=(await request('/model-connections','POST',model('bound-a','fixture-bound-a'))).body;
  const b=(await request('/model-connections','POST',model('bound-b','fixture-bound-b'))).body;
  const created=await request('/channels','POST',{name:'incoming fixture',type:'telegram',config:{token:'fixture-incoming-token'},assistantId:'daily',target:'',enabled:true});
  assert.equal(created.status,201);const id=created.body.id;
  assert.equal((await request('/channels/'+id+'/connect','POST')).status,200);
  const channel=app.store.channel(id),wildcard=channel.nativeId+'::';
  const boundProfile=()=>fixture.profiles.get(fixture.routes.get(wildcard));
  assert.ok(fixture.routes.has(wildcard),'no outgoing target is needed to bind incoming chats');
  assert.equal(boundProfile().config.agent_runner.config.model.provider_id,app.runtime.connectionIds(a).providerId);
  const stale=channel.nativeId+':FriendMessage:obsolete';fixture.routes.set(stale,fixture.routes.get(wildcard));
  await request('/channels/'+id+'/connect','POST');assert.ok(!fixture.routes.has(stale),'old exact routes must not shadow the assistant-wide route');
  const memory=await request('/memories','POST',{assistantId:'daily',content:'original bound memory'});assert.equal(memory.status,201);
  const updated=await request('/memories/'+memory.body.id,'PATCH',{content:'updated bound memory'});assert.deepEqual(updated.body.syncWarnings,[]);
  assert.ok([...fixture.personas.values()].some(p=>p.system_prompt.includes('updated bound memory')));
  const setting=await request('/settings','PATCH',{defaultConnectionId:b.id});assert.deepEqual(setting.body.syncWarnings,[]);
  assert.equal(boundProfile().config.agent_runner.config.model.provider_id,app.runtime.connectionIds(b).providerId,'global default changes should reach an inheriting channel');
  const assistant=await request('/assistants/daily','PATCH',{defaultConnectionId:a.id,persona:'updated assistant personality'});assert.deepEqual(assistant.body.syncWarnings,[]);
  assert.equal(boundProfile().config.agent_runner.config.model.provider_id,app.runtime.connectionIds(a).providerId);
  assert.ok([...fixture.personas.values()].some(p=>p.system_prompt.includes('updated assistant personality')));
  const edited=await request('/model-connections/'+a.id,'PATCH',{model:'fixture-bound-a-revised'});assert.deepEqual(edited.body.syncWarnings,[]);
  assert.ok([...fixture.providers.values()].some(p=>p.model==='fixture-bound-a-revised'),'editing a bound connection must update its native provider');
  fixture.controls.syncFails=true;
  const failedSync=await request('/memories/'+memory.body.id,'PATCH',{content:'saved while runtime is unavailable'});
  assert.equal(failedSync.status,200);assert.equal(failedSync.body.syncWarnings.length,1);
  const snapshot=(await request('/state')).body;
  assert.equal(snapshot.memories.find(m=>m.id===memory.body.id).content,'saved while runtime is unavailable');
  assert.equal(snapshot.channels.find(c=>c.id===id).status,'error');assert.match(snapshot.channels.find(c=>c.id===id).lastError,/同步失败/);
  assert.equal(new Store(app.store.root).state.memories.find(m=>m.id===memory.body.id).content,'saved while runtime is unavailable','a failed remote sync must not lose the successful local save');
  fixture.controls.syncFails=false;
  assert.equal((await request('/channels/'+id+'/connect','POST')).status,200);
  assert.ok([...fixture.personas.values()].some(p=>p.system_prompt.includes('saved while runtime is unavailable')));
}));
