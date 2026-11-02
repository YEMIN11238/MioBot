import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
import {bundledCapability,searchAvailabilityNotice,OPTIONAL_SKILL_IDS} from '../src/bundled-ui.mjs';

test('bundled UI consumes backend readiness and distinguishes configured search from verified search',()=>{
  assert.equal(bundledCapability({},'web').ready,false);
  assert.equal(bundledCapability({extensions:{web:true}},'web').ready,false);
  const data={bundledCapabilities:{memory:{status:'ready'},web:{status:'configured',provider:'deepseek',verificationStatus:'untested'}}};
  assert.equal(bundledCapability(data,'memory').ready,true);
  assert.equal(bundledCapability(data,'web').ready,true);
  assert.equal(bundledCapability(data,'web').verified,false);
  assert.equal(bundledCapability(data,'web').label,'已连接');
  data.bundledCapabilities.web.verificationStatus='passed';assert.equal(bundledCapability(data,'web').label,'已验证');
});

test('one-time search notice exists only for a reported missing or failed service and has a stable scoped identity',()=>{
  assert.equal(searchAvailabilityNotice({}),null);
  assert.equal(searchAvailabilityNotice({bundledCapabilities:{web:{status:'configured'}}}),null);
  const data={instanceId:'fixture-instance',bundledCapabilities:{web:{status:'needs_configuration',reason:'这个账号暂不提供搜索。'}}};
  const notice=searchAvailabilityNotice(data);assert.match(notice.text,/这个账号暂不提供搜索/);assert.match(notice.text,/普通聊天仍可继续/);
  assert.equal(searchAvailabilityNotice(structuredClone(data)).key,notice.key);
  assert.notEqual(searchAvailabilityNotice({...data,instanceId:'another-instance'}).key,notice.key);
});

test('normal assistant and extension pages expose only optional capability controls and no base-status cards',async()=>{
  const server=await createServer({server:{middlewareMode:true},appType:'custom'});
  try{
    const [{default:AssistantCapabilities},{default:ExtensionsPanel,AdvancedSearchSettings,ExtensionEditor}]=await Promise.all([server.ssrLoadModule('/src/AssistantCapabilities.jsx'),server.ssrLoadModule('/src/ExtensionsPanel.jsx')]);
    const assistants=[{id:'game',kind:'game',name:'游戏助手',persona:'自己的游戏搭档',skills:['memory','long_memory','reminders','humanize','web','minecraft']}];
    const data={assistants,modelConnections:[],bundledCapabilities:{memory:{status:'ready'},reminders:{status:'ready'},web:{status:'needs_configuration',reason:'当前账号暂无搜索服务。'}}};
    const editor=renderToStaticMarkup(React.createElement(AssistantCapabilities,{assistant:assistants[0]}));
    for(const name of ['允许手动记忆','允许定时提醒','允许拟人聊天与节奏','允许助手专属长期记忆','允许网页资料检索'])assert.equal(editor.includes('aria-label="'+name+'"'),false,name);
    assert.ok(editor.includes('允许主动关心'));assert.ok(editor.includes('允许语音回复'));
    const items=['memory','reminders','web','voice','stickers','files'].map(id=>({id,installed:true,enabled:true,status:'ready',config:{}}));
    const page=renderToStaticMarkup(React.createElement(ExtensionsPanel,{data,initialItems:items,assistantId:'game'}));
    for(const name of ['启用手动记忆','启用定时提醒','启用网页资料检索'])assert.equal(page.includes('aria-label="'+name+'"'),false,name);
    assert.ok(page.includes('启用语音回复'));assert.equal(page.includes('让当前助手联网'),false);assert.equal(page.includes('内置基础能力'),false);assert.equal(page.includes('跨会话记忆'),false);assert.equal(page.includes('定时提醒'),false);assert.ok(editor.includes('接好模型即可聊天，记住重要的事并安排提醒。'));
    const advanced=renderToStaticMarkup(React.createElement(AdvancedSearchSettings,{data}));assert.ok(advanced.includes('高级：搜索服务配置'));assert.equal(/<details[^>]*\sopen/.test(advanced),false);
    const search=renderToStaticMarkup(React.createElement(ExtensionEditor,{item:{id:'web',installed:true,enabled:true,status:'ready',config:{provider:'deepseek'}},assistants,modelConnections:[]}));
    assert.ok(search.includes('DeepSeek 搜索使用的连接'));assert.equal(search.includes('允许当前助手使用'),false);assert.equal(search.includes('让当前助手联网'),false);
    for(const id of ['memory','reminders','humanize','long_memory','web'])assert.equal(OPTIONAL_SKILL_IDS.includes(id),false);
  }finally{await server.close();}
});
