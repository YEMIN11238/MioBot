import test from 'node:test';
import assert from 'node:assert/strict';
import {chatTextParts,referenceSources} from '../src/chat-text.mjs';

test('chat links support safe Markdown and bare web URLs while retaining surrounding punctuation',()=>{
  const parts=chatTextParts('看看[官方说明](https://example.test/guide?q=1)，再看 https://example.test/update。');
  assert.deepEqual(parts.filter(part=>part.type==='link'),[{type:'link',text:'官方说明',url:'https://example.test/guide?q=1'},{type:'link',text:'https://example.test/update',url:'https://example.test/update'}]);
  assert.equal(parts.map(part=>part.text).join(''),'看看官方说明，再看 https://example.test/update。');
  assert.equal(chatTextParts('[百科](https://example.test/wiki/Fish_(game))').find(part=>part.type==='link').url,'https://example.test/wiki/Fish_(game)');
  assert.equal(chatTextParts('(https://example.test/a).').map(part=>part.text).join(''),'(https://example.test/a).');
});

test('unsafe link protocols stay plain text, and fenced or inline code is never linkified',()=>{
  for(const text of ['[坏链接](javascript:alert(1))','[数据](data:text/html,example)','[文件](file:///private/example)']){
    assert.equal(chatTextParts(text).some(part=>part.type==='link'),false);assert.equal(chatTextParts(text).map(part=>part.text).join(''),text);
  }
  const code='```js\nconst link="https://example.test/code";\n// [原样](https://example.test/md)\n```\n`https://example.test/inline`\n~~~sh\ncurl https://example.test/terminal\n~~~';
  const parts=chatTextParts(code);assert.equal(parts.some(part=>part.type==='link'),false);assert.equal(parts.map(part=>part.text).join(''),code);
  assert.equal(chatTextParts('```txt\nhttps://example.test/incomplete').some(part=>part.type==='link'),false);
});

test('reference sources reject unsafe URLs, deduplicate, keep actual titles, and cap the displayed list',()=>{
  const items=[{title:'真实来源',url:'https://example.test/a',retrievedAt:'2026-11-02T10:00:00Z'},{title:'重复',url:'https://example.test/a'},{title:'拒绝',url:'javascript:alert(1)'},null,...Array.from({length:15},(_,index)=>({title:'来源 '+index,url:'https://example.test/'+index}))];
  const result=referenceSources(items);assert.equal(result.length,10);assert.equal(result[0].title,'真实来源');assert.equal(result[0].retrievedAt,'2026-11-02T10:00:00Z');assert.equal(new Set(result.map(item=>item.url)).size,10);
  assert.deepEqual(referenceSources(undefined),[]);assert.deepEqual(referenceSources([{url:'data:text/plain,example'}]),[]);
});
