import test from 'node:test';
import assert from 'node:assert/strict';
import {applyChatStreamEvent,belongsToActiveStream} from '../src/chat-stream.mjs';

const initial=()=>({chatId:'fixture-chat',text:'',parts:[],stage:'正在连接模型…'});

test('paced replies show only delivered parts and repeated delivery cannot duplicate a bubble',()=>{
  let stream=applyChatStreamEvent(initial(),{type:'start',messageId:'fixture-reply'});
  stream=applyChatStreamEvent(stream,{type:'stage',stage:'正在整理回复…'});
  assert.equal(stream.stage,'正在整理回复…');assert.equal(stream.text,'');
  stream=applyChatStreamEvent(stream,{type:'part',index:0,text:'先歇一会儿'});
  assert.deepEqual(stream.parts,['先歇一会儿']);assert.equal(stream.mode,'parts');
  const duplicate=applyChatStreamEvent(stream,{type:'part',index:0,text:'先歇一会儿'});
  assert.equal(duplicate,stream);
  stream=applyChatStreamEvent(stream,{type:'part',index:1,text:'想吐槽的话，我在'});
  assert.deepEqual(stream.parts,['先歇一会儿','想吐槽的话，我在']);
  assert.equal(stream.text,'先歇一会儿\n\n想吐槽的话，我在');
  assert.equal(applyChatStreamEvent(stream,{type:'delta',text:'不应追加的原始内容'}),stream);
});

test('stopping or failing a paced reply preserves already delivered text and ends the typing state',()=>{
  for(const type of ['done','cancelled','error']){
    const delivered=applyChatStreamEvent(initial(),{type:'part',index:0,text:'已送达的第一句'});
    const terminal=applyChatStreamEvent(delivered,{type});
    assert.equal(terminal.finished,true);assert.deepEqual(terminal.parts,['已送达的第一句']);
    assert.equal(applyChatStreamEvent(terminal,{type:'part',index:1,text:'结束后不能继续追加'}),terminal);
  }
});

test('invalid or missing earlier part indices cannot produce reordered or empty bubbles',()=>{
  const stream=initial();
  for(const event of [{index:1,text:'还没收到第一句'},{index:-1,text:'无效'},{index:0.5,text:'无效'},{index:3,text:'无效'},{index:0,text:' '},{index:0,text:{value:'invalid'}}])assert.equal(applyChatStreamEvent(stream,{type:'part',...event}),stream);
});

test('ordinary delta replies remain incremental and final polling rows are not rendered twice',()=>{
  let stream=applyChatStreamEvent(initial(),{type:'start',message:{id:'fixture-reply'}});
  stream=applyChatStreamEvent(stream,{type:'delta',text:'第一段'});
  stream=applyChatStreamEvent(stream,{type:'delta',data:'接着输出'});
  assert.equal(stream.text,'第一段接着输出');assert.deepEqual(stream.parts,[]);
  assert.equal(belongsToActiveStream({id:'fixture-reply',status:'complete'},stream),true);
  assert.equal(belongsToActiveStream({id:'previous-reply',status:'streaming'},stream),false);
  assert.equal(belongsToActiveStream({id:'fixture-reply',status:'complete'},null),false);
  assert.equal(belongsToActiveStream({status:'streaming'},initial()),true);
});
