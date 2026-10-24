// ABOUTME: Проверяет атомарное применение принятого планировщика на настоящей БД game-core.
// ABOUTME: Human вызовы здесь — инженерная модель теста; живой доверенный web проверяется отдельно.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {spawnSync} from 'node:child_process';
import {createGameHandlers} from '../dist/game.js';
import {fixture} from './planning-fixture.mjs';

test('planning PostgreSQL: apply/replay/rollback, future outputs, retry, remarks and acceptance',{skip:!process.env.ELEMENTS_OWNER_DATABASE_URL||!process.env.ELEMENTS_DATABASE_URL},async()=>{
 const admin=new Pool({connectionString:process.env.ELEMENTS_OWNER_DATABASE_URL}),app=new Pool({connectionString:process.env.ELEMENTS_DATABASE_URL});
 const owner=`planning-test-${randomUUID()}`,h=createGameHandlers(app,{}),req=v=>({user_id:owner,...v});
 async function prepare(){
  const f=fixture();
  const created=await h.structureCreate(req({elements:[{id:f.element.id,kind:'task',title:'TEST планировщик',initial_resources:[{id:f.resource.id,title:f.resource.title,content:f.resource.content}]}],moves:[{id:f.move.id,element_id:f.element.id,kind:'operation',purpose:'plan',title:f.move.title}]}));
  const a=(await h.moveClaim(req({move_id:f.move.id,idempotency_key:randomUUID(),executor_kind:'agent',input_resource_ids:[f.resource.id]}))).attempt;
  const packet=await h.planningPacket(req({attempt_id:a.id}));
  const baseline={...f.criteria,inputs:Object.fromEntries(Object.entries(packet.files).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')]))};
  const diagnostic=spawnSync('/usr/bin/python3',['services/elements/planning/runner.py'],{input:JSON.stringify({files:packet.files,baseline,candidate:f.candidate}),encoding:'utf8'});
  assert.equal(diagnostic.status,0,diagnostic.stdout+diagnostic.stderr);
  // Отклонённая цитата не завершает попытку и не фиксирует ошибочный baseline.
  const invalid=structuredClone(baseline);invalid.requirements[0].quote='TEST цитата вне исходного поручения';
  const beforeRejected=await h.graphGet(req({}));
  await assert.rejects(()=>h.planningBind(req({attempt_id:a.id,baseline:invalid})),error=>{
   assert.equal(error.code,'INVALID_ARGUMENT');
   assert.deepEqual(error.diagnostic,{phase:'bind',reason:'Нет основания требования'});
   return true;
  });
  const afterRejected=await h.graphGet(req({}));
  assert.deepEqual(afterRejected,beforeRejected);
  assert.equal(afterRejected.attempts.find(item=>item.id===a.id).status,'running');
  await h.planningBind(req({attempt_id:a.id,baseline}));
  const built=await h.planningBuild(req({attempt_id:a.id,candidate:f.candidate}));
  const review={baseline_sha256:built.baseline_sha256,candidate_sha256:built.candidate_sha256,verdict:'accept',coverage:[{requirement:'word',items:['upper']},{requirement:'signal',items:['signal']}],errors:[],notes:[]};
  return {...f,a,baseline,built,review,apply:req({attempt_id:a.id,candidate_sha256:built.candidate_sha256,review}),sourceRevision:created.elements[0].revision};
 }
 async function graph(){return h.graphGet(req({}));}
 async function take(mid,executor='agent',key=randomUUID()){
  const available=(await h.movesAvailable(req({}))).items.find(m=>m.id===mid);
  return (await h.moveClaim(req({move_id:mid,idempotency_key:key,executor_kind:executor,input_resource_ids:available?.required_resource_ids??[]}))).attempt;
 }
 async function done(mid,content,decision){
  const g=await graph(),m=g.moves.find(m=>m.id===mid),a=await take(mid,decision?'human':'agent');
  const outputs=m.fields.planning.output_contracts;
  return h.moveComplete(req({attempt_id:a.id,result:{resources:outputs.map(o=>({output_key:o.key,title:o.name,content,metadata:decision?{element_id:m.targetId,revision_id:g.elements.find(e=>e.id===m.targetId).revision,...decision}:{}}))}}));
 }
 const counts=async()=>{const g=await graph();return [g.elements.length,g.revisions.length,g.moves.length,g.resources.length,g.attempts.length];};
 try{
  const f=await prepare();
  await assert.rejects(()=>h.planningBind(req({attempt_id:f.a.id,baseline:{...f.baseline,requirements:[]}})),/CONFLICT/);
  const first=await h.planningApply(f.apply),snapshot=await counts();
  assert.deepEqual(await h.planningApply(f.apply),first);assert.deepEqual(await counts(),snapshot);
  await assert.rejects(()=>h.planningApply({...f.apply,candidate_sha256:'0'.repeat(64)}),/CONFLICT/);
  const initial=await graph();assert.equal(initial.resources.length,2);assert.equal(initial.moves.find(m=>m.id===f.move.id).status,'succeeded');
  assert.equal(initial.moves.filter(m=>m.targetId===f.element.id).length,6);
  assert.ok(!initial.resources.some(r=>f.built.stage.resources.some(e=>e.state==='expected'&&e.id===r.id)));
  const [confirm,work,consumer,review,finish]=f.built.stage.records.map(m=>m.id);
  await assert.rejects(()=>take(work),/INVALID_STATE/);
  await assert.rejects(()=>take(consumer),/INVALID_STATE/);
  await done(confirm,'TEST Игрок прочитал и подтвердил точную постановку.',{stage:'planning',outcome:'approved'});
  const failed=await take(work);await h.moveFail(req({attempt_id:failed.id,error_code:'TEST_TECHNICAL_FAILURE'}));
  const retried=await take(work);assert.notEqual(retried.id,failed.id);
  await assert.rejects(()=>h.moveComplete(req({attempt_id:retried.id,result:{resources:[]}})),/INVALID_ARGUMENT/);
  const workCard=(await graph()).moves.find(m=>m.id===work);
  const upper=(await h.moveComplete(req({attempt_id:retried.id,result:{resources:[{output_key:workCard.fields.planning.output_contracts[0].key,title:'TEST Прописное слово',content:'МАЯК'}]}}))).output[0];
  const ready=(await h.movesAvailable(req({}))).items.find(m=>m.id===consumer);assert.ok(ready.required_resource_ids.includes(upper));assert.ok(!ready.required_resource_ids.includes(f.resource.id));
  await done(consumer,'«Сигнал: МАЯК»');
  const before=(await graph()).moves.length;
  const changes=await done(review,'TEST замечание: сохранить строку без кавычек.',{stage:'review',outcome:'changes'});
  const changed=await graph();assert.equal(changed.moves.length,before+2);
  await h.moveComplete(req({attempt_id:changes.attempt.id,result:{resources:[]}}));assert.equal((await graph()).moves.length,before+2);
  assert.equal(changed.moves.find(m=>m.id===finish).ownerId,f.element.id);
  await assert.rejects(()=>take(finish),/INVALID_STATE/);
  const fix=changed.moves.find(m=>m.previousId===review),reconsider=changed.moves.find(m=>m.previousId===fix.id);
  await done(fix.id,'Сигнал: МАЯК');
  await done(reconsider.id,'TEST Игрок проверил точную строку без кавычек.',{stage:'final',outcome:'success'});
  await done(finish,'Сигнал: МАЯК');
  const reloaded=await createGameHandlers(app,{}).graphGet(req({}));
  assert.equal(reloaded.elements.find(e=>e.id===f.element.id).status,'completed');
  assert.equal(reloaded.elements.find(e=>e.id===f.element.id).output.length,1);
  assert.equal(reloaded.attempts.filter(a=>a.moveId===work).length,2);
  assert.ok((await admin.query("SELECT 1 FROM game_core.outbox WHERE owner_id=$1 AND event_type='plan.applied'",[owner])).rowCount);
  // Текстовые замечания к постановке: новая Операция и новая ревизия, без запуска старого плана.
  const draft=await prepare();await h.planningApply(draft.apply);
  const originalRecords=draft.built.stage.records;
  const confirmDraft=originalRecords.find(m=>m.purpose==='confirm');
  await done(confirmDraft.id,'TEST: сохрани исходный итог, уточни инструкцию.',{stage:'review',outcome:'changes'});
  const afterRemarks=await graph(),replan=afterRemarks.moves.find(m=>m.previousId===confirmDraft.id&&m.purpose==='plan');
  assert.ok(replan);
  for(const record of originalRecords.filter(m=>m.purpose==='work'||m.purpose==='review'))assert.equal(afterRemarks.moves.find(m=>m.id===record.id).status,'cancelled');
  const attempt=await take(replan.id),packet=await h.planningPacket(req({attempt_id:attempt.id}));
  const criteria={...draft.baseline,inputs:Object.fromEntries(Object.entries(packet.files).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')]))};
  assert.ok(Object.values(packet.files).some(text=>text.includes('TEST: сохрани исходный итог')));
  await h.planningBind(req({attempt_id:attempt.id,baseline:criteria}));
  const revised=await h.planningBuild(req({attempt_id:attempt.id,candidate:{...draft.candidate,fields:{...draft.candidate.fields,inputs:JSON.parse(packet.files['packet.json']).draft.inputs}}}));
  await h.planningApply(req({attempt_id:attempt.id,candidate_sha256:revised.candidate_sha256,review:{...draft.review,baseline_sha256:revised.baseline_sha256,candidate_sha256:revised.candidate_sha256}}));
  const revisedGraph=await graph();assert.notEqual(revisedGraph.elements.find(e=>e.id===draft.element.id).revision,afterRemarks.elements.find(e=>e.id===draft.element.id).revision);
  const newConfirm=revised.stage.records.find(m=>m.purpose==='confirm');
  assert.ok((await h.movesAvailable(req({}))).items.some(m=>m.id===newConfirm.id));
  assert.ok(!(await h.movesAvailable(req({}))).items.some(m=>m.id===revised.stage.records.find(m=>m.purpose==='work').id));
  await done(newConfirm.id,'TEST новая постановка принята.',{stage:'planning',outcome:'approved'});
  assert.ok((await h.movesAvailable(req({}))).items.some(m=>m.id===revised.stage.records.find(m=>m.purpose==='work').id));
  // Конфликт возникает после создания ревизии/confirm: транзакция обязана откатить обе записи.
  const rollback=await prepare();const collision=rollback.built.stage.symbols.uppercase;
  const other=await h.elementCreate(req({kind:'goal',title:'TEST collision boundary'}));
  await h.moveCreate(req({id:collision,element_id:other.id,kind:'operation',purpose:'work',title:'TEST occupied ID'}));
  const beforeRollback=await counts();await assert.rejects(()=>h.planningApply(rollback.apply),/CONFLICT/);assert.deepEqual(await counts(),beforeRollback);
  assert.equal((await graph()).elements.find(e=>e.id===rollback.element.id).revision,rollback.sourceRevision);
  // Изменённая ревизия не может получить устаревший план.
  const stale=await prepare();await h.elementRevise(req({element_id:stale.element.id,revision_id:randomUUID(),title:'TEST changed draft'}));
  await assert.rejects(()=>h.planningApply(stale.apply),/CONFLICT/);
  await assert.rejects(()=>h.planningPacket({user_id:owner+'-foreign',attempt_id:stale.a.id}),/NOT_FOUND/);
  console.log('planning owner transaction: idempotency, rollback, stale revision, future resources, exact attempts and dynamic remarks passed');
 }finally{
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['outbox','element_resources','attempt_resources','resources','move_attempts','moves','element_revisions','elements'])await c.query(`DELETE FROM game_core.${table} WHERE owner_id=$1`,[owner]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await app.end();await admin.end();}
 }
});
