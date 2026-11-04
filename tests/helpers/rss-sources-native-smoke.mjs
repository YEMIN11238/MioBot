// Actual Python parser and asar-safe staging, local response fixtures only.
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../../server/store.mjs';
import {RssSources} from '../../server/rss-sources.mjs';
const root=resolve(import.meta.dirname,'../..'),dir=mkdtempSync(join(tmpdir(),'miobot-rss-native-'));
try{
  const store=new Store(dir),rss=new RssSources({store,root,python:join(root,'.runtime/astrbot-source/.venv/bin/python'),lookup:async()=>[{address:'1.1.1.1',family:4}],fetcher:async()=>new Response('<rss version="2.0"><channel><title>Fixture</title><item><guid>fixture</guid><title>Real parser</title><link>https://news.example.org/fixture</link><description><![CDATA[Hello <b>source</b>]]></description></item></channel></rss>')});
  const source=await rss.create({assistantId:'daily',name:'Offline fixture',url:'https://feeds.example.org/rss'});
  const read=await rss.fetchForTask({assistantId:'daily',sourceIds:[source.id],runId:'actual-parser-1'});
  assert.equal(read.items.length,1);assert.equal(read.items[0].summary,'Hello source');assert.equal(read.parser,'RSSHub XMLFeedParser');assert.equal(store.state.rssDeliveryLedger,undefined);
  assert.ok(existsSync(join(dir,'rsshub-parser/parse_feed.py')));rss.commitDelivery({assistantId:'daily',runId:'actual-parser-1'});
  const next=await rss.fetchForTask({assistantId:'daily',sourceIds:[source.id],runId:'actual-parser-2'});assert.equal(next.items.length,0);
  writeFileSync(join(dir,'rsshub-parser/upstream/models.py'),'# manual edit');await assert.rejects(rss.fetchForTask({assistantId:'daily',sourceIds:[source.id],runId:'tampered'}),e=>e.code==='RSS_ALL_SOURCES_FAILED'&&e.errors[0].code==='RSS_PARSER_STORAGE_UNSAFE');
  console.log(JSON.stringify({success:true,actualUpstreamParser:true,privateDataRead:false,externalHTTPRequests:0,modelRequests:0,deliveryDedup:true,stagingTamperRefused:true}));
}finally{rmSync(dir,{recursive:true,force:true});}
