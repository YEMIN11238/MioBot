import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {packageCloud} from '../scripts/package-cloud.mjs';

function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'miobot-package-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const dir of ['dist','server','deploy','src','.data','.runtime','node_modules','release'])mkdirSync(join(root,dir));
  for(const file of ['index.html','vite.config.js','LICENSE','THIRD_PARTY.md','README.md','README-cloud.md','README-cloud-client.md','package-lock.json'])writeFileSync(join(root,file),'synthetic source');
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'fixture',version:'0.0.0-test'}));
  writeFileSync(join(root,'dist/index.html'),'<main>fixture</main>');
  writeFileSync(join(root,'server/main.mjs'),'export const fixture=true;');
  for(const file of ['.data/state.json','.runtime/private-runtime','node_modules/private-module','release/old-archive','server/credentials.json','server/private.key','deploy/.env','server/runtime.log'])writeFileSync(join(root,file),'synthetic-private-value');
  return root;
}

test('cloud source archive excludes data, secrets, native runtimes and Finder metadata',t=>{
  const root=fixture(t),result=packageCloud({root,build:false});
  const listing=execFileSync('tar',['-tzf',result.archive],{encoding:'utf8'}).split('\n').filter(Boolean);
  assert.ok(listing.some(x=>x.endsWith('/server/main.mjs')));
  assert.ok(listing.some(x=>x.endsWith('/dist/index.html')));
  assert.ok(listing.some(x=>x.endsWith('/CLOUD-PACKAGE.json')));
  assert.equal(listing.some(x=>x.split('/').some(p=>['.data','.runtime','node_modules','release','credentials.json','.env'].includes(p)||p.startsWith('._'))),false);
  assert.equal(listing.some(x=>/\.(?:key|log)$/.test(x)),false);
  assert.equal(result.dockerImageBuildVerified,false);
  assert.match(result.sha256,/^[a-f0-9]{64}$/);
});

test('cloud source archive refuses links instead of accidentally copying outside the source',t=>{
  const root=fixture(t);symlinkSync(join(root,'.data/state.json'),join(root,'src/private-link'));
  assert.throws(()=>packageCloud({root,build:false}),/符号链接/);
});
