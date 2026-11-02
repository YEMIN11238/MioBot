import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudDraftError,careDeliveryChannels} from '../src/deployment-state.mjs';

test('cloud UI validates secure server input and retains only same-server saved pairing',()=>{
  assert.match(cloudDraftError('http://public.example','new-token'),/HTTPS/);
  assert.match(cloudDraftError('https://user:pass@example.test','new-token'),/账号/);
  assert.match(cloudDraftError('https://example.test/api?token=x','new-token'),/查询参数/);
  assert.equal(cloudDraftError('http://127.0.0.1:4444','local-fixture-token'),'');
  const saved={cloud:{url:'https://my.example.test',paired:true}};
  assert.equal(cloudDraftError('https://my.example.test/','',saved),'');
  assert.match(cloudDraftError('https://other.example.test','',saved),/首次连接/);
});

test('care delivery choices include only this assistant verified active proactive channels',()=>{
  const own={id:'own',assistantId:'daily',enabled:true,supportProactive:true,status:'verified'};
  const values=[own,{...own,id:'other',assistantId:'game'},{...own,id:'unverified',status:'sent'},{...own,id:'disabled',enabled:false},{...own,id:'passive',supportProactive:false}];
  assert.deepEqual(careDeliveryChannels(values,'daily'),[own]);
});
