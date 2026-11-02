import test from 'node:test';import assert from 'node:assert/strict';
import {requestedMediaIntent} from '../server/media-intent.mjs';
test('explicit refusal overrides a media button or a positive substring; later clear request can override prior refusal',()=>{
  for(const text of ['不要发语音','别再给我发语音了','不用语音，文字说','关闭语音回复'])assert.equal(requestedMediaIntent(text,'voice',{button:true}),false,text);
  assert.equal(requestedMediaIntent('发个语音','voice'),true);
  assert.equal(requestedMediaIntent('你好','voice'),false);
  assert.equal(requestedMediaIntent('你好','voice',{button:true}),true);
  assert.equal(requestedMediaIntent('别每次都发语音，但这次发条语音','voice'),true);
  assert.equal(requestedMediaIntent('发语音，算了不要语音','voice'),false);
  assert.equal(requestedMediaIntent('别给我发表情包','stickers'),false);
  assert.equal(requestedMediaIntent('发一张表情包','stickers'),true);
});
