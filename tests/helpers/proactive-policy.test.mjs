import test from 'node:test';
import assert from 'node:assert/strict';
import {careInstruction,proactiveDeliveryKey} from '../../integrations/proactive/policy.mjs';

test('explicit care switches are recognized without treating reminders, questions or quoted examples as consent',()=>{
  for(const text of ['你可以偶尔主动找我聊聊天','以后偶尔叫叫我','开启主动关心','恢复主动聊天','以后主动来找我聊天','偶尔主动找我就行'])assert.equal(careInstruction(text)?.enabled,true,text);
  for(const text of ['不要主动找我','别打扰我','以后不要主动关心我','不要主动给我发消息','关闭主动关心','能不能别打扰我？','你可不可以不要主动给我发消息？'])assert.equal(careInstruction(text)?.enabled,false,text);
  for(const text of ['明天早上叫我起床','明天7点叫我','为什么你不主动找我？','“不要主动找我”是什么意思','它可以主动聊天吗','我不想听你讲道理，正常聊天就好'])assert.equal(careInstruction(text),null,text);
});

test('proactive scope keys never fall back to a global user and isolate every bound identity component',()=>{
  const scope={instanceId:'instance',assistantId:'companion',userId:'owner',sessionId:'chat',channelId:'web'},base=proactiveDeliveryKey(scope);
  for(const key of Object.keys(scope)){assert.notEqual(proactiveDeliveryKey({...scope,[key]:scope[key]+'-other'}),base);assert.throws(()=>proactiveDeliveryKey({...scope,[key]:''}),/缺少/);}
  assert.match(base,/^miobot-proactive:v1:[0-9a-f]{64}$/);
});
