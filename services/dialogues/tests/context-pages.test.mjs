// ABOUTME: Проверяет lossless summary fragmentation по реальным JSON/UTF8 байтам.
// ABOUTME: Только синтетический Unicode, без базы, сети или модели.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {contextPages} from '../dist/context.js';
test('большие summaries фрагментируются без потерь и сохраняют byte budget',()=>{
 const text='\u0001"\\😀Ж\n'.repeat(18000);
 const items=[
  {type:'dialogue_summary',dialogue_id:'a',version:'3',through_message_id:'m9',through_order:'9',text},
  {type:'message_representation',dialogue_id:'a',message_id:'m9',summary_version:'5',text:text+'Финал',truncated:false,next_offset:null}
 ];
 const pages=contextPages({delivery_id:'frozen',consumer_id:'c'.repeat(256),context_instance_id:'i'.repeat(256),selected_count:50},items,n=>'signed-cursor-'.repeat(70)+n);
 assert.ok(pages.length>2);
 for(const page of pages){
  assert.equal(page.page_count,pages.length);
  assert.ok(Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[],structuredContent:page}}))<=65536);
  assert.equal(page.selected_count,50);
 }
 assert.equal(pages.at(-1).continuation_cursor,null);
 const all=pages.flatMap(x=>x.items);
 for(const [type,source,version]of [['dialogue_summary_fragment',text,'3'],['message_summary_fragment',text+'Финал','5']]){
  const fragments=all.filter(x=>x.type===type);let offset=0;const parts=[];
  assert.ok(fragments.length>1);
  for(const fragment of fragments){assert.equal(fragment.offset,offset);offset+=Array.from(fragment.text).length;parts.push(fragment.text);assert.equal(fragment.dialogue_id,'a');assert.equal(fragment.version??fragment.summary_version,version);}
  assert.equal(fragments.at(-1).next_offset,null);assert.equal(fragments.at(-1).is_last_fragment,true);
  assert.equal(parts.join(''),source);assert.deepEqual(Buffer.from(parts.join('')),Buffer.from(source));
  assert.equal(fragments[0].text_sha256,createHash('sha256').update(source).digest('hex'));
  assert.equal(fragments[0].total_bytes,Buffer.byteLength(source));
 }
 const headers=all.filter(x=>x.text_format==='fragments');
 assert.equal(headers.length,2);assert.ok(headers.every(x=>x.text===undefined&&x.text_complete===false));
 assert.equal(pages[0].summary_utf8_bytes,Buffer.byteLength(text)+Buffer.byteLength(text+'Финал'));
});
