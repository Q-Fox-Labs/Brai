// ABOUTME: Проверяет game-core на настоящем PostgreSQL с отдельным синтетическим владельцем.
// ABOUTME: Удаляет только свой набор; без явных owner/app подключений тест пропускается.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createGameHandlers} from '../dist/game.js';
import {migrate} from '../dist/migrate.js';
import {importSnapshot} from '../dist/import-snapshot.js';

test('game-core PostgreSQL: цепочка, ресурсы, повторы, замечания, приватность и отмена',{skip:!process.env.ELEMENTS_OWNER_DATABASE_URL||!process.env.ELEMENTS_DATABASE_URL},async()=>{
 const admin=new Pool({connectionString:process.env.ELEMENTS_OWNER_DATABASE_URL});
 const app=new Pool({connectionString:process.env.ELEMENTS_DATABASE_URL});
 const owner=`game-core-test-${randomUUID()}`;
 const h=createGameHandlers(app,{}),req=v=>({user_id:owner,...v});
 const id=()=>randomUUID();
 const goal=id(),task=id(),revG=id(),revT=id();
 const confirm=id(),start=id(),confirmT=id(),work=id(),review=id(),accept=id(),final=id(),finish=id();
 const make=(mid,element,target,prev,kind,purpose)=>({id:mid,element_id:element,target_element_id:target,previous_move_id:prev,kind,purpose,title:`synthetic ${purpose}`,instructions:'synthetic'});
 async function claim(move,key=id()){return (await h.moveClaim(req({move_id:move,executor_kind:[confirm,confirmT,review,final].includes(move)?'human':'agent',idempotency_key:key}))).attempt;}
 async function complete(a,metadata={}){return h.moveComplete(req({attempt_id:a.id,result:{resources:[{title:'synthetic result',content:'synthetic',metadata}]}}));}
 try {
  await migrate(admin,process.env.ELEMENTS_OWNER_ROLE,process.env.ELEMENTS_APP_ROLE);
  await migrate(admin,process.env.ELEMENTS_OWNER_ROLE,process.env.ELEMENTS_APP_ROLE);
  await h.structureCreate(req({elements:[{id:goal,kind:'goal',title:'synthetic goal',revision:revG},{id:task,kind:'task',parent_id:goal,title:'synthetic task',revision:revT}],moves:[make(confirm,goal,goal,null,'action','confirm'),make(start,goal,task,confirm,'operation','start'),make(confirmT,task,task,start,'action','confirm'),make(work,task,task,confirmT,'operation','work'),make(review,task,task,work,'action','review'),make(accept,goal,task,review,'operation','accept'),make(final,goal,goal,accept,'action','final'),make(finish,goal,goal,final,'operation','finish')]}));
  assert.deepEqual((await h.movesAvailable(req({}))).items.map(x=>x.id),[confirm]);
  await assert.rejects(()=>claim(work),/INVALID_STATE/);
  await assert.rejects(()=>h.elementGet({user_id:owner+'-other',element_id:goal}),/NOT_FOUND/);
  assert.equal((await h.graphGet({user_id:owner+'-other'})).elements.length,0);
  const gAttempt=await claim(confirm,'confirm-key');
  assert.equal((await claim(confirm,'confirm-key')).id,gAttempt.id);
  await complete(gAttempt,{element_id:goal,revision_id:revG,stage:'planning',outcome:'approved'});
  await complete(await claim(start));
  await complete(await claim(confirmT),{element_id:task,revision_id:revT,stage:'planning',outcome:'approved'});
  const concurrent=await Promise.allSettled([claim(work,'work-1'),claim(work,'work-2')]);
  assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1);
  const first=concurrent.find(x=>x.status==='fulfilled').value;
  await h.moveFail(req({attempt_id:first.id,error_code:'SYNTHETIC_TECHNICAL'}));
  const retry=await claim(work,'work-retry');assert.notEqual(retry.id,first.id);
  await assert.rejects(()=>complete(retry,{element_id:task,stage:'final',outcome:'success'}),/FORBIDDEN/);
  await complete(retry);
  const notes=await claim(review);await complete(notes,{element_id:task,stage:'review',outcome:'changes'});
  await assert.rejects(()=>claim(accept),/INVALID_STATE/);
  const fix=id(),reconsider=id();
  await h.moveLink(req({after_move_id:review,before_move_id:accept,moves:[make(fix,task,task,review,'operation','work'),make(reconsider,task,task,fix,'action','final')]}));
  await complete(await claim(fix));
  const action=(await h.moveClaim(req({move_id:reconsider,executor_kind:'human',idempotency_key:'reconsider'}))).attempt;
  await complete(action,{element_id:task,stage:'final',outcome:'success'});
  const a=await claim(accept);const result=await complete(a);const again=await complete(a);assert.equal(again.attempt.id,a.id);
  assert.equal((await h.elementGet(req({element_id:task}))).status,'completed');
  await assert.rejects(()=>claim(finish),/INVALID_STATE/);
  await complete(await claim(final),{element_id:goal,stage:'final',outcome:'success'});
  await complete(await claim(finish));
  const graph=await h.graphGet(req({}));
  assert.equal(graph.elements.find(x=>x.id===goal).status,'completed');
  assert.equal(graph.moves.find(x=>x.id===accept).previousId,reconsider);
  const before=graph.moves.find(x=>x.id===work).input;
  assert.equal(before.length,3);
  const acceptance=graph.moves.find(x=>x.id===accept);
  assert.equal(acceptance.input.length,7);
  assert.ok(graph.moves.find(x=>x.id===final).input.includes(result.output[0]));
  const cancellation=await h.elementCreate(req({kind:'task',title:'synthetic cancel'}));
  const waiting=await h.moveCreate(req(make(id(),cancellation.id,cancellation.id,null,'operation','work')));
  await h.elementActivate(req({element_id:cancellation.id,cancel:true}));
  assert.equal((await h.graphGet(req({}))).moves.find(x=>x.id===waiting.id).status,'cancelled');
  const editable=await h.elementCreate(req({kind:'goal',title:'editable'}));const revision=id();
  const revise=req({element_id:editable.id,revision_id:revision,title:'edited',description:'saved',fields:{hypothesis:'saved'}});
  await h.elementRevise(revise);await h.elementRevise(revise);
  assert.equal((await h.elementGet(req({element_id:editable.id}))).description,'saved');
  const columns=(await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='game_core' AND table_name='moves'")).rows.map(r=>r.column_name);
  assert.ok(!columns.some(c=>['order','position','sequence_number'].includes(c)));
  assert.equal((await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='game_core' AND table_name='attempt_resources'")).rows.length,3);
  assert.ok(Number((await admin.query('SELECT count(*) FROM game_core.outbox WHERE owner_id=$1',[owner])).rows[0].count)>0);
  // Снимок проверяем на отдельном синтетическом наборе, без частной истории.
  const snapOwner=owner+'-snapshot',e=id(),r=id();const snap={elements:[{id:e,kind:'goal',parentId:null,revision:r,status:'completed',input:[],output:[]}],revisions:[{id:r,element_id:e,revision:1,title:'synthetic snapshot'}],moves:[],resources:[],attempts:[]};
  assert.equal((await importSnapshot(admin,snapOwner,snap)).imported,true);
  assert.equal((await importSnapshot(admin,snapOwner,snap)).imported,false);
  await assert.rejects(()=>importSnapshot(admin,owner+'-foreign',snap),/SNAPSHOT_CONFLICT/);
  console.log('game-core integrity, cross-owner chains, retry, rework, acceptance, cancellation, replay and isolation passed');
 }finally{
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('SET CONSTRAINTS ALL DEFERRED');for(const o of [owner,owner+'-snapshot']){for(const table of ['outbox','element_resources','attempt_resources','resources','move_attempts','moves','element_revisions','elements'])await c.query(`DELETE FROM game_core.${table} WHERE owner_id=$1`,[o]);}await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await app.end();await admin.end();}
 }
});
