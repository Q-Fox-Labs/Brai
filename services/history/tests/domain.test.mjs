// ABOUTME: Проверяет прикладные правила истории через простой порт без реальных технологий.
// ABOUTME: PostgreSQL, RLS и блокировки проверяются отдельно на синтетическом стенде.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonical, normalizeTimestamp, createHistoryHandlers, HistoryFault } from '../dist/domain.js';
const cursorKey = 'synthetic-history-cursor-key-32-bytes';
const event = () => ({id:randomUUID(),source:'test',type_id:101,occurred_at:'2026-10-05T20:03:04.123456+02:00',scope_type:'user',scope_id:'user-a'});
function memory() {
  let events=[];
  let categories=[];
  const store={
    async transaction(user,context,run) {
      const before=structuredClone(events),beforeCategories=structuredClone(categories);
      try { return await run({
        async insertEvent(row) {if(events.some(e=>e.source===row.source&&e.id===row.id))return null;const saved={...row,recorded_at:'2026-10-05T18:04:00.100001Z'};events.push(saved);return saved;},
        async event(source,id) {return events.find(e=>e.source===source&&e.id===id&&(user===null||e.scope_type==='user'&&e.scope_id===user))??null;},
        async lockEvent(){},
        async catalog(table,id){return categories.find(row=>row.id===id)??null;},
        async catalogInsert(table,request){const row={id:categories.length+1,code:request.code,name:request.name,description:request.description};categories.push(row);return row;},
        async catalogUpdate(table,request){const index=categories.findIndex(row=>row.id===request.id);const row={...categories[index],name:request.name,description:request.description};categories[index]=row;return row;},
        async events(filters,after,count) {return events.filter(e=>user===null||e.scope_type==='user'&&e.scope_id===user).filter(e=>!filters.source||e.source===filters.source).sort((a,b)=>b.id.localeCompare(a.id)).filter(e=>!after||e.id<after[2]).slice(0,count);}
      }); } catch(e){events=before;categories=beforeCategories;throw e;}
    },async ready(){}
  };
  return {core:createHistoryHandlers(store,{cursorKey}),get rows(){return events}};
}
const fault=code=>e=>e instanceof HistoryFault&&e.code===code;
test('UTC preserves microseconds and JSON own keys',()=>{
 assert.equal(normalizeTimestamp('2026-10-05T20:03:04.123456+02:00'),'2026-10-05T18:03:04.123456Z');
 assert.equal(normalizeTimestamp('2026-10-05T18:03:04Z'),'2026-10-05T18:03:04.000000Z');
 assert.equal(canonical(JSON.parse('{"__proto__":{"x":1},"b":2}')),'{"__proto__":{"x":1},"b":2}');
 assert.equal(canonical({x:{b:2,a:1}}),canonical({x:{a:1,b:2}}));
});
test('normalized redelivery returns original time and different payload conflicts',async()=>{
 const m=memory(),e=event();const a=await m.core.appendEvent({...e,data:JSON.parse('{"__proto__":{"k":2},"x":{"b":2,"a":1}}')});
 const b=await m.core.appendEvent({...e,id:e.id.toUpperCase(),occurred_at:'2026-10-05T18:03:04.123456Z',actor_id:null,object_type:null,object_id:null,data:JSON.parse('{"x":{"a":1,"b":2},"__proto__":{"k":2}}')});
 assert.deepEqual(a,b);assert.equal(m.rows.length,1);
 await assert.rejects(m.core.appendEvent({...e,data:{different:true}}),fault('EVENT_ID_CONFLICT'));
});
test('reserved audit object, input extras, NUL and event byte overflow rejected before storage',async()=>{
 const m=memory();for(const object_type of ['sys_categories','sys_types'])await assert.rejects(m.core.appendEvent({...event(),source:'service_history',object_type,object_id:'1'}),fault('INVALID_ARGUMENT'));
 await assert.rejects(m.core.appendEvent({...event(),unexpected:1}),fault('INVALID_ARGUMENT'));
 await assert.rejects(m.core.appendEvent({...event(),data:{x:'\0'}}),fault('INVALID_ARGUMENT'));
 await assert.rejects(m.core.appendEvent({...event(),data:{x:'x'.repeat(65536)}}),fault('REQUEST_TOO_LARGE'));
 assert.equal(m.rows.length,0);
});
test('HMAC binds tuple, normalized filters, scope; budget uses full envelope',async()=>{
 const m=memory();for(let i=0;i<4;i++)await m.core.appendEvent({...event(),data:{x:'x'.repeat(300)}});
 const page=await m.core.listForWeb({user_id:'user-a',limit:1});assert.equal(page.items.length,1);assert.ok(page.next_cursor);
 const [payload,signature]=page.next_cursor.split('.');const forged=JSON.parse(Buffer.from(payload,'base64url'));forged.position[2]=randomUUID();
 await assert.rejects(m.core.listForWeb({user_id:'user-a',cursor:Buffer.from(JSON.stringify(forged)).toString('base64url')+'.'+signature}),fault('INVALID_CURSOR'));
 await assert.rejects(m.core.listForWeb({user_id:'user-b',cursor:page.next_cursor}),fault('INVALID_CURSOR'));
 await assert.rejects(m.core.listForWeb({user_id:'user-a',filters:{source:'other'},cursor:page.next_cursor}),fault('INVALID_CURSOR'));
 const context={deadlineAt:performance.now()+1000,signal:new AbortController().signal,responseBudgetBytes:1100};
 const tiny=await m.core.listForWeb({user_id:'user-a',limit:4},context);assert.ok(tiny.items.length<4);assert.ok(Buffer.byteLength(JSON.stringify(tiny))<=1100);
 await assert.rejects(m.core.listForWeb({user_id:'user-a'},{...context,responseBudgetBytes:10}),fault('RESULT_TOO_LARGE'));
});

test('catalog replay validates complete audit and returns original result after update',async()=>{
 const m=memory();const request={event_id:randomUUID(),code:'custom',name:'Имя',description:''};
 const original=await m.core.categoryCreate(request);
 assert.equal(original.audit_event.data.operation,'history_category_create');assert.equal(original.audit_event.data.request.actor_id,null);assert.equal(original.audit_event.data.old,null);
 await m.core.categoryUpdate({event_id:randomUUID(),id:original.result.id,name:'Новое',description:'позднее'});
 assert.deepEqual(await m.core.categoryCreate({...request,actor_id:null}),original);
 for(const [field,value] of [['scope_type','user'],['scope_id','wrong'],['type_id',102],['object_type','sys_types'],['object_id','99'],['actor_id','wrong']]){
  const row=m.rows.find(e=>e.id===request.event_id);const saved=row[field];row[field]=value;
  await assert.rejects(m.core.categoryCreate(request),fault('EVENT_ID_CONFLICT'));m.rows.find(e=>e.id===request.event_id)[field]=saved;
 }
 m.rows.find(e=>e.id===request.event_id).data.new={...original.result,id:999};await assert.rejects(m.core.categoryCreate(request),fault('EVENT_ID_CONFLICT'));
});
