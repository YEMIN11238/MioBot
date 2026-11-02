import test from 'node:test';
import assert from 'node:assert/strict';
import {extensionRequest,extensionStateLabel,extensionUsable,privateMediaURL,sourceURL,uploadBody,officialDeepSeekConnections} from '../src/extensions-api.mjs';

test('optional media requires installation, readiness, global enablement, and assistant permission',()=>{
  const module={id:'voice',installed:true,enabled:true,status:'ready'};
  assert.equal(extensionUsable([module],{skills:['voice']},'voice'),true);
  assert.equal(extensionUsable([module],{skills:[]},'voice'),false);
  for(const patch of [{installed:false},{enabled:false},{status:'needs_configuration'},{status:'error'}]){
    assert.equal(extensionUsable([{...module,...patch}],{skills:['voice']},'voice'),false);
  }
  assert.equal(extensionUsable([],{skills:['voice']},'voice'),false);
  assert.match(extensionStateLabel({...module,enabled:false}),/未启用/);
  assert.match(extensionStateLabel({...module,installed:false}),/待确认/);
});

test('explicit configuration and one-off test requests preserve their payload without silently enabling extensions',async()=>{
  const calls=[],previous=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{calls.push({url,...options});return {ok:true,json:async()=>({ok:true})};};
  try{
    await extensionRequest('/extensions/web','PATCH',{config:{provider:'tavily'},secrets:{key:'fixture-only-key'}});
    await extensionRequest('/extensions/web/test','POST',{assistantId:'game',text:'fixture query'});
    assert.deepEqual(calls.map(call=>call.url),['/api/extensions/web','/api/extensions/web/test']);
    assert.ok(calls.every(call=>call.headers['X-Personal-Agent']==='1'));
    assert.ok(calls.every(call=>!Object.hasOwn(JSON.parse(call.body),'enabled')));
    assert.deepEqual(JSON.parse(calls[1].body),{assistantId:'game',text:'fixture query'});
  }finally{globalThis.fetch=previous;}
});

test('media authentication stays on media routes and search source links allow only web protocols',()=>{
  assert.equal(privateMediaURL('/api/media/audio/sample?assistantId=daily'),'/api/media/audio/sample?assistantId=daily');
  assert.equal(privateMediaURL('/api/media/stickers/sample'),'/api/media/stickers/sample');
  for(const url of ['https://outside.test/api/media/audio/sample','//outside.test/api/media/audio/sample','/api/deployment','/api/media/audio/../../deployment','/api/media/audio/sample/extra'])assert.equal(privateMediaURL(url),'');
  assert.equal(sourceURL('https://source.test/guide'),'https://source.test/guide');
  for(const url of ['javascript:alert(1)','data:text/html,example','file:///private/example','not a link'])assert.equal(sourceURL(url),'');
});

test('upload size guard rejects oversized and empty files before reading content',async()=>{
  await assert.rejects(uploadBody({name:'big.png',size:5*1024*1024+1},{assistantId:'daily',limitMiB:5}),/5 MiB/);
  await assert.rejects(uploadBody({name:'empty.txt',size:0},{assistantId:'daily',limitMiB:10}),/非空/);
});

test('the DeepSeek search picker exposes only saved official HTTPS connections',()=>{
  const official={id:'official',name:'我的 DeepSeek',apiBase:'https://api.deepseek.com/v1',hasKey:true};
  assert.deepEqual(officialDeepSeekConnections([official,{...official,id:'relay',apiBase:'https://api.deepseek.com.relay.example/v1'},{...official,id:'http',apiBase:'http://api.deepseek.com/v1'},{...official,id:'credentials',apiBase:'https://user:pass@api.deepseek.com/v1'},{id:'missing'}]),[official]);
});
