import http from 'node:http';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {AstrBot} from '../server/astrbot.mjs';
import {Connections} from '../server/connections.mjs';
import {projectRoot} from '../server/index.mjs';
const root=mkdtempSync(join(tmpdir(),'pa-native-smoke-'));let calls=0,seen=[];
const model=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;
 if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'local-fixture'}]}));}
 const payload=JSON.parse(raw);calls++;seen.push(payload);
 if(payload.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'local-fixture',choices:[{index:0,delta:{role:'assistant',content:'本地模拟模型连通，AstrBot 已实际处理这条消息。'},finish_reason:null}]})+'\n\n');res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'local-fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\n');res.end('data: [DONE]\n\n');}
 else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'local-fixture',choices:[{index:0,message:{role:'assistant',content:'本地模拟模型连通，AstrBot 已实际处理这条消息。'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));}
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));
const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const runtimePort=probe.address().port;await new Promise(r=>probe.close(r));
const store=new Store(root);store.state.settings.runtimeUrl='http://127.0.0.1:'+runtimePort;store.state.memories.push({content:'测试偏好：回答简短',assistantId:'daily',shared:false});store.save();
const runtime=new AstrBot({root:projectRoot,store}),connections=new Connections(store,runtime);let report;
try{
 await runtime.start();
 const catalog=await connections.models();assert.equal(catalog.source,'astrbot');
 const openai=catalog.templates.find(t=>t.type==='openai_chat_completion'),gemini=catalog.templates.find(t=>t.type==='googlegenai_chat_completion');
 assert.ok(openai&&gemini);assert.notEqual(openai.type,gemini.type);assert.ok('gm_native_search' in gemini.config);
 const input={name:'Local fixture',template:openai.id,type:openai.type,provider:openai.provider,apiBase:`http://127.0.0.1:${model.address().port}/v1`,model:'local-fixture',key:'offline-test-only'};
 const primary=await connections.saveModel(input),alternate=await connections.saveModel({...input,name:'Alternate fixture',model:'local-fixture-game'});
 store.state.settings.defaultConnectionId=primary.id;store.assistant('game').defaultConnectionId=alternate.id;store.save();
 const validation=await runtime.testModel(primary);assert.equal(validation.status,'available');
 const chat=store.createChat('daily'),firstQuestion='你好，请检查这次连通测试。';
 const answer=await runtime.chat(chat,firstQuestion);assert.match(answer,/AstrBot/);assert.ok(calls>0);assert.ok(seen.some(p=>JSON.stringify(p.messages).includes('测试偏好')));
 const nativeSession=chat.nativeSession;
 const second=await runtime.chat(chat,'第二条消息，验证复用配置。');assert.match(second,/AstrBot/);assert.ok(JSON.stringify(seen.at(-1).messages).includes(firstQuestion),'second turn must include prior conversation');
 store.state.memories[0].content='测试偏好：回答详细';store.save();
 await runtime.chat(chat,'更新记忆后继续聊天。');assert.equal(chat.nativeSession,nativeSession);assert.ok(JSON.stringify(seen.at(-1).messages).includes('测试偏好：回答详细'),'updated memory must reach the actual model payload');assert.ok(JSON.stringify(seen.at(-1).messages).includes(firstQuestion),'memory edits must preserve prior conversation context');
 const newOwnerChat=store.createChat('daily');await runtime.chat(newOwnerChat,'新对话记忆验证');assert.ok(JSON.stringify(seen.at(-1).messages).includes('测试偏好：回答详细'));
 const gameChat=store.createChat('game');await runtime.chat(gameChat,'隔离测试');assert.equal(seen.at(-1).model,'local-fixture-game');assert.ok(!JSON.stringify(seen.at(-1).messages).includes('测试偏好'));
 store.state.memories[0].shared=true;const sharedChat=store.createChat('game');await runtime.chat(sharedChat,'授权共享测试');assert.ok(JSON.stringify(seen.at(-1).messages).includes('测试偏好'));
 const channelCatalog=await connections.channels();assert.equal(channelCatalog.source,'astrbot');const telegram=channelCatalog.types.find(t=>t.type==='telegram');assert.ok(telegram);
 const channel=await connections.saveChannel({name:'Disabled routing fixture',type:telegram.type,assistantId:'daily',target:'',enabled:false,config:{telegram_token:'offline-fixture-token'}});
 await connections.connect(channel.id);
 const savedChannel=store.channel(channel.id),nativeBot=(await runtime.request('/bots/by-id?bot_id='+encodeURIComponent(savedChannel.nativeId))).bot;
 assert.equal(nativeBot.enable,false,'a routing test must not log into Telegram');
 const routeKey=savedChannel.nativeId+'::',route=(await runtime.request('/config-routes')).routing[routeKey];assert.ok(route,'a channel without an outgoing target must bind incoming sessions');
 store.state.memories[0].content='渠道即时更新记忆';store.save();assert.deepEqual(await connections.refreshBindings(['daily']),[]);
 assert.ok((await runtime.request('/personas')).some(p=>p.persona_id.endsWith('-daily')&&p.system_prompt.includes('渠道即时更新记忆')));
 store.assistant('daily').defaultConnectionId=alternate.id;store.save();assert.deepEqual(await connections.refreshBindings(['daily']),[]);
 const changedRoute=(await runtime.request('/config-routes')).routing[routeKey],changedProfile=await runtime.request('/config-profiles/'+encodeURIComponent(changedRoute));
 assert.equal(changedProfile.config.agent_runner.config.model.provider_id,runtime.connectionIds(alternate).providerId);
 store.assistant('daily').defaultConnectionId=primary.id;store.save();assert.deepEqual(await connections.refreshBindings(['daily']),[]);
 chat.connectionId=alternate.id;await runtime.chat(chat,'临时切换模型。');assert.equal(seen.at(-1).model,'local-fixture-game');
 const routedProfile=await runtime.request('/config-profiles/'+encodeURIComponent(route));
 assert.equal(routedProfile.config.agent_runner.config.model.provider_id,runtime.connectionIds(primary).providerId,'temporary web model override must not change the messaging channel model');
 report={ok:true,engine:'AstrBot 4.29.3',model:'local HTTP fixture',paidCalls:0,fixtureCalls:calls,nativeModelSchema:true,geminiNativeProtocolDistinct:true,realProviderTest:true,stableConnectionIds:true,sessionCreated:!!chat.nativeSession,secondTurnContext:true,memoryUpdatedWithoutSessionReset:true,newSessionMemory:true,assistantIsolation:true,explicitSharing:true,assistantModelSelection:true,chatModelOverride:true,disabledChannelConfigured:true,nativeConfigRoute:true,targetlessChannelRoute:true,memoryEditSyncedToChannel:true,assistantModelSyncedToChannel:true,channelModelUnaffectedByWebOverride:true};console.log(JSON.stringify(report,null,2));
}
catch(e){report={ok:false,error:runtime.safeError(e),paidCalls:0,fixtureCalls:calls};console.error(JSON.stringify(report,null,2));process.exitCode=1;}
finally{const child=runtime.child;runtime.stop();if(child&&child.exitCode===null)await new Promise(resolve=>{const timeout=setTimeout(()=>{child.kill('SIGKILL');},5000);child.once('exit',()=>{clearTimeout(timeout);resolve();});});await new Promise(r=>model.close(r));mkdirSync(join(projectRoot,'artifacts'),{recursive:true});writeFileSync(join(projectRoot,'artifacts/astrbot-smoke.json'),JSON.stringify(report,null,2));rmSync(root,{recursive:true,force:true});}
