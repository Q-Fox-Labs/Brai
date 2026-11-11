// ABOUTME: Проверяет локальные индексы, точную группировку и ручные решения на PostgreSQL.
// ABOUTME: Работает только с отдельной loopback fixture и синтетическим новым scope каждого запуска.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../dist/migrate.js';
import {createStore} from '../../dist/storage.js';
import {createSystemStore} from '../../dist/system-store.js';
import {invokeSystem} from '../../dist/system-contracts.js';

function url(role){
 const raw=process.env['BUG_HUNT_TEST_'+role.toUpperCase()+'_URL']??'postgresql://bug_hunt_'+role+':fixture-'+role+'@127.0.0.1:18585/brai_bug_hunt_test';
 const value=new URL(raw);
 if(value.hostname!=='127.0.0.1'||value.pathname!=='/brai_bug_hunt_test'||value.username!=='bug_hunt_'+role)throw Error('Dedicated fixture required');
 return raw;
}
const owner=new Pool({connectionString:url('owner'),max:2,connectionTimeoutMillis:2000});
const app=new Pool({connectionString:url('app'),max:8,connectionTimeoutMillis:2000});
const installationId='system-fixture-'+randomUUID();
const options={installationId,cursorKey:'fixture-scope-cursor-key-32-characters',maxReports:10000,reportsPerMinute:1000};
const legacy=createStore(app,options),store=createSystemStore(app,options);
const a={ownerId:'a',actorId:'codex:a',source:'codex',reviewer:false};
const b={ownerId:'b',actorId:'codex:b',source:'codex',reviewer:false};
const reviewer={ownerId:'reviewer',actorId:'web:reviewer',source:'web',reviewer:true};
const observation={title:'Сохранение настроек',operation:'save',component_id:'fixture-component',component_version:'1.0.0',expected:'Настройки сохранены',observed:'Настройки исчезают после перезапуска',error_code:'E_FIXTURE_100',diagnostic_text:'literal%_\\path уникальнаядиагностика'};
const report=async(p=a,extra={})=>legacy.report(p,{request_id:randomUUID(),observation:{...observation,...extra}},async()=>{});
const call=(operation,p,input)=>invokeSystem(store,operation,p,input);
const fault=code=>error=>error.code===code;
const revisions=async ids=>(await owner.query('SELECT id AS group_id,revision FROM observation_group WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows;
const member=async caseId=>(await owner.query('SELECT group_id FROM group_membership WHERE installation_id=$1 AND case_id=$2',[installationId,caseId])).rows[0]?.group_id;
test('systematization SQL acceptance',async t=>{
 try{
  await migrate(owner,'bug_hunt_owner','bug_hunt_app');
  await migrate(owner,'bug_hunt_owner','bug_hunt_app');
  await t.test('additive migration preserves legacy and future grants; runtime cannot rewrite audit',async()=>{
   assert.equal((await owner.query('SELECT version FROM sys_schema WHERE version=1')).rowCount,1);
   for(const table of ['report','review','mutation','v2_mutation','group_audit','grouping_decision','classification','classification_override']){
    await assert.rejects(app.query('UPDATE '+table+' SET '+(table==='report'?'observation=observation':table==='review'?'explanation=explanation':table==='mutation'||table==='v2_mutation'?'result=result':table==='classification'?'payload=payload':'explanation=explanation')),e=>e.code==='42501');
    await assert.rejects(app.query('DELETE FROM '+table),e=>e.code==='42501');
   }
   await assert.rejects(app.query('CREATE TEMP TABLE forbidden_system(id int)'),e=>e.code==='42501');
   const missing=await owner.query("SELECT count(*)::int AS n FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid WHERE c.relname IN ('sys_capability','search_document','report_signature','observation_group','group_membership','grouping_decision','group_audit','similarity_proposal','classification','classification_override','v2_mutation') AND c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped AND col_description(c.oid,a.attnum) IS NULL");
   assert.equal(missing.rows[0].n,0);
   await owner.query('CREATE TABLE IF NOT EXISTS fixture_future_grant(id int)');
   await owner.query('GRANT SELECT ON fixture_future_grant TO bug_hunt_app');
   await migrate(owner,'bug_hunt_owner','bug_hunt_app');
   await app.query('SELECT id FROM fixture_future_grant LIMIT 0');
  });
  const originals=await Promise.all(Array.from({length:6},()=>report()));
  const foreign=await report(b);
  let group;
  await t.test('concurrent idempotent local processing keeps one scoped exact group and v1 IDs',async()=>{
   await Promise.all(originals.flatMap(r=>[store.indexReport(r.report_id),store.indexReport(r.report_id)]));
   await store.indexReport(foreign.report_id);
   const memberships=await owner.query('SELECT distinct group_id FROM group_membership WHERE installation_id=$1 AND owner_id=$2',[installationId,a.ownerId]);
   assert.equal(memberships.rowCount,1);group=memberships.rows[0].group_id;
   assert.notEqual(await member(foreign.case_id),group);
   const card=await legacy.get(a,{case_id:originals[0].case_id});
   assert.deepEqual(card.report.observation,observation);assert.equal(card.case.revision,1);assert.equal(card.case.verification_status,'unverified');
   assert.equal((await call('groups-get',a,{group_id:group})).group.member_count,6);
  });
  await t.test('reviewer target reads preserve ordinary owner scope',async()=>{
   assert.equal((await call('enrichment',reviewer,{case_id:originals[0].case_id})).local.group_id,group);
   const detail=await call('groups-get',reviewer,{group_id:group});assert.equal(detail.group.member_count,6);assert.equal('scope_owner' in detail.group,false);
   assert.ok((await call('groups-list',reviewer,{case_id:originals[0].case_id})).items.some(row=>row.id===group));
   for(const [op,input] of [['enrichment',{case_id:originals[0].case_id}],['groups-get',{group_id:group}],['groups-list',{case_id:originals[0].case_id}]])await assert.rejects(call(op,b,input),fault('NOT_FOUND'));
  });
  await t.test('complete corpus text search, literal wildcard escaping, Cyrillic morphology and owner isolation',async()=>{
   for(const query of ['E_FIXTURE_100','literal%_\\path','уникальнаядиагностика','настройки','настройка']){
    const result=await call('search',a,{query,limit:2});assert.equal(result.items.length,2);assert.equal(result.coverage.total_reports,6);assert.equal(result.coverage.state,'complete');assert.ok(result.has_more);
   }
   assert.equal((await call('search',a,{query:'absent%_'})).items.length,0);
   assert.equal((await call('search',a,{query:'настройка'})).items[0].method,'full_text');
   const first=await call('search',a,{query:'настройки',limit:2}),ids=[...first.items.map(r=>r.case_id)];
   let cursor=first.next_cursor;
   do{const next=await call('search',a,{query:'настройки',limit:2,cursor});ids.push(...next.items.map(r=>r.case_id));cursor=next.next_cursor;}while(cursor);
   assert.equal(ids.length,6);assert.equal(new Set(ids).size,6);
   for(const [p,input] of [[b,{query:'настройки',cursor:first.next_cursor}],[a,{query:'исчезают',cursor:first.next_cursor}],[a,{query:'настройки',cursor:first.next_cursor,filters:{error_code:'E_FIXTURE_100'}}]]){
    await assert.rejects(call('search',p,input),fault('INVALID_ARGUMENT'));
   }
   assert.equal((await call('search',reviewer,{query:'настройки'})).items.length,0);
   await assert.rejects(call('groups-get',b,{group_id:group}),fault('NOT_FOUND'));
   const missing=await report(a,{component_version:'2.0.0',diagnostic_text:'unindexed-old'});
   const pending=await call('search',a,{query:'unindexed-old'});assert.equal(pending.coverage.state,'partial');assert.equal(pending.coverage.total_reports,7);
   await owner.query("UPDATE bug_case SET registered_at='2001-01-01' WHERE id=$1",[missing.case_id]);
   await owner.query("UPDATE report SET registered_at='2001-01-01' WHERE id=$1",[missing.report_id]);
   assert.equal(await store.reconcileLocal(),1);assert.equal((await call('search',a,{query:'unindexed-old'})).items[0].case_id,missing.case_id);
  });
  await t.test('manual split is atomic, reviewer cross-owner mutation stays one scope, replay preserves receipt',async()=>{
   const before=await call('groups-get',a,{group_id:group,limit:1});
   const command={request_id:randomUUID(),case_ids:[originals[0].case_id],expected_revisions:await revisions([group]),explanation:'Отделить иной контекст'};
   const results=await Promise.all([call('membership-update',reviewer,command),call('membership-update',reviewer,command)]);
   assert.equal(results.filter(r=>r.replayed).length,1);const accepted=results[0];assert.notEqual(accepted.group_id,group);
   assert.equal((await call('enrichment',a,{case_id:originals[0].case_id})).local.excluded_from_auto,true);
   await assert.rejects(call('groups-get',a,{group_id:group,cursor:before.next_cursor}),fault('CURSOR_STALE'));
   await Promise.all(originals.map(r=>store.indexReport(r.report_id)));
   assert.equal(await member(originals[0].case_id),accepted.group_id);
   // AIDEV-NOTE: Даже пересоздание производного членства не отменяет сохранённое ручное исключение.
   await owner.query('DELETE FROM group_membership WHERE installation_id=$1 AND owner_id=$2 AND case_id=$3',[installationId,a.ownerId,originals[0].case_id]);
   await store.indexReport(originals[0].report_id);assert.equal(await member(originals[0].case_id),undefined);
   await app.query("INSERT INTO group_membership(installation_id,owner_id,case_id,group_id,method) VALUES($1,$2,$3,$4,'manual')",[installationId,a.ownerId,originals[0].case_id,accepted.group_id]);
   await assert.rejects(call('membership-update',reviewer,{...command,explanation:'Другая команда'}),fault('IDEMPOTENCY_CONFLICT'));
   await assert.rejects(call('membership-update',reviewer,{request_id:randomUUID(),case_ids:[originals[1].case_id,foreign.case_id],expected_revisions:await revisions([group]),explanation:'Недопустимая общая группа'}),fault('NOT_FOUND'));
   assert.equal(await member(originals[1].case_id),group);
   const competing=()=>({request_id:randomUUID(),case_ids:[originals[1].case_id],expected_revisions:[],explanation:'Конкурент'});
   const expected=await revisions([group]),r1={...competing(),expected_revisions:expected},r2={...competing(),expected_revisions:expected};
   const competition=await Promise.allSettled([call('membership-update',reviewer,r1),call('membership-update',reviewer,r2)]);
   assert.equal(competition.filter(r=>r.status==='fulfilled').length,1);
   assert.equal(competition.filter(r=>r.status==='rejected'&&r.reason.code==='REVISION_CONFLICT').length,1);
   await assert.rejects(call('membership-update',a,command),fault('FORBIDDEN'));
  });
  await t.test('group audit is bounded, scoped, immutable and paginates independently of members',async()=>{
   const first=await call('groups-get',a,{group_id:group,limit:1,history_limit:2});
   assert.equal(first.history.items.length,2);assert.ok(first.history.next_cursor);
   let cursor=first.history.next_cursor,ids=first.history.items.map(r=>r.id);
   for(const row of first.history.items){assert.equal(row.new_revision,row.old_revision+1);assert.ok(row.explanation);}
   do{const page=await call('groups-get',a,{group_id:group,limit:1,history_limit:2,history_cursor:cursor});ids.push(...page.history.items.map(r=>r.id));cursor=page.history.next_cursor;}while(cursor);
   assert.equal(ids.length,new Set(ids).size);assert.ok(ids.length>=8);
   const other=await member(foreign.case_id);
   await assert.rejects(call('groups-get',b,{group_id:other,history_cursor:first.history.next_cursor}),fault('INVALID_ARGUMENT'));
  });
  await t.test('unknown context, evidence order and version changes cannot autojoin',async()=>{
   const unknown=await report(a,{component_id:'unknown'}),unknownVersion=await report(a,{component_version:null}),evidence=await report(a,{evidence_artifact_ids:[randomUUID()]});
   for(const r of [unknown,unknownVersion,evidence])await store.indexReport(r.report_id);
   assert.equal(await member(unknown.case_id),undefined);assert.equal(await member(unknownVersion.case_id),undefined);assert.notEqual(await member(evidence.case_id),group);
   await assert.rejects(call('similar',a,{case_id:unknown.case_id}),fault('INDEX_NOT_READY'));
  });
  await t.test('manual labels are independent, immutable, replayable and survive reprocessing',async()=>{
   const command={request_id:randomUUID(),case_id:originals[0].case_id,expected_revision:0,labels:{suspected_type:'configuration',suspected_impact:'low'},explanation:'Проверяющий уточнил метки'};
   const first=await call('classification-override',reviewer,command);
   assert.equal(first.revision,1);assert.equal((await call('classification-override',reviewer,command)).replayed,true);
   await store.indexReport(originals[0].report_id);
   assert.deepEqual((await call('enrichment',a,{case_id:command.case_id})).override.labels,command.labels);
   assert.equal((await legacy.get(a,{case_id:command.case_id})).case.review_state,'new');
   await assert.rejects(call('classification-override',reviewer,{...command,request_id:randomUUID()}),fault('REVISION_CONFLICT'));
  });
  await t.test('manual proposal acceptance groups atomically, rejection persists without rewriting v1',async()=>{
   const p1=await report(a,{component_version:'proposal-a'}),p2=await report(a,{component_version:'proposal-b'});
   await Promise.all([store.indexReport(p1.report_id),store.indexReport(p2.report_id)]);
   const ids=[await member(p1.case_id),await member(p2.case_id)],proposal=randomUUID();
   await app.query("INSERT INTO similarity_proposal(id,installation_id,owner_id,case_id,candidate_case_id,generation,method,score) VALUES($1,$2,$3,$4,$5,$6,'cosine',0.8)",[proposal,installationId,a.ownerId,p1.case_id,p2.case_id,'gemma2-symmetric-v1']);
   const input={request_id:randomUUID(),proposal_id:proposal,decision:'accepted',expected_revisions:await revisions(ids),explanation:'Объединено вручную'};
   const accepted=await call('proposal-resolve',reviewer,input);
   assert.equal(await member(p1.case_id),accepted.group_id);assert.equal(await member(p2.case_id),accepted.group_id);
   assert.equal((await call('proposal-resolve',reviewer,input)).replayed,true);
   const reject=randomUUID();
   await app.query("INSERT INTO similarity_proposal(id,installation_id,owner_id,case_id,candidate_case_id,generation,method,score) VALUES($1,$2,$3,$4,$5,$6,'cosine',0.7)",[reject,installationId,a.ownerId,p1.case_id,originals[0].case_id,'gemma2-symmetric-v1']);
   const rejection=await call('proposal-resolve',reviewer,{request_id:randomUUID(),proposal_id:reject,decision:'rejected',expected_revisions:[],explanation:'Разные проявления'});
   assert.equal(rejection.state,'rejected');
  });

  await t.test('signature hash collision cannot group different canonical text; scope FK rejects a foreign report',async()=>{
   const candidate=await report(a,{component_version:'collision-fixture'});
   const {exactSignature}=await import('../../dist/projection.js');
   const signature=exactSignature(installationId,a.ownerId,{...observation,component_version:'collision-fixture'});
   await owner.query('INSERT INTO observation_group(id,installation_id,owner_id,signature_hash,signature_canonical) VALUES($1,$2,$3,$4,$5)',[randomUUID(),installationId,a.ownerId,signature.hash,'different canonical input']);
   await store.indexReport(candidate.report_id);assert.equal(await member(candidate.case_id),undefined);
   await assert.rejects(app.query("INSERT INTO report_signature(installation_id,owner_id,report_id,case_id,algorithm_version) VALUES($1,$2,$3,$4,'foreign-fixture')",[installationId,a.ownerId,foreign.report_id,originals[0].case_id]),e=>e.code==='23503');
  });
  await t.test('pending proposals are limited per case and generation; rejected rows keep their history',async()=>{
   const source=await report(a,{component_version:'proposal-limit'}),targets=await Promise.all(Array.from({length:21},(_,i)=>report(a,{component_version:'limit-'+i})));
   const insert=async(i,generation='limit-fixture')=>app.query("INSERT INTO similarity_proposal(id,installation_id,owner_id,case_id,candidate_case_id,generation,method,score) VALUES($1,$2,$3,$4,$5,$6,'cosine',0.5)",[randomUUID(),installationId,a.ownerId,source.case_id,targets[i].case_id,generation]);
   for(let i=0;i<20;i++)await insert(i);
   await assert.rejects(insert(20),e=>e.code==='23514');
   await insert(20,'other-generation');
   assert.equal((await app.query("SELECT count(*)::int AS n FROM similarity_proposal WHERE installation_id=$1 AND case_id=$2 AND generation='limit-fixture' AND state='pending'",[installationId,source.case_id])).rows[0].n,20);
  });
  await t.test('all-or-nothing failed manual mutation and byte capacity allow accepted replay',async()=>{
   const caseId=originals[2].case_id,command={request_id:randomUUID(),case_ids:[caseId],expected_revisions:await revisions([group]),explanation:'reject-local'};
   await owner.query("CREATE OR REPLACE FUNCTION reject_fixture_group_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.explanation='reject-local' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$");
   await owner.query('CREATE TRIGGER reject_fixture_group_audit BEFORE INSERT ON group_audit FOR EACH ROW EXECUTE FUNCTION reject_fixture_group_audit()');
   try{await assert.rejects(call('membership-update',reviewer,command),fault('DATABASE_UNAVAILABLE'));assert.equal(await member(caseId),group);assert.deepEqual(await revisions([group]),command.expected_revisions);}
   finally{await owner.query('DROP TRIGGER reject_fixture_group_audit ON group_audit');await owner.query('DROP FUNCTION reject_fixture_group_audit()');}
   const receipt=await call('membership-update',reviewer,command);
   const full=createSystemStore(app,{...options,maxDatabaseBytes:1});
   assert.equal((await invokeSystem(full,'membership-update',reviewer,command)).group_id,receipt.group_id);
   await assert.rejects(invokeSystem(full,'membership-update',reviewer,{...command,request_id:randomUUID()}),fault('BUSY'));
   while(await store.reconcileLocal()){}
   assert.equal(await store.reconcileLocal(),0);
  });
 }finally{await Promise.all([owner.end(),app.end()]);}
});
