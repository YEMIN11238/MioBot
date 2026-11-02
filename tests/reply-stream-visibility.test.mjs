import test from 'node:test';import assert from 'node:assert/strict';
import {visibleReply,ReplyVisibilityFilter} from '../shared/reply-visibility.mjs';
import {applyManagedModelVisibility} from '../server/model-visibility.mjs';

test('provider thoughts never appear at any split or character of the stream',()=>{
  for(const raw of ['<think>PRIVATE_ANALYSIS</think>在呢。',' \n<thinking>PRIVATE_ANALYSIS</thinking>\n可以，刚查到了。','🤔 思考: PRIVATE_ANALYSIS\n\n────\n\n在呢。','<think>PRIVATE_ANALYSIS</think><thinking>SECOND_PRIVATE</thinking>好了。']){
    const expected=visibleReply(raw);assert.ok(expected&&!expected.includes('PRIVATE'));
    for(let split=0;split<=raw.length;split++){
      const filter=new ReplyVisibilityFilter();const first=filter.push(raw.slice(0,split));assert.equal(first.includes('PRIVATE'),false);const rest=filter.push(raw.slice(split))+filter.finish();assert.equal(first+rest,expected);
    }
    const filter=new ReplyVisibilityFilter();let shown='';for(const char of raw){shown+=filter.push(char);assert.equal(shown.includes('PRIVATE'),false);}shown+=filter.finish();assert.equal(shown,expected);
  }
});

test('unclosed provider thinking stays private while ordinary language, code, and visible text stream faithfully',()=>{
  for(const raw of ['我在思考你的问题。','Thinking is useful.','```xml\n<think>example</think>\n```','`<think>example</think>`','这是 <think>普通标签</think> 的示例','🤔 思考：这一步要怎么做？']){
    const filter=new ReplyVisibilityFilter();let shown='';for(const char of raw)shown+=filter.push(char);shown+=filter.finish();assert.equal(shown,raw);
  }
  const filter=new ReplyVisibilityFilter();assert.equal(filter.push('<think>PRIVATE_INCOMPLETE'),'');assert.equal(filter.finish(),'');assert.equal(filter.text,'');
});

test('official DeepSeek disables provider thinking without mutating saved config or other protocols',()=>{
  const source={custom_extra_body:{thinking:{type:'enabled',budget_tokens:512},other:'keep'}},before=structuredClone(source);
  const official={type:'openai_chat_completion',apiBase:'https://api.deepseek.com/v1'};
  assert.deepEqual(applyManagedModelVisibility(official,source).custom_extra_body,{thinking:{type:'disabled',budget_tokens:512},other:'keep'});assert.deepEqual(source,before);
  for(const connection of [{...official,apiBase:'https://relay.example/v1'},{...official,apiBase:'https://api.deepseek.com.evil.example/v1'},{...official,type:'googlegenai_chat_completion',apiBase:'https://generativelanguage.googleapis.com'}])assert.deepEqual(applyManagedModelVisibility(connection,source),source);
});
