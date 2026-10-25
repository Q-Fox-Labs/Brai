// ABOUTME: Проверяет уточнение и раскрытие неизвестной части через настоящий нормативный сборщик.
// ABOUTME: TEST human решения относятся только к уникальному synthetic owner с адресной очисткой.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {createGameHandlers} from '../dist/game.js';
import {fixture} from './planning-fixture.mjs';

test('planning PostgreSQL: clarification and deferred continuation preserve known work and independent approval',{skip:!process.env.GAME_CORE_OWNER_DATABASE_URL||!process.env.GAME_CORE_DATABASE_URL},async()=>{
 const admin=new Pool({connectionString:process.env.GAME_CORE_OWNER_DATABASE_URL}),app=new Pool({connectionString:process.env.GAME_CORE_DATABASE_URL});
 const owner=`planning-edges-${randomUUID()}`,h=createGameHandlers(app,{}),req=v=>({user_id:owner,...v}),graph=()=>h.graphGet(req({}));
 const take=async(mid,executor='agent')=>{const ready=(await h.movesAvailable(req({}))).items.find(m=>m.id===mid);assert.ok(ready,`expected available ${mid}`);return (await h.moveClaim(req({move_id:mid,executor_kind:executor,idempotency_key:randomUUID(),input_resource_ids:ready.required_resource_ids}))).attempt;};
 const done=async(mid,content,decision)=>{const g=await graph(),m=g.moves.find(x=>x.id===mid),el=g.elements.find(x=>x.id===m.targetId),a=await take(mid,decision?'human':'agent');return h.moveComplete(req({attempt_id:a.id,result:{resources:m.fields.planning.output_contracts.map((o,i)=>({output_key:o.key,title:o.name,content,metadata:decision&&i===m.fields.planning.output_contracts.length-1?{element_id:el.id,revision_id:el.revision,...decision}:{}}))}}));};
 async function initial(){const f=fixture();await h.structureCreate(req({elements:[{id:f.element.id,kind:'task',title:'TEST edge request',initial_resources:[{id:f.resource.id,title:f.resource.title,content:f.resource.content}]}],moves:[{id:f.move.id,element_id:f.element.id,kind:'operation',purpose:'plan',title:'TEST plan',conditions:{required_resources:[f.resource.id]}}]}));return f;}
 async function apply(mid,makeCandidate){const a=await take(mid),packet=await h.planningPacket(req({attempt_id:a.id})),p=JSON.parse(packet.files['packet.json']),candidate=makeCandidate(p),source=p.context_files[0];const baseline={inputs:Object.fromEntries(Object.entries(packet.files).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')])),requirements:candidate.chain.length?candidate.chain.map((n,i)=>({id:`r${i}`,kind:'result',text:`TEST ${n.result}`,state:{object:`TEST ${n.result}`,property:'state',value:'ready'},source_file:source,quote:packet.files[source].trim(),after:[],each:false})):[{id:'contract',kind:'condition',text:'TEST уточнить поручение',source_file:source,quote:packet.files[source].trim(),after:[],each:false}]};await h.planningBind(req({attempt_id:a.id,baseline}));const built=await h.planningBuild(req({attempt_id:a.id,candidate}));const review={baseline_sha256:built.baseline_sha256,candidate_sha256:built.candidate_sha256,verdict:'accept',coverage:candidate.chain.length?candidate.chain.map((n,i)=>({requirement:`r${i}`,items:[n.result]})):[{requirement:'contract',items:['system:clarify']}],errors:[],notes:[]};const applied=await h.planningApply(req({attempt_id:a.id,candidate_sha256:built.candidate_sha256,review}));return {a,packet,p,built,applied};}
 const confirm=async(stage)=>done(stage.records.find(x=>x.purpose==='confirm').id,'TEST точная постановка подтверждена',{stage:'planning',outcome:'approved'});
 try{
  const unclear=await initial();
  const clarification=await apply(unclear.move.id,p=>({...unclear.candidate,fields:{...unclear.candidate.fields,inputs:p.draft.inputs,title:'',expected_result:'',hypothesis:'',result_types:[],outputs:[],unknowns:'TEST неизвестен порученный итог'},resources:[],work:[],completion:[],chain:[],questions:['TEST какой итог нужен?']}));
  assert.equal(clarification.applied.awaiting_clarification,true);
  const question=clarification.built.stage.records.find(x=>x.decision==='clarify'),update=clarification.built.stage.records.find(x=>x.purpose==='update');
  assert.ok(question&&update);assert.equal((await graph()).moves.find(x=>x.id===update.id).status,'planned');
  await done(question.id,'TEST нужен сигнал из прописного слова',{stage:'clarification',outcome:'answered'});
  const clarified=await apply(update.id,p=>({...unclear.candidate,fields:{...unclear.candidate.fields,inputs:p.draft.inputs},work:unclear.candidate.work.map((w,i)=>i===0?{...w,inputs:p.draft.inputs}:w)}));
  assert.ok(Object.values(clarified.packet.files).some(x=>x.includes(unclear.resource.content)),'original source remains in clarification packet');
  assert.ok(Object.values(clarified.packet.files).some(x=>x.includes('TEST нужен сигнал')),'actual answer is available');
  const clarifiedWork=clarified.built.stage.records.find(x=>x.purpose==='work');assert.ok(!(await h.movesAvailable(req({}))).items.some(x=>x.id===clarifiedWork.id),'new plan needs its own approval');
  await confirm(clarified.built.stage);assert.ok((await h.movesAvailable(req({}))).items.some(x=>x.id===clarifiedWork.id));

  const f=await initial();
  const initialPlan=await apply(f.move.id,p=>({...f.candidate,fields:{...f.candidate.fields,inputs:p.draft.inputs},deferred:[{after:'uppercase',missing:'TEST состав обработки станет известен по прописному слову',scope:'TEST дополнительная обработка этого слова'}]}));
  const stage=initialPlan.built.stage;await confirm(stage);
  const work=stage.records.find(x=>x.purpose==='work'),expand=stage.records.find(x=>x.purpose==='expand'),known=stage.records.filter(x=>x.purpose==='work')[1];
  await done(work.id,'МАЯК');
  const segment=await apply(expand.id,p=>({fields:{...f.candidate.fields,title:'TEST дополнительная обработка',inputs:p.draft.inputs,outputs:['segment-final']},resources:[{key:'segment-result',name:'TEST дополнительный результат',content:'TEST обработка слова'},{key:'segment-final',name:'TEST принятая обработка',content:'TEST принятый итог дополнительной обработки'}],children:[],work:[{key:'extra',title:'TEST обработать слово',actor:'agent',description:'TEST одно дополнительное состояние',instruction:'TEST из реального слова получить дополнительный результат',inputs:p.draft.inputs,outputs:['segment-result'],criteria:['TEST результат существует']}],completion:['segment-result'],questions:[],deferred:[],chain:[{result:'segment-result',after:[]}]}));
  assert.equal(segment.applied.revision_id,initialPlan.applied.revision_id,'continuation does not invalidate known work revision');
  const current=(await graph()).moves.find(x=>x.id===known.id);assert.equal(current.previousId,segment.built.stage.finish.id,'known work retained and waits for accepted continuation');assert.equal(current.status,'planned');
  assert.ok(!(await h.movesAvailable(req({}))).items.some(x=>x.id===known.id));await confirm(segment.built.stage);
  await done(segment.built.stage.records.find(x=>x.purpose==='work').id,'TEST дополнительный результат');
  await done(segment.built.stage.records.find(x=>x.purpose==='review').id,'TEST дополнительный результат принят',{stage:'final',outcome:'success'});
  await done(segment.built.stage.finish.id,'TEST принятая обработка');
  assert.ok((await h.movesAvailable(req({}))).items.some(x=>x.id===known.id));
  await done(known.id,'Сигнал: МАЯК');
  const review=stage.records.find(x=>x.purpose==='review');
  await done(review.id,'TEST общий итог принят',{stage:'final',outcome:'success'});await done(stage.finish.id,'Сигнал: МАЯК + TEST принятая обработка');
  const g=await graph();assert.equal(g.elements.find(x=>x.id===f.element.id).status,'completed');assert.ok(g.resources.some(x=>x.content==='Сигнал: МАЯК + TEST принятая обработка'));
  const outputAttempt=g.attempts.find(a=>a.moveId===stage.finish.id),outputResources=g.resources.filter(r=>r.attemptId===outputAttempt.id);
  assert.deepEqual(outputAttempt.result.resource_ids,outputResources.map(r=>r.id),'graph outputs reference canonical resource UUIDs');
  assert.equal(outputAttempt.result.resources,undefined,'graph avoids duplicate actual result content');
  const stored=(await h.timelineGet(req({element_id:f.element.id,limit:100}))).items.find(a=>a.id===outputAttempt.id);
  assert.equal(stored.result.resources[0].content,outputResources[0].content,'scoped history retains complete actual result');
  assert.ok(g.elements.every(e=>!e.fields.planning_context&&!e.fields.planning?.stage&&!e.fields.planning?.expected_resources));
  assert.ok(g.moves.find(m=>m.id===known.id).instructions,'Move instructions remain visible');
  assert.ok(g.moves.find(m=>m.id===known.id).fields.planning.output_contracts.length,'output contracts remain visible on producer');
 }finally{const c=await admin.connect();try{await c.query('BEGIN');await c.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['outbox','element_resources','attempt_resources','resources','move_attempts','moves','element_revisions','elements'])await c.query(`DELETE FROM game_core.${table} WHERE owner_id=$1`,[owner]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await app.end();await admin.end();}}
});
