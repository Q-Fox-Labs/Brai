// ABOUTME: Проверяет game-core на настоящем PostgreSQL с отдельным синтетическим владельцем.
// ABOUTME: Удаляет только свой набор; без явных owner/app подключений тест пропускается.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createGameHandlers} from '../dist/game.js';
import {migrate} from '../dist/migrate.js';
import {importSnapshot} from '../dist/import-snapshot.js';

test('game-core PostgreSQL: цепочка, ресурсы, повторы, замечания, приватность и отмена',{skip:!process.env.GAME_CORE_OWNER_DATABASE_URL||!process.env.GAME_CORE_DATABASE_URL},async()=>{
 const admin=new Pool({connectionString:process.env.GAME_CORE_OWNER_DATABASE_URL});
 const app=new Pool({connectionString:process.env.GAME_CORE_DATABASE_URL});
 const owner=`game-core-test-${randomUUID()}`;
 const h=createGameHandlers(app,{}),req=v=>({user_id:owner,...v});
 const id=()=>randomUUID();
 const goal=id(),task=id(),revG=id(),revT=id();
 const confirm=id(),start=id(),confirmT=id(),work=id(),review=id(),accept=id(),final=id(),finish=id();
 const make=(mid,element,target,prev,kind,purpose)=>({id:mid,element_id:element,target_element_id:target,previous_move_id:prev,kind,purpose,title:`synthetic ${purpose}`,instructions:'synthetic'});
 async function claim(move,key=id()){const available=(await h.movesAvailable(req({}))).items.find(m=>m.id===move);return (await h.moveClaim(req({move_id:move,executor_kind:[confirm,confirmT,review,final].includes(move)?'human':'agent',idempotency_key:key,input_resource_ids:available?.available_resource_ids??(await h.graphGet(req({}))).moves.find(m=>m.id===move)?.input??[]}))).attempt;}
 async function complete(a,metadata={}){return h.moveComplete(req({attempt_id:a.id,result:{resources:[{title:'synthetic result',content:'synthetic',metadata}]}}));}
 try {
  await migrate(admin,process.env.GAME_CORE_OWNER_ROLE,process.env.GAME_CORE_APP_ROLE);
  await migrate(admin,process.env.GAME_CORE_OWNER_ROLE,process.env.GAME_CORE_APP_ROLE);
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
  const action=(await h.moveClaim(req({move_id:reconsider,executor_kind:'human',idempotency_key:'reconsider',input_resource_ids:(await h.movesAvailable(req({}))).items.find(m=>m.id===reconsider).available_resource_ids}))).attempt;
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
  assert.equal(before.length,2);
  const acceptance=graph.moves.find(x=>x.id===accept);
  assert.equal(acceptance.input.length,6);
  assert.ok(graph.moves.find(x=>x.id===final).input.includes(result.output[0]));
  const cancellation=await h.elementCreate(req({kind:'task',title:'synthetic cancel'}));
  const waiting=await h.moveCreate(req(make(id(),cancellation.id,cancellation.id,null,'operation','work')));
  await h.elementActivate(req({element_id:cancellation.id,cancel:true}));
  assert.equal((await h.graphGet(req({}))).moves.find(x=>x.id===waiting.id).status,'cancelled');
  const cancelRoot=id(),finishedChild=id(),pendingChild=id(),finishedMove=id(),runningMove=id(),pendingMove=id();
  const tree=await h.structureCreate(req({elements:[{id:cancelRoot,kind:'goal',title:'TEST cancellation root'},{id:finishedChild,kind:'task',parent_id:cancelRoot,title:'TEST completed child'},{id:pendingChild,kind:'task',parent_id:cancelRoot,title:'TEST pending child'}],moves:[make(finishedMove,cancelRoot,cancelRoot,null,'operation','work'),make(runningMove,pendingChild,pendingChild,null,'operation','plan'),make(pendingMove,pendingChild,pendingChild,runningMove,'operation','work')]}));
  await complete(await claim(finishedMove));
  await admin.query("UPDATE game_core.elements SET status='completed',outcome='success' WHERE owner_id=$1 AND id=$2",[owner,finishedChild]);
  const running=(await h.moveClaim(req({move_id:runningMove,executor_kind:'agent',idempotency_key:id(),input_resource_ids:[]}))).attempt;
  const feedback={id:id(),content:'TEST: отмени оставшуюся работу.',source:{platform:'test',message_id:'test-cancel'}};
  const cancellationRequest=req({element_id:cancelRoot,revision_id:tree.elements[0].revision,cancel:true,feedback});
  await assert.rejects(()=>h.elementActivate({...cancellationRequest,revision_id:id()}),/CONFLICT/);
  assert.equal((await h.elementGet(req({element_id:cancelRoot}))).status,'draft');
  await assert.rejects(()=>h.elementActivate({...cancellationRequest,user_id:owner+'-other'}),/NOT_FOUND/);
  const cancelled=await h.elementActivate(cancellationRequest);
  assert.deepEqual(await h.elementActivate(cancellationRequest),cancelled);
  const cancelledGraph=await h.graphGet(req({}));
  assert.equal(cancelledGraph.elements.find(e=>e.id===finishedChild).status,'completed');
  for(const eid of [cancelRoot,pendingChild])assert.equal(cancelledGraph.elements.find(e=>e.id===eid).status,'cancelled');
  assert.equal(cancelledGraph.moves.find(m=>m.id===finishedMove).status,'succeeded');
  for(const mid of [runningMove,pendingMove])assert.equal(cancelledGraph.moves.find(m=>m.id===mid).status,'cancelled');
  assert.equal(cancelledGraph.attempts.find(a=>a.id===running.id).errorCode,'CANCELLED');
  assert.equal(cancelledGraph.resources.find(r=>r.id===feedback.id).content,feedback.content);
  await assert.rejects(()=>complete(running),/INVALID_STATE/);
  assert.ok(!(await h.movesAvailable(req({}))).items.some(m=>[runningMove,pendingMove].includes(m.id)));
  const editable=await h.elementCreate(req({kind:'goal',title:'editable'}));const revision=id();
  const revise=req({element_id:editable.id,revision_id:revision,title:'edited',description:'saved',fields:{hypothesis:'saved'}});
  await h.elementRevise(revise);await h.elementRevise(revise);
  assert.equal((await h.elementGet(req({element_id:editable.id}))).description,'saved');
  const columns=(await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='game_core' AND table_name='moves'")).rows.map(r=>r.column_name);
  assert.ok(!columns.some(c=>['order','position','sequence_number'].includes(c)));
  assert.equal((await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='game_core' AND table_name='attempt_resources'")).rows.length,3);
  assert.ok(Number((await admin.query('SELECT count(*) FROM game_core.outbox WHERE owner_id=$1',[owner])).rows[0].count)>0);
  // Граница ребёнка определяется target, а не предшественником или владельцем Хода.
  const root=id(),child=id(),sibling=id(),initial=id(),privateParent=id(),rootConfirm=id(),setup=id(),childConfirm=id(),reportMove=id(),decision=id(),acceptChild=id(),setupNext=id(),siblingConfirm=id();
  const created=await h.structureCreate(req({elements:[{id:root,kind:'goal',title:'boundary root',initial_resources:[{id:initial,title:'explicit external',content:'external'}]},{id:child,kind:'task',parent_id:root,title:'child'},{id:sibling,kind:'task',parent_id:root,title:'next child'}],moves:[make(rootConfirm,root,root,null,'action','confirm'),make(privateParent,root,root,rootConfirm,'operation','work'),make(setup,root,child,privateParent,'operation','start'),make(childConfirm,child,child,setup,'action','confirm'),make(reportMove,child,child,childConfirm,'operation','work'),make(decision,child,child,reportMove,'action','final'),make(acceptChild,root,child,decision,'operation','accept'),make(setupNext,root,sibling,acceptChild,'operation','start'),make(siblingConfirm,sibling,sibling,setupNext,'action','confirm')]}));
  const rows=await h.graphGet(req({})),rootRevision=rows.elements.find(e=>e.id===root).revision,childRevision=rows.elements.find(e=>e.id===child).revision;
  const take=async(move,input,executor='agent',transfer=[])=>h.moveClaim(req({move_id:move,idempotency_key:id(),executor_kind:executor,input_resource_ids:input,target_input_resource_ids:transfer}));
  const approval=(await complete((await take(rootConfirm,[initial],'human')).attempt,{element_id:root,revision_id:rootRevision,stage:'planning',outcome:'approved'})).output[0];
  const parentOnly=(await complete((await take(privateParent,[])).attempt)).output[0];
  const startRequest=req({move_id:setup,idempotency_key:id(),executor_kind:'agent',input_resource_ids:[approval,initial],target_input_resource_ids:[initial]});
  const begin=await h.moveClaim(startRequest);assert.deepEqual(new Set(begin.input),new Set([approval,initial]));
  assert.equal((await h.moveClaim(startRequest)).attempt.id,begin.attempt.id);
  await assert.rejects(()=>h.moveClaim({...startRequest,target_input_resource_ids:[]}),/CONFLICT/);
  const childSetup=(await complete(begin.attempt)).output[0];
  const confirmAttempt=(await take(childConfirm,[initial,childSetup],'human')).attempt;
  const childApproval=(await complete(confirmAttempt,{element_id:child,revision_id:childRevision,stage:'planning',outcome:'approved'})).output[0];
  await assert.rejects(()=>take(reportMove,[childApproval,parentOnly]),/FORBIDDEN/);
  const report=(await complete((await take(reportMove,[childApproval])).attempt)).output[0];
  const finalDecision=(await complete((await take(decision,[report],'human')).attempt,{element_id:child,stage:'final',outcome:'success'})).output[0];
  const accepted=(await complete((await take(acceptChild,[finalDecision,report])).attempt)).output[0];
  // Даже успешная приёмка не переносит исходный отчёт следующему ребёнку.
  const candidates=(await h.movesAvailable(req({}))).items.find(m=>m.id===setupNext).available_resource_ids;
  assert.ok(candidates.includes(accepted));assert.ok(candidates.includes(parentOnly));assert.ok(!candidates.includes(report));assert.ok(!candidates.includes(finalDecision));assert.ok(!candidates.includes(childSetup));
  await assert.rejects(()=>take(setupNext,[approval,report]),/FORBIDDEN/);
  const nextStart=await take(setupNext,[approval,accepted],'agent',[accepted]);await complete(nextStart.attempt);
  const snapshot=await h.graphGet(req({}));assert.deepEqual(snapshot.elements.find(e=>e.id===sibling).input,[accepted]);
  assert.deepEqual(snapshot.moves.find(m=>m.id===reportMove).input,[childApproval]);
  const siblingResources=(await h.movesAvailable(req({}))).items.find(m=>m.id===siblingConfirm).available_resource_ids;
  assert.ok(siblingResources.includes(accepted));assert.ok(!siblingResources.includes(report));assert.ok(!siblingResources.includes(initial));assert.ok(!siblingResources.includes(parentOnly));
  await assert.rejects(()=>h.moveClaim({user_id:owner+'-other',move_id:siblingConfirm,idempotency_key:id(),executor_kind:'human',input_resource_ids:[accepted]}),/NOT_FOUND/);
  await assert.rejects(()=>h.elementCreate(req({kind:'goal',title:'forged decision',initial_resources:[{title:'fake',content:'fake',metadata:{stage:'planning'}}]})),/FORBIDDEN/);
  // Снимок проверяем на отдельном синтетическом наборе, без частной истории.
  const snapOwner=owner+'-snapshot',e=id(),r=id();const snap={elements:[{id:e,kind:'goal',parentId:null,revision:r,status:'completed',input:[],output:[]}],revisions:[{id:r,element_id:e,revision:1,title:'synthetic snapshot'}],moves:[],resources:[],attempts:[]};
  assert.equal((await importSnapshot(admin,snapOwner,snap)).imported,true);
  assert.equal((await importSnapshot(admin,snapOwner,snap)).imported,false);
  await assert.rejects(()=>importSnapshot(admin,owner+'-foreign',snap),/SNAPSHOT_CONFLICT/);
  const dev=createGameHandlers(app,{},undefined,true);
  const manual=id(),next=id();await h.moveCreate(req(make(manual,editable.id,editable.id,null,'operation','work')));await h.moveCreate(req(make(next,editable.id,editable.id,manual,'operation','work')));
  const counts=async()=>Promise.all(['resources','move_attempts','element_resources'].map(async table=>Number((await admin.query(`SELECT count(*) FROM game_core.${table} WHERE owner_id=$1`,[owner])).rows[0].count)));
  const initialCounts=await counts();
  await assert.rejects(()=>h.devStatus(req({kind:'move',id:manual,status:'succeeded',request_id:id()})),/FORBIDDEN/);
  await assert.rejects(()=>dev.devStatus({user_id:owner+'-other',kind:'move',id:manual,status:'succeeded',request_id:id()}),/NOT_FOUND/);
  for(const [kind,target,statuses] of [['element',editable.id,['draft','active','completed','cancelled']],['move',manual,['planned','claimed','succeeded','cancelled']]]){
   for(const status of statuses){const request=req({kind,id:target,status,request_id:id()});const first=await dev.devStatus(request);assert.equal(first.status,status);assert.equal((await dev.devStatus(request)).event_id,first.event_id);assert.equal(Number((await admin.query('SELECT count(*) FROM game_core.outbox WHERE id=$1',[request.request_id])).rows[0].count),1);const payload=(await admin.query('SELECT payload FROM game_core.outbox WHERE id=$1',[request.request_id])).rows[0].payload;assert.equal(payload.data.manual,true);assert.equal(payload.aggregate.kind,kind);assert.equal(payload.actor.id,owner);await assert.rejects(()=>dev.devStatus({...request,status:status==='cancelled'?'active':'cancelled'}),/CONFLICT|INVALID_ARGUMENT/);}
  }
  assert.deepEqual(await counts(),initialCounts);
  await dev.devStatus(req({kind:'element',id:editable.id,status:'active',request_id:id()}));await dev.devStatus(req({kind:'move',id:manual,status:'succeeded',request_id:id()}));await assert.rejects(()=>h.moveClaim(req({move_id:next,idempotency_key:id(),executor_kind:'agent',input_resource_ids:[]})),/INVALID_STATE/);
  await assert.rejects(()=>dev.devStatus(req({kind:'move',id:manual,status:'failed',request_id:id()})),/INVALID_ARGUMENT/);
  console.log('game-core integrity, cross-owner chains, retry, rework, acceptance, cancellation, replay and isolation passed');
 }finally{
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('SET CONSTRAINTS ALL DEFERRED');for(const o of [owner,owner+'-snapshot']){for(const table of ['outbox','element_resources','attempt_resources','resources','move_attempts','moves','element_revisions','elements'])await c.query(`DELETE FROM game_core.${table} WHERE owner_id=$1`,[o]);}await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await app.end();await admin.end();}
 }
});
