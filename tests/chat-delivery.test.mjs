import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverConversation,partPause} from '../server/chat-delivery.mjs';

test('reviewed short conversation arrives in ordered parts with a bounded pause',async()=>{
  const events=[];await deliverConversation('我在呢\n你这又是熬到几点了',{wait:async ms=>events.push({pause:ms}),onPart:(text,index)=>events.push({text,index})});
  assert.deepEqual(events,[{text:'我在呢',index:0},{pause:380},{text:'你这又是熬到几点了',index:1}]);
  assert.ok(partPause('字'.repeat(1000))<=850);
});

test('stopping between parts keeps only text actually delivered and never sends later pieces',async()=>{
  const controller=new AbortController(),seen=[];
  await assert.rejects(()=>deliverConversation('第一句\n第二句\n第三句',{signal:controller.signal,wait:async()=>controller.abort(),onPart:text=>seen.push(text)}),{name:'AbortError'});
  assert.deepEqual(seen,['第一句']);
});

test('code and structured task results remain intact and do not acquire chat pauses',async()=>{
  const text='材料清单\n- 木板\n- 木棍\n```js\nconst n=2;\n```',seen=[];
  await deliverConversation(text,{wait:async()=>assert.fail('no pause for one structured result'),onPart:(part,index)=>seen.push({part,index})});
  assert.deepEqual(seen,[{part:text,index:0}]);
});
