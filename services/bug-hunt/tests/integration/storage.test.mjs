// ABOUTME: Проверяет атомарность, повторы и изоляцию bug-hunt на настоящем PostgreSQL.
// ABOUTME: Допускает только собственную loopback БД brai_bug_hunt_test и синтетические роли.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../../../../tmp/bug-hunt-test.json',import.meta.url),'utf8'));
import {migrate} from '../../dist/migrate.js';
import {createStore} from '../../dist/storage.js';
import {createHandlers} from '../../dist/domain.js';
const urls=['OWNER','APP'].map(role=>{
 const raw=process.env['BUG_HUNT_TEST_'+role+'_URL']??fixture[role.toLowerCase()+'URL'];if(!raw)throw new Error('Explicit fixture URL required');
 const url=new URL(raw);if(url.hostname!=='127.0.0.1'||url.pathname!=='/brai_bug_hunt_test')throw new Error('Only dedicated loopback fixture permitted');return raw;
});
const owner=new Pool({connectionString:urls[0],max:3,connectionTimeoutMillis:2000});
const app=new Pool({connectionString:urls[1],max:8,connectionTimeoutMillis:2000,statement_timeout:7000});
const options={installationId:'fixture-installation',cursorKey:'fixture-cursor-key-at-least-32-bytes',maxReports:1000,reportsPerMinute:1000,evidence:async()=>{}};
const store=createStore(app,options);
const core=createHandlers({store,evidence:options.evidence});
const a={ownerId:'fixture-a',actorId:'codex:fixture-a',source:'codex',reviewer:false};
const b={ownerId:'fixture-b',actorId:'hermes:fixture-b',source:'hermes',reviewer:false};
const admin={ownerId:'fixture-admin',actorId:'web:fixture-admin',source:'web',reviewer:true};
const observation={title:'<img src=x onerror=alert(1)>',operation:'read',expected:'Данные сохранены',observed:"'; DROP TABLE report; --"};
const request=()=>({request_id:randomUUID(),observation:{...observation}});
const invoke=(op,p,input,operator=false)=>core.invoke(op,p,input,operator);
const fault=code=>e=>e.code===code;
test('real PostgreSQL acceptance',async t=>{
 try{
  await migrate(owner,'bug_hunt_owner','bug_hunt_app');await migrate(owner,'bug_hunt_owner','bug_hunt_app');
  await t.test('runtime cannot overwrite observations, receipts, audit, titles or execute DDL',async()=>{
   for(const sql of ['DELETE FROM report','UPDATE report SET observation=observation','DELETE FROM mutation','UPDATE mutation SET result=result','UPDATE review SET explanation=explanation','UPDATE bug_case SET title=title','CREATE TABLE forbidden(id int)','CREATE TEMP TABLE forbidden_temp(id int)','TRUNCATE report']){
    await assert.rejects(app.query(sql),e=>e.code==='42501');
   }
   const missing=await owner.query("SELECT count(*)::int AS n FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relname IN ('bug_case','report','review','mutation','sys_schema') AND c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped AND col_description(c.oid,a.attnum) IS NULL");
   assert.equal(missing.rows[0].n,0);
  });
  const input=request();let first;
  await t.test('concurrent retry creates one report and one case, preserves exact text',async()=>{
   const results=await Promise.all(Array.from({length:8},()=>invoke('report',a,input)));
   first=results[0];assert.equal(results.filter(r=>!r.replayed).length,1);
   assert.equal(new Set(results.map(r=>r.case_id)).size,1);assert.equal(new Set(results.map(r=>r.report_id)).size,1);
   const card=await invoke('get',a,{case_id:first.case_id});assert.deepEqual(card.report.observation,input.observation);
   assert.equal(card.case.verification_status,'unverified');
   await assert.rejects(invoke('report',a,{...input,observation:{...input.observation,title:'Changed'}}),fault('IDEMPOTENCY_CONFLICT'));
   assert.notEqual((await invoke('report',a,request())).case_id,first.case_id);
  });
  await t.test('foreign and missing IDs are indistinguishable; forbidden owner is not accepted',async()=>{
   await assert.rejects(invoke('get',b,{case_id:first.case_id}),fault('NOT_FOUND'));
   await assert.rejects(invoke('get',b,{case_id:randomUUID()}),fault('NOT_FOUND'));
   await assert.rejects(invoke('report',b,{...request(),owner_id:a.ownerId}),fault('INVALID_ARGUMENT'));
   assert.equal((await invoke('list',b,{})).items.length,0);
   assert.ok((await invoke('list',admin,{},true)).items.some(r=>r.id===first.case_id));
  });
  let review;
  await t.test('concurrent reviewers produce one transition and one revision conflict',async()=>{
   const base={case_id:first.case_id,expected_revision:1,review_state:'triaged',explanation:'Ручной первичный разбор'};
   const r1={...base,request_id:randomUUID()},r2={...base,request_id:randomUUID(),explanation:'Второй проверяющий'};
   const results=await Promise.allSettled([invoke('review',admin,r1),invoke('review',{...admin,actorId:'web:reviewer-b'},r2)]);
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='REVISION_CONFLICT').length,1);
   review=results[0].status==='fulfilled'?{principal:admin,input:r1}:{principal:{...admin,actorId:'web:reviewer-b'},input:r2};
   const retry=await invoke('review',review.principal,review.input);assert.equal(retry.replayed,true);assert.equal(retry.revision,2);
   const card=await invoke('get',admin,{case_id:first.case_id});assert.equal(card.reviews.items.length,1);
   const replay=await invoke('report',a,input);assert.equal(replay.case_id,first.case_id);assert.equal(replay.review_state,'new');assert.equal(replay.replayed,true);
  });
  await t.test('archive/reopen keep observation, unverified and paginated immutable audit',async()=>{
   let revision=2;
   for(let i=0;i<6;i++){const state=i%2?'new':'archived';await invoke('review',admin,{request_id:randomUUID(),case_id:first.case_id,expected_revision:revision++,review_state:state,explanation:'Synthetic decision '+i});}
   let cursor,ids=[];do{const page=await invoke('get',a,{case_id:first.case_id,limit:2,...(cursor?{cursor}:{})});ids.push(...page.reviews.items.map(r=>r.id));cursor=page.reviews.next_cursor;assert.equal(page.case.verification_status,'unverified');assert.deepEqual(page.report.observation,input.observation);}while(cursor);
   assert.equal(ids.length,7);assert.equal(new Set(ids).size,7);
  });
  await t.test('case/report/receipt rollback together before commit',async()=>{
   await owner.query("CREATE OR REPLACE FUNCTION reject_fixture_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.observation->>'title'='reject-fixture' THEN RAISE EXCEPTION 'fixture reject'; END IF; RETURN NEW; END $$");
   await owner.query('CREATE TRIGGER reject_fixture_report BEFORE INSERT ON report FOR EACH ROW EXECUTE FUNCTION reject_fixture_report()');
   const before=await owner.query('SELECT count(*)::int AS n FROM bug_case'),bad={...request(),observation:{...observation,title:'reject-fixture'}};
   try{await assert.rejects(invoke('report',a,bad),e=>e.code==='DATABASE_UNAVAILABLE'&&e.outcome==='not_accepted');assert.equal((await owner.query('SELECT count(*)::int AS n FROM bug_case')).rows[0].n,before.rows[0].n);}
   finally{await owner.query('DROP TRIGGER reject_fixture_report ON report; DROP FUNCTION reject_fixture_report()');}
   assert.equal((await invoke('report',a,bad)).replayed,false);
  });
  await t.test('keyset pagination tolerates new inserts; cursor bound to owner and filters',async()=>{
   for(let i=0;i<5;i++)await invoke('report',a,request());
   const firstPage=await invoke('list',a,{limit:2});assert.ok(firstPage.next_cursor);
   await invoke('report',a,request());let cursor=firstPage.next_cursor,ids=firstPage.items.map(r=>r.id);
   do{const next=await invoke('list',a,{limit:2,cursor});ids.push(...next.items.map(r=>r.id));cursor=next.next_cursor;}while(cursor);
   assert.equal(ids.length,new Set(ids).size);
   await assert.rejects(invoke('list',b,{cursor:firstPage.next_cursor}),fault('INVALID_ARGUMENT'));
   await assert.rejects(invoke('list',a,{cursor:firstPage.next_cursor,filters:{component_id:'other'}}),fault('INVALID_ARGUMENT'));
  });
  await t.test('evidence is checked before first acceptance but not before replay',async()=>{
   let allowed=true,calls=0;
   const evidence=async()=>{calls++;if(!allowed)throw Object.assign(new Error(),{code:'not-the-public-fault'});};
   const s=createStore(app,options);
   const c=createHandlers({store:s,evidence});
   const r={...request(),observation:{...observation,evidence_artifact_ids:[randomUUID()]}};
   const result=await c.invoke('report',a,r);allowed=false;
   assert.equal((await c.invoke('report',a,r)).case_id,result.case_id);assert.equal(calls,1);
  });
  await t.test('new runtime pool keeps accepted receipts and review after restart',async()=>{
   const next=new Pool({connectionString:urls[1],max:1,connectionTimeoutMillis:2000});
   try{const restarted=createHandlers({store:createStore(next,options),evidence:async()=>{}});assert.equal((await restarted.invoke('report',a,input)).report_id,first.report_id);assert.equal((await restarted.invoke('get',admin,{case_id:first.case_id})).reviews.items.length,7);}
   finally{await next.end();}
  });
  await t.test('byte capacity blocks only new mutations and owner credentials fail readiness',async()=>{
   const c=createHandlers({store:createStore(app,{...options,maxDatabaseBytes:1}),evidence:async()=>{}});
   assert.equal((await c.invoke('report',a,input)).case_id,first.case_id);
   await assert.rejects(c.invoke('report',a,request()),fault('BUSY'));
   await assert.rejects(c.invoke('review',admin,{request_id:randomUUID(),case_id:first.case_id,expected_revision:8,review_state:'archived',explanation:'capacity'}),fault('BUSY'));
   await assert.rejects(createStore(owner,options).status(),fault('DATABASE_UNAVAILABLE'));
  });
  await t.test('capacity blocks new observations but preserves receipt replay',async()=>{
   const c=createHandlers({store:createStore(app,{...options,maxReports:1}),evidence:async()=>{}});
   assert.equal((await c.invoke('report',a,input)).case_id,first.case_id);
   await assert.rejects(c.invoke('report',a,request()),fault('BUSY'));
  });
 }finally{await Promise.all([owner.end(),app.end()]);}
});
