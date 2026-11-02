import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {startServer} from '../server/index.mjs';
import {Deployment} from '../server/deployment.mjs';
import {Store} from '../server/store.mjs';

const fixtureToken='fixture-cloud-pairing-key-123456';
const sendJSON=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};

/** A real loopback HTTP server: no model, account, or external service is used. */
async function fakeCloud({token=fixtureToken,instanceId='fixture-cloud',name='QA 云端'}={}){
  const requests=[],gates=new Set(),state={infoStatus:200,invalidProduct:false,onInfo:null,closed:false};
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    requests.push({url:req.url,method:req.method,headers:{...req.headers},body:Buffer.concat(chunks).toString()});
    if(req.headers.authorization!=='Bearer '+token||req.headers['x-personal-agent']!=='1')return sendJSON(res,401,{error:'fixture: unauthorized'});
    if(req.url==='/api/cloud/info'){
      state.onInfo?.();
      return sendJSON(res,state.infoStatus,state.invalidProduct?{product:'Other',apiVersion:1,instanceId}:{product:'MioBot',apiVersion:1,instanceId,name});
    }
    if(req.url.startsWith('/api/events')){
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache'});
      res.write('data: {"type":"stage","stage":"fixture first event"}\n\n');
      await new Promise(resolve=>gates.add(resolve));
      if(!res.destroyed)res.end('data: {"type":"done","message":{"text":"fixture complete"}}\n\n');
      return;
    }
    if(req.url.startsWith('/api/media/audio/')){
      res.writeHead(200,{'Content-Type':'audio/wav','Content-Disposition':'inline; filename="fixture.wav"'});res.end(Buffer.from([82,73,70,70,0,255,1]));return;
    }
    return sendJSON(res,200,{remote:true,instanceId,method:req.method,path:req.url,input:chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {state,requests,url:'http://127.0.0.1:'+server.address().port,
    releaseEvents(){for(const resolve of gates)resolve();gates.clear();},
    async close(){if(state.closed)return;state.closed=true;for(const resolve of gates)resolve();gates.clear();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}};
}

async function fixture(run){
  const data=mkdtempSync(join(tmpdir(),'miobot-deployment-')),cloud=await fakeCloud();
  const app=await startServer({root:resolve(import.meta.dirname,'..'),dataRoot:data,port:0});
  const request=async(path,method='GET',body)=>{
    const response=await fetch(app.url+path,{method,headers:{'X-Personal-Agent':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,value:await response.json()};
  };
  try{await run({app,cloud,request});}
  finally{cloud.releaseEvents();app.deployment.close();app.server.closeAllConnections?.();await app.close();await cloud.close();rmSync(data,{recursive:true,force:true});}
}

function seedPending(app){
  const at=new Date().toISOString(),dueAt=new Date(Date.now()+3600000).toISOString();
  app.store.state.tasks=[{id:'qa-pending',assistantId:'daily',title:'fixture reminder',dueAt,channel:'web',status:'pending',logs:[{at,text:'fixture created'}]},{id:'qa-draft',assistantId:'daily',title:'fixture draft',dueAt,channel:'web',status:'draft',logs:[]}];
  app.store.assistant('daily').care.enabled=true;app.store.save();
}

test('failed cloud pairing preserves the current backend, tasks, care, and stored pairing',async()=>fixture(async({app,cloud,request})=>{
  seedPending(app);const before=structuredClone(app.store.state);
  for(const input of [{url:cloud.url,token:'wrong-fixture-pairing-key'},{url:'http://public.example',token:fixtureToken}]){
    const result=await request('/api/deployment/connect','POST',input);assert.equal(result.status,400);assert.equal(result.value.error.includes(input.token),false);
    assert.deepEqual(app.store.state,before);assert.equal(app.store.secrets.cloudConnection,undefined);
  }
  cloud.state.invalidProduct=true;
  const invalid=await request('/api/deployment/connect','POST',{url:cloud.url,token:fixtureToken});assert.equal(invalid.status,400);assert.match(invalid.value.error,/完整/);assert.deepEqual(app.store.state,before);
  cloud.state.invalidProduct=false;
  const paired=await request('/api/deployment/connect','POST',{url:cloud.url,token:fixtureToken});assert.equal(paired.status,200);
  const prior=structuredClone(app.store.secrets.cloudConnection),priorState=structuredClone(app.store.state);
  cloud.state.infoStatus=503;
  const failed=await request('/api/deployment/connect','POST',{url:cloud.url,token:fixtureToken});assert.equal(failed.status,400);assert.match(failed.value.error,/503/);
  assert.deepEqual(app.store.secrets.cloudConnection,prior);assert.deepEqual(app.store.state,priorState);assert.equal(app.deployment.mode,'cloud');
}));

test('pairing never exposes its token, retains it only for the same URL, and requires a key for another server',async()=>fixture(async({app,cloud,request})=>{
  const first=await request('/api/deployment/connect','POST',{url:cloud.url,token:fixtureToken});assert.equal(first.status,200);assert.equal(first.value.mode,'cloud');
  for(const value of [first.value,(await request('/api/deployment')).value,app.store.snapshot()])assert.equal(JSON.stringify(value).includes(fixtureToken),false);
  const reused=await request('/api/deployment/connect','POST',{url:cloud.url+'/',token:''});assert.equal(reused.status,200);assert.equal(app.store.secrets.cloudConnection.token,fixtureToken);
  assert.equal(cloud.requests.at(-1).headers.authorization,'Bearer '+fixtureToken);
  const other=await fakeCloud({token:'other-fixture-pairing-key-12345',instanceId:'other-cloud'});
  try{
    const prior=structuredClone(app.store.secrets.cloudConnection),result=await request('/api/deployment/connect','POST',{url:other.url,token:''});
    assert.equal(result.status,400);assert.deepEqual(app.store.secrets.cloudConnection,prior);assert.equal(other.requests.length,0);
  }finally{await other.close();}
}));

test('switching to cloud pauses local pending reminders and care without migrating or restoring them',async()=>fixture(async({app,cloud,request})=>{
  seedPending(app);let stopped=0;app.runtime.stop=()=>{stopped++;};
  const first=await request('/api/deployment/connect','POST',{url:cloud.url,token:fixtureToken});assert.equal(first.status,200);assert.equal(stopped,1);
  const pending=app.store.state.tasks.find(task=>task.id==='qa-pending');assert.equal(pending.status,'paused');assert.match(pending.logs.at(-1).text,/没有自动迁移/);assert.equal(app.store.state.tasks.find(task=>task.id==='qa-draft').status,'draft');assert.equal(app.store.assistant('daily').care.enabled,false);
  assert.equal(first.value.localTasksPaused,true);assert.deepEqual(cloud.requests.map(value=>value.url),['/api/cloud/info']);
  const unconfirmed=await request('/api/deployment/local','POST',{});assert.equal(unconfirmed.status,400);assert.equal(app.deployment.mode,'cloud');
  const local=await request('/api/deployment/local','POST',{confirm:true});assert.equal(local.status,200);assert.equal(local.value.mode,'local');assert.equal(pending.status,'paused');assert.equal(app.store.assistant('daily').care.enabled,false);
  app.scheduler.tick();assert.equal(app.store.state.notifications.length,0);assert.equal(pending.status,'paused');
  const stillRunning=await fetch(cloud.url+'/api/cloud/info',{headers:{Authorization:'Bearer '+fixtureToken,'X-Personal-Agent':'1'}});assert.equal(stillRunning.status,200);
}));

test('cloud proxy forwards method, JSON body, query, authentication, and binary media without exposing local records',async()=>fixture(async({app,cloud,request})=>{
  await request('/api/deployment/connect','POST',{url:cloud.url,token:fixtureToken});
  const beforeGuide=cloud.requests.length,guide=await request('/api/deployment/guide');assert.equal(guide.status,200);assert.equal(typeof guide.value.guide,'string');assert.equal(guide.value.packageUrl,'/api/deployment/package');assert.equal(cloud.requests.length,beforeGuide);
  const result=await request('/api/echo?assistantId=remote-game&mode=test','PATCH',{text:'fixture payload',fileIds:['fixture-file']});
  assert.equal(result.status,200);assert.deepEqual(result.value,{remote:true,instanceId:'fixture-cloud',method:'PATCH',path:'/api/echo?assistantId=remote-game&mode=test',input:{text:'fixture payload',fileIds:['fixture-file']}});
  const sent=cloud.requests.at(-1);assert.equal(sent.headers.authorization,'Bearer '+fixtureToken);assert.equal(sent.headers['x-personal-agent'],'1');assert.ok(sent.headers['x-miobot-request']);assert.equal(sent.headers['content-type'],'application/json');assert.equal(JSON.stringify(result.value).includes(fixtureToken),false);
  const remoteState=await request('/api/state');assert.equal(remoteState.value.remote,true);assert.equal(remoteState.value.instanceId,'fixture-cloud');assert.equal(remoteState.value.assistants,undefined);
  const media=await fetch(app.url+'/api/media/audio/sample?assistantId=remote-game',{headers:{'X-Personal-Agent':'1'}});assert.equal(media.status,200);assert.equal(media.headers.get('content-type'),'audio/wav');assert.match(media.headers.get('content-disposition'),/fixture\.wav/);assert.deepEqual(Buffer.from(await media.arrayBuffer()),Buffer.from([82,73,70,70,0,255,1]));
}));

test('cloud SSE arrives incrementally before the upstream response finishes',async()=>fixture(async({app,cloud,request})=>{
  await request('/api/deployment/connect','POST',{url:cloud.url,token:fixtureToken});
  const response=await fetch(app.url+'/api/events?assistantId=remote-game',{headers:{'X-Personal-Agent':'1'},signal:AbortSignal.timeout(4000)});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const reader=response.body.getReader(),first=await reader.read();assert.equal(first.done,false);const firstText=new TextDecoder().decode(first.value);assert.match(firstText,/fixture first event/);assert.doesNotMatch(firstText,/fixture complete/);
  cloud.releaseEvents();let rest='';while(true){const result=await reader.read();if(result.done)break;rest+=new TextDecoder().decode(result.value);}assert.match(rest,/fixture complete/);assert.equal(app.deployment.controllers.size,0);
}));

test('offline cloud still permits local recovery and never silently resumes old reminders or care',async()=>fixture(async({app,cloud,request})=>{
  seedPending(app);await request('/api/deployment/connect','POST',{url:cloud.url,token:fixtureToken});await cloud.close();
  const failed=await request('/api/state');assert.equal(failed.status,502);assert.equal(JSON.stringify(failed.value).includes(fixtureToken),false);
  const status=await request('/api/deployment');assert.equal(status.status,200);assert.equal(status.value.mode,'cloud');assert.equal(status.value.cloud.online,false);assert.equal(status.value.cloud.paired,true);
  const recovered=await request('/api/deployment/local','POST',{confirm:true});assert.equal(recovered.status,200);assert.equal(recovered.value.mode,'local');
  const local=await request('/api/state');assert.equal(local.status,200);assert.equal(local.value.instanceId,app.store.state.instanceId);assert.ok(local.value.assistants.length>0);assert.equal(local.value.tasks.find(task=>task.id==='qa-pending').status,'paused');assert.equal(local.value.assistants.find(assistant=>assistant.id==='daily').care.enabled,false);
}));

test('a busy local operation prevents pairing both before and after the remote probe',async()=>{
  const data=mkdtempSync(join(tmpdir(),'miobot-deployment-busy-')),cloud=await fakeCloud(),store=new Store(data);let busy=true,stops=0;
  const deployment=new Deployment({store,runtime:{stop(){stops++;}},isBusy:()=>busy});
  try{
    await assert.rejects(deployment.connect({url:cloud.url,token:fixtureToken}),/完成/);assert.equal(cloud.requests.length,0);
    busy=false;cloud.state.onInfo=()=>{busy=true;};await assert.rejects(deployment.connect({url:cloud.url,token:fixtureToken}),/新的回复/);
    assert.equal(deployment.mode,'local');assert.equal(store.secrets.cloudConnection,undefined);assert.equal(stops,0);
  }finally{deployment.close();await cloud.close();rmSync(data,{recursive:true,force:true});}
});
