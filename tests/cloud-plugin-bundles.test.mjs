import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store} from '../server/store.mjs';
import {CloudPluginBundles,CLOUD_PLUGINS,stageCloudPluginBundles,cloudPluginNativeCapabilities} from '../server/cloud-plugin-bundles.mjs';
import {startServer} from '../server/index.mjs';
import {AstrBot} from '../server/astrbot.mjs';
import {Connections} from '../server/connections.mjs';

const root=resolve(import.meta.dirname,'..'),VOICE='astrbot_plugin_seed_audio_tts',MEME='meme_manager';
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'miobot-cloud-bundles-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new Store(dir);store.state.channels=[{id:'qq-fixture',type:'aiocqhttp',assistantId:'daily',enabled:true,status:'verified',target:'fixture:FriendMessage:10001'}];
  const runtime={status:'stopped',child:null,busy:new Set(),safeError:e=>String(e.message).replaceAll('synthetic-service-secret','[hidden]'),async request(){return []},async start(){this.status='ready';this.child={}},stop(){this.child=null;this.status='stopped'},async syncChannel(){}};
  const manager=new CloudPluginBundles({root,store,runtime});return {dir,store,runtime,manager};
}

test('all nine deployed-source bundles are included, off by default, with no private sample or old accounts',async t=>{
  const {manager,store}=fixture(t),{items}=await manager.list();assert.equal(items.length,9);assert.equal(CLOUD_PLUGINS.length,9);
  for(const item of items){assert.equal(item.present,true,item.id);assert.equal(item.enabled,false);assert.equal(item.status,'bundled');assert.equal(item.verification,'not_tested');assert.ok(existsSync(join(root,'integrations/cloud-plugins',item.id,'LICENSE')));}
  assert.equal(store.state.cloudPlugins,undefined);
  assert.equal(existsSync(join(root,'integrations/cloud-plugins/astrbot_plugin_dafeiyu_sing/sing_server/voice/prompt.wav')),false);
  assert.equal(items.find(i=>i.id==='astrbot_plugin_qzone').config.trigger.read_prob,0);
  assert.equal(items.find(i=>i.id==='astrbot_plugin_qqprofile').config.sync_name,false);
  assert.equal(items.find(i=>i.id===MEME).config.auto_collect.enabled,false);
});

test('inline and separate provider credentials are never returned by state or component metadata',async t=>{
  const {manager,store}=fixture(t),secret='synthetic-service-secret';
  await manager.patch(MEME,{enabled:false,config:{storage:{providers:{stardots:{key:secret}}}}});
  assert.equal(store.secrets.cloudPlugins[MEME]['storage.providers.stardots.key'],secret);
  assert.equal(JSON.stringify(store.state).includes(secret),false);assert.equal(JSON.stringify(await manager.list()).includes(secret),false);
  await manager.patch(VOICE,{enabled:false,secrets:{app_id:secret,access_key:secret}});
  const item=(await manager.list()).items.find(i=>i.id===VOICE);assert.ok(item.secretFields.find(f=>f.path==='app_id').saved);assert.equal(item.config.app_id,'');
  assert.equal(JSON.stringify(store.snapshot()).includes(secret),false);assert.equal(readFileSync(store.file,'utf8').includes(secret),false);
});

test('every bundled default configuration can be saved, including percentage-based probabilities',async t=>{
  const {manager}=fixture(t),{items}=await manager.list();for(const item of items)await manager.patch(item.id,{enabled:false,config:item.config});
  const meme=(await manager.list()).items.find(p=>p.id===MEME);assert.equal(meme.config.auto_collect.enabled,false);
});

test('invalid schema fields, enum, retry and probability values are rejected without saving',async t=>{
  const {manager,store}=fixture(t),before=JSON.stringify(store.state);
  for(const config of [{unknown:true},{reply_mode:'invented'},{reply_probability:-1},{reply_probability:2},{reply_probability:'0.5'}])await assert.rejects(manager.patch(VOICE,{config}));
  await assert.rejects(manager.patch('astrbot_plugin_dafeiyu_sing',{config:{doubao_tries:1e9}}),/重试/);
  await assert.rejects(manager.patch(MEME,{config:{webui:{preview_concurrency:100}}}),/范围/);
  await assert.rejects(manager.patch(VOICE,{secrets:{unlisted:'bad'}}),/凭据/);assert.equal(JSON.stringify(store.state),before);
});

test('unverified or nonprivate channels cannot enable plugins, and dependencies must use the same channel',async t=>{
  const {manager,store}=fixture(t);
  await assert.rejects(manager.patch(VOICE,{enabled:true,channelId:'missing'}),/已验证/);
  store.state.channels[0].status='untested';await assert.rejects(manager.patch(VOICE,{enabled:true,channelId:'qq-fixture'}),/已验证/);
  store.state.channels[0].status='verified';store.state.channels[0].target='fixture:GroupMessage:10001';await assert.rejects(manager.patch(VOICE,{enabled:true,channelId:'qq-fixture'}),/私聊/);
  store.state.channels[0].target='fixture:FriendMessage:10001';await assert.rejects(manager.patch('astrbot_plugin_bilibili_basic_stickers',{enabled:true,channelId:'qq-fixture'}),/表情包/);
});

test('enabled QQ components never add tools to ordinary web chat or another channel or assistant',t=>{
  const {store}=fixture(t),channel=store.state.channels[0],assistant=store.assistant('daily');store.state.cloudPlugins={astrbot_plugin_qqprofile:{enabled:true,channelId:channel.id}};
  const selected=cloudPluginNativeCapabilities(store,assistant,channel);assert.equal(selected.plugins.length,1);assert.ok(selected.tools.includes('qqprofile_set_avatar'));assert.ok(!selected.tools.includes('qqprofile_switch_persona'));
  for(const [a,c] of [[assistant,null],[assistant,{...channel,id:'other'}],[store.assistant('game'),channel],[assistant,{...channel,type:'discord'}],[assistant,{...channel,enabled:false}],[assistant,{...channel,status:'saved'}]])assert.deepEqual(cloudPluginNativeCapabilities(store,a,c),{plugins:[],tools:[]});
});

test('staging only enabled code derives owner scope, writes private credentials and preserves plugin data on disable',t=>{
  const {dir,store}=fixture(t),runtimeRoot=join(dir,'astrbot');
  stageCloudPluginBundles({root,runtimeRoot,store});assert.equal(existsSync(join(runtimeRoot,'data/plugins',VOICE)),false);
  store.state.cloudPlugins={[VOICE]:{enabled:true,channelId:'qq-fixture',config:{owner_session:'untrusted:FriendMessage:99999'}}};store.secrets.cloudPlugins={[VOICE]:{app_id:'synthetic-app',access_key:'synthetic-service-secret'}};
  stageCloudPluginBundles({root,runtimeRoot,store});const config=JSON.parse(readFileSync(join(runtimeRoot,'data/config',VOICE+'_config.json')));
  assert.equal(config.owner_session,'pa-'+store.state.instanceId+'-qq-fixture:FriendMessage:10001');assert.equal(config.access_key,'synthetic-service-secret');
  const data=join(runtimeRoot,'data/plugin_data',VOICE);mkdirSync(data,{recursive:true});writeFileSync(join(data,'fixture.txt'),'keep');
  store.state.cloudPlugins[VOICE].enabled=false;stageCloudPluginBundles({root,runtimeRoot,store});assert.equal(existsSync(join(runtimeRoot,'data/plugins',VOICE)),false);assert.equal(readFileSync(join(data,'fixture.txt'),'utf8'),'keep');
});

test('staging refuses manually modified or unowned plugin directories',t=>{
  const {dir,store}=fixture(t),runtimeRoot=join(dir,'astrbot'),plugin=join(runtimeRoot,'data/plugins',VOICE);store.state.cloudPlugins={[VOICE]:{enabled:true,channelId:'qq-fixture'}};
  mkdirSync(plugin,{recursive:true});assert.throws(()=>stageCloudPluginBundles({root,runtimeRoot,store}),/未覆盖/);rmSync(plugin,{recursive:true});
  stageCloudPluginBundles({root,runtimeRoot,store});writeFileSync(join(plugin,'main.py'),'manual edit');assert.throws(()=>stageCloudPluginBundles({root,runtimeRoot,store}),/手动修改/);
});

test('a failed activation restores previous configuration and credentials and attempts the original runtime',async t=>{
  const {manager,store,runtime}=fixture(t);let starts=0;runtime.start=async()=>{starts++;runtime.child={};runtime.status='ready';if(starts===1)throw Error('synthetic plugin import failure')};
  await assert.rejects(manager.patch(VOICE,{enabled:true,channelId:'qq-fixture',secrets:{app_id:'synthetic-service-secret'}}),/import failure/);
  assert.notEqual(store.state.cloudPlugins[VOICE].enabled,true);assert.equal(store.secrets.cloudPlugins[VOICE],undefined);assert.equal(starts,2);assert.equal(runtime.status,'ready');assert.equal(manager.changing,false);
});

test('busy replies and external engines cannot be reconfigured by component installation',async t=>{
  const {manager,store,runtime}=fixture(t);runtime.busy.add('fixture');await assert.rejects(manager.patch(VOICE,{enabled:false}),/回复/);runtime.busy.clear();store.state.settings.location='remote';await assert.rejects(manager.patch(VOICE,{enabled:false}),/外部/);
});

test('editing a channel cannot retain privileged plugin access for a different recipient',async t=>{
  const {store,runtime}=fixture(t),connections=new Connections(store,runtime);connections.channelCatalog={types:[{type:'aiocqhttp'}]};
  store.state.cloudPlugins={[VOICE]:{enabled:true,channelId:'qq-fixture'}};const before=structuredClone(store.state.channels[0]);
  await assert.rejects(connections.saveChannel({target:'fixture:FriendMessage:20002'},'qq-fixture'),/先.*停用/);assert.deepEqual(store.state.channels[0],before);
});

test('channel routes grant QQ tools to the exact owner, with forwarding isolated to explicit source groups',async t=>{
  const {store}=fixture(t),runtime=new AstrBot({root,store}),calls=[];runtime.authenticate=async()=>{};
  runtime.sync=async(a,c,opts={})=>opts.forwardOnly?'forward-only':opts.channel?'private-owner':'base-no-extras';
  runtime.request=async(path,opts={})=>{calls.push({path,...opts});if(path==='/bots')return {bots:[]};if(path==='/config-routes')return {routing:{}};return {}};
  store.state.cloudPlugins={astrbot_plugin_qqprofile:{enabled:true,channelId:'qq-fixture'},astrbot_sowing_discord:{enabled:true,channelId:'qq-fixture',config:{banshi_group_list:['20001'],banshi_target_list:['20002']}}};
  await runtime.syncChannel(store.state.channels[0]);const writes=calls.filter(c=>c.method==='PUT'&&c.path==='/config-routes');assert.equal(writes.length,1,'replace bindings atomically, avoiding an unconfigured routing interval');const routes=writes[0].body.routing;
  const id='pa-'+store.state.instanceId+'-qq-fixture';assert.equal(routes[id+'::'],'base-no-extras');assert.equal(routes[id+':FriendMessage:10001'],'private-owner');assert.equal(routes[id+':GroupMessage:20001'],'forward-only');assert.equal(routes[id+':GroupMessage:20002'],undefined);assert.equal(Object.keys(routes).length,3);
  assert.equal(Object.keys(routes).at(-1),id+'::','native first-match router requires wildcard last');
  const group=cloudPluginNativeCapabilities(store,store.assistant('daily'),store.state.channels[0],{onlyIds:['astrbot_sowing_discord']});assert.deepEqual(group,{plugins:['astrbot_sowing_discord'],tools:[]});
});

test('component HTTP management is owner-only; paired phones cannot see configuration or submit changes',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'miobot-bundle-api-'));const app=await startServer({dataRoot:dir,port:0,fetcher:()=>{throw Error('no upstream allowed')}});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true})});
  const owner={'X-Personal-Agent':'1'},request=async(path,headers=owner,method='GET',body)=>fetch(app.url+path,{method,headers:{...headers,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const list=await request('/api/bundled-plugins');assert.equal(list.status,200);assert.equal((await list.json()).items.length,9);
  const code=app.devices.issuePairing({label:'fixture'}).code,device=app.devices.exchange({code,label:'fixture'},'fixture'),phone={Cookie:'miobot_device='+device.token,'X-Personal-Agent':'1'};
  assert.equal((await request('/api/bundled-plugins',phone)).status,403);assert.equal((await request('/api/bundled-plugins/'+VOICE,phone,'PATCH',{enabled:false})).status,403);
  assert.equal((await request('/api/bundled-plugins/'+VOICE,owner,'PATCH',{enabled:false})).status,200);assert.equal(app.runtime.child,null);
});
