import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,symlinkSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ownerToken,startCloud} from '../server/cloud-main.mjs';

function temporary(t){const root=mkdtempSync(join(tmpdir(),'miobot-cloud-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}

test('owner token persists without being returned by service metadata; file stays private',t=>{
  const root=temporary(t),file=join(root,'cloud-owner-token');
  const first=ownerToken(file);assert.match(first,/^[\w-]{43}$/);assert.equal(ownerToken(file),first);
  assert.equal(statSync(file).mode&0o777,0o600);
  assert.equal(readFileSync(file,'utf8'),first+'\n');
});

test('owner token refuses unsafe files and weak manually supplied values',t=>{
  const root=temporary(t),real=join(root,'real');writeFileSync(real,'synthetic weak value');
  assert.throws(()=>ownerToken(real),/格式/);
  symlinkSync(real,join(root,'link'));assert.throws(()=>ownerToken(join(root,'link')));
  mkdirSync(join(root,'dir'));assert.throws(()=>ownerToken(join(root,'dir')));
  assert.throws(()=>ownerToken('relative-token'),/绝对路径/);
});

test('cloud entry uses authenticated cloud options and initializes only a new data folder',async t=>{
  const root=temporary(t);let captured,saved=0,started=0;
  const state={instanceId:'synthetic-instance',settings:{location:'external',runtimeUrl:'https://synthetic.invalid'}};
  const app={store:{state,save(){saved++;}},runtime:{async start(){started++;}},async close(){}};
  await startCloud({env:{MIOBOT_DATA:root,MIOBOT_PORT:'0',MIOBOT_NO_ENGINE:'1',MIOBOT_SERVER_NAME:'测试实例'},start:async options=>(captured=options,app)});
  assert.equal(captured.host,'0.0.0.0');assert.equal(captured.cloudMode,true);assert.equal(captured.port,0);
  assert.equal(captured.serverName,'测试实例');assert.equal(captured.cloudToken,ownerToken(join(root,'cloud-owner-token')));
  assert.equal(state.instanceId,'synthetic-instance');assert.equal(state.settings.location,'local');
  assert.equal(state.settings.runtimeUrl,'http://127.0.0.1:26185');assert.equal(saved,1);assert.equal(started,0);
  writeFileSync(join(root,'state.json'),'{}');state.settings.location='external';state.settings.runtimeUrl='https://synthetic.invalid';
  await startCloud({env:{MIOBOT_DATA:root},start:async()=>app});
  assert.equal(state.settings.location,'external');assert.equal(saved,1);assert.equal(started,1);
});

test('real cloud HTTP service hides metadata and state until owner Bearer authentication',async t=>{
  const root=temporary(t),app=await startCloud({env:{MIOBOT_DATA:root,MIOBOT_PORT:'0',MIOBOT_NO_ENGINE:'1'}});
  t.after(()=>app.close());
  const base='http://127.0.0.1:'+app.server.address().port;
  const health=await fetch(base+'/health');assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true});
  for(const path of ['/api/cloud/info','/api/state']){
    const denied=await fetch(base+path);assert.equal(denied.status,401);
    const wrong=await fetch(base+path,{headers:{Authorization:'Bearer synthetic-invalid-token'}});assert.equal(wrong.status,401);
  }
  const token=ownerToken(join(root,'cloud-owner-token'));
  const response=await fetch(base+'/api/cloud/info',{headers:{Authorization:'Bearer '+token}});
  assert.equal(response.status,200);const info=await response.json();
  assert.equal(info.product,'MioBot');assert.equal(info.apiVersion,1);assert.equal(info.version,JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version);
  assert.equal(info.instanceId,app.store.state.instanceId);assert.equal(info.name,'MioBot 云端');
  assert.equal(JSON.stringify(info).includes(token),false);
  const state=await fetch(base+'/api/state',{headers:{Authorization:'Bearer '+token}});assert.equal(state.status,200);
  assert.equal((await state.text()).includes(token),false);
});
