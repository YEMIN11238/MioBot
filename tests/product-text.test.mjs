import test from 'node:test';
import assert from 'node:assert/strict';
import {productText,productTemplateDefaults} from '../shared/product-text.mjs';

test('product copy hides implementation branding while preserving actual addresses and protocol identifiers',()=>{
  assert.equal(productText('AstrBot 后台连接失败：401'),'MioBot 后台连接失败：401');
  assert.equal(productText('astrbot_plugin_livingmemory 尚未加载'),'长期记忆 尚未加载');
  const technical='astrbot_wf_output astrbot_text_query /astrbot-slack-webhook/callback /data/astrbot/history https://docs.astrbot.app';
  assert.equal(productText(technical),technical);
});

test('only known new-template defaults are rebranded, without changing protocol values or saved user text',()=>{
  const original={start_message:"Hello, I'm AstrBot!",custom_headers:{'X-Title':'AstrBot',Authorization:'fixture'},dify_output_key:'astrbot_wf_output',callback:'/astrbot-slack-webhook/callback'};
  const next=productTemplateDefaults(original);assert.equal(next.start_message,"Hello, I'm MioBot!");assert.equal(next.custom_headers['X-Title'],'MioBot');
  assert.equal(next.dify_output_key,original.dify_output_key);assert.equal(next.callback,original.callback);assert.equal(next.custom_headers.Authorization,'fixture');assert.equal(original.custom_headers['X-Title'],'AstrBot');
  const custom={start_message:'Welcome to my AstrBot group',custom_headers:{'X-Title':'My own app'}};assert.deepEqual(productTemplateDefaults(custom),custom);
});
