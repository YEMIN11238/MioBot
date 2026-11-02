import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleReply} from '../shared/reply-visibility.mjs';
import {Store} from '../server/store.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('legacy display wrapper is hidden without deleting ordinary thinking words, English, or code',()=>{
  assert.equal(visibleReply('🤔 思考: PRIVATE_FIXTURE\n\n────\n\n在呢，刚好你来了。'),'在呢，刚好你来了。');
  for(const text of ['这是一道思考题。','Thinking about your plan is useful.','```text\n🤔 思考: example\n────\n```','🤔 思考：这一步要怎么做？'])assert.equal(visibleReply(text),text);
});

test('public history hides old framework output and keeps the original stored record and all user content',()=>{
  const root=mkdtempSync(join(tmpdir(),'miobot-reply-visibility-'));
  try{const store=new Store(root),chat=store.createChat('daily'),leaked='🤔 思考: PRIVATE_FIXTURE\n\n────\n\n正式回答';
    store.message(chat.id,'user',leaked,{status:'complete'});store.message(chat.id,'assistant',leaked,{source:'astrbot',status:'complete',parts:['🤔 思考: PRIVATE_FIXTURE','────','正式回答']});
    const shown=store.snapshot().chats.find(c=>c.id===chat.id);assert.equal(shown.messages[0].text,leaked);assert.equal(shown.messages[1].text,'正式回答');assert.deepEqual(shown.messages[1].parts,['正式回答']);
    assert.equal(store.chat(chat.id).messages[1].text,leaked,'display repair must not rewrite source history');
  }finally{rmSync(root,{recursive:true,force:true});}
});
