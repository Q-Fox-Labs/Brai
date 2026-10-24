// ABOUTME: Проверяет полные Goal/Quest деревья на PostgreSQL только под TEST owner.
// ABOUTME: Человеческие решения синтетические; все записи очищаются адресно в finally.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Pool} from 'pg';
import {createGameHandlers} from '../dist/game.js';

const fields=(title,inputs=[],outputs=[])=>({title,summary:`TEST ${title}`,inputs,context:'TEST вход известен.',scope:'Только результат теста.',constraints:'Без внешних действий.',preferences:'',unknowns:'',hypothesis:`Если вход сохранён, то получен ${title}.`,expected_result:`TEST ${title} готов.`,result_types:['Артефакт'],outputs});

test('planning PostgreSQL: Goal and Quest trees complete through child and root decisions',{skip:!process.env.GAME_CORE_OWNER_DATABASE_URL||!process.env.GAME_CORE_DATABASE_URL},async()=>{
 const admin=new Pool({connectionString:process.env.GAME_CORE_OWNER_DATABASE_URL}),app=new Pool({connectionString:process.env.GAME_CORE_DATABASE_URL});
 const owner=`hierarchy-test-${randomUUID()}`,h=createGameHandlers(app,{}),req=v=>({user_id:owner,...v});
 const graph=async()=>h.graphGet(req({}));
 const plannedMove=(g,predicate)=>g.moves.find(m=>m.status==='planned'&&predicate(m));
 const available=async()=> (await h.movesAvailable(req({}))).items;
 const take=async(mid,executor='agent')=>{const move=(await available()).find(x=>x.id===mid);assert.ok(move,`move ${mid} must be available`);return (await h.moveClaim(req({move_id:mid,idempotency_key:randomUUID(),executor_kind:executor,input_resource_ids:move.required_resource_ids??[]}))).attempt;};
 const complete=async(mid,content,decision)=>{const g=await graph(),move=g.moves.find(x=>x.id===mid);assert.ok(move,`move ${mid} must exist`);const attempt=await take(mid,decision?'human':'agent'),target=g.elements.find(e=>e.id===move.targetId);return h.moveComplete(req({attempt_id:attempt.id,result:{resources:move.fields.planning.output_contracts.map((x,i)=>({output_key:x.key,title:x.name,content,metadata:decision&&i===move.fields.planning.output_contracts.length-1?{element_id:move.targetId,revision_id:target.revision,...decision}:{}}))}}));};
 const plan=async(attempt,packet,candidate)=>{
  const p=JSON.parse(packet.files['packet.json']),inputId=p.draft.inputs[0],quote=packet.files[`inputs/${inputId}.md`];
  const baseline={inputs:Object.fromEntries(Object.entries(packet.files).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')])),requirements:[{id:'evidence',kind:'result',text:'TEST evidence',state:{object:'TEST result',property:'state',value:'ready'},after:[],each:candidate.chain.some(x=>Object.hasOwn(x,'each')),source_file:`inputs/${inputId}.md`,quote:quote.trim()}]};
  const diagnostic=spawnSync('/usr/bin/python3',['services/game-core/planning/runner.py'],{input:JSON.stringify({files:packet.files,baseline,candidate}),encoding:'utf8'});
  assert.equal(diagnostic.status,0,`normative compiler rejected ${candidate.fields.title||'clarification'}: ${diagnostic.stdout}${diagnostic.stderr}`);
  try{await h.planningBind(req({attempt_id:attempt.id,baseline}));}
  catch(error){throw new Error(`planningBind failed for ${candidate.fields.title||'clarification'}: ${error.code??error.message}`);}
  let built;try{built=await h.planningBuild(req({attempt_id:attempt.id,candidate}));}
  catch(error){throw new Error(`planningBuild failed for ${candidate.fields.title||'clarification'}: ${error.code??error.message}`);}
  const review={baseline_sha256:built.baseline_sha256,candidate_sha256:built.candidate_sha256,verdict:'accept',coverage:[{requirement:'evidence',items:[candidate.chain.at(-1).result]}],errors:[],notes:[]};
  let applied;try{applied=await h.planningApply(req({attempt_id:attempt.id,candidate_sha256:built.candidate_sha256,review}));}
  catch(error){throw new Error(`planningApply failed for ${candidate.fields.title||'clarification'}: ${error.code??error.message}`);}
  return {built,applied};
 };
 const runTask=async(taskId,expand=false,requestChanges=false)=>{
  const start=plannedMove(await graph(),m=>m.targetId===taskId&&m.purpose==='start'),attempt=await take(start.id),packet=await h.planningPacket(req({attempt_id:attempt.id})),p=JSON.parse(packet.files['packet.json']),inputIds=p.draft.inputs,output=p.draft.outputs[0],listId=inputIds.find(id=>{try{return Array.isArray(JSON.parse(packet.files[`inputs/${id}.md`]).items);}catch{return false;}});
  const useRepeat=expand&&Boolean(listId),key=useRepeat?'repeat':'make',work={key,title:useRepeat?'TEST process each listed item':'TEST produce result',actor:'agent',description:'Produce one bounded test result.',instruction:'Save the observed TEST result.',inputs:inputIds,outputs:[output],criteria:['The expected TEST result is present.']};
  const candidate={fields:fields(`TEST task ${taskId}`,inputIds,p.draft.outputs),resources:[{key:'work-result',name:'TEST internal work result',content:'TEST work output'}],children:[],work:[{...work,outputs:['work-result']}],completion:['work-result'],questions:[],deferred:[],chain:[{result:'work-result',after:[],...(useRepeat?{each:listId}:{})}]};
  await plan(attempt,packet,candidate);
  let current=await graph(),confirm=plannedMove(current,m=>m.targetId===taskId&&m.purpose==='confirm');
  if(requestChanges){
   const before=current.moves.length;
   await complete(confirm.id,'TEST plan needs changes',{stage:'review',outcome:'changes'});
   current=await graph();assert.equal(current.moves.length,before+2,'changes create exactly a replan start and a second confirmation');
   const replan=plannedMove(current,m=>m.targetId===taskId&&m.purpose==='start'&&m.fields.replanning_target);
   assert.ok(replan,'a new shared-boundary replan operation exists');
   assert.equal(replan.ownerId,current.elements.find(e=>e.id===taskId).parentId,'the parent owns the replan boundary');
   const replanAttempt=await take(replan.id),replanPacket=await h.planningPacket(req({attempt_id:replanAttempt.id})),rp=JSON.parse(replanPacket.files['packet.json']);
   const revised={fields:fields(`TEST revised task ${taskId}`,rp.draft.inputs,rp.draft.outputs),resources:[{key:'work-result',name:'TEST internal work result',content:'TEST revised work output'}],children:[],work:[{key:'make',title:'TEST produce revised result',actor:'agent',description:'Produce one bounded test result.',instruction:'Save the observed TEST result.',inputs:rp.draft.inputs,outputs:['work-result'],criteria:['The expected TEST result is present.']}],completion:['work-result'],questions:[],deferred:[],chain:[{result:'work-result',after:[]}]};
   await plan(replanAttempt,replanPacket,revised);
   current=await graph();confirm=current.moves.find(m=>m.id===replan.fields.pending_confirmation_id);
   assert.ok(confirm&&confirm.purpose==='confirm','replanning creates its second confirmation');
   await complete(confirm.id,'TEST revised child planning approved',{stage:'planning',outcome:'approved'});
  }else await complete(confirm.id,'TEST child planning approved',{stage:'planning',outcome:'approved'});
  if(useRepeat){
   current=await graph();const marker=current.moves.find(m=>m.targetId===taskId&&m.purpose==='expand-repeat');assert.ok(marker);
   const items=JSON.parse(packet.files[`inputs/${listId}.md`]).items,revision=current.elements.find(e=>e.id===taskId).revision,key=randomUUID();
   const command={move_id:marker.id,revision_id:revision,resource_id:listId,items,idempotency_key:key};
   const expanded=await h.planningExpandRepeat(req(command));assert.equal(expanded.inserted_move_ids.length,items.length);
   assert.deepEqual(await h.planningExpandRepeat(req(command)),expanded,'expansion replays idempotently');
   const after=await graph(),instances=expanded.inserted_move_ids.map(id=>after.moves.find(m=>m.id===id));
   assert.equal(instances[1].previousId,instances[0].id,'repeated work has a strict previous chain');
   for(const item of instances)await complete(item.id,`TEST result ${item.title}`);
   const collect=(await graph()).moves.find(m=>m.id===marker.id);assert.equal(collect.purpose,'collect');await complete(collect.id,'TEST collected repeated results');
  }else{
   const workMove=plannedMove(await graph(),m=>m.targetId===taskId&&m.purpose==='work');await complete(workMove.id,`TEST result ${taskId}`);
  }
  current=await graph();const review=plannedMove(current,m=>m.targetId===taskId&&m.purpose==='review');assert.ok(review);
  await complete(review.id,'TEST task result accepted',{stage:'final',outcome:'success'});
  const accept=plannedMove(await graph(),m=>m.targetId===taskId&&m.purpose==='accept');assert.ok(accept);await complete(accept.id,'TEST accepted task result');
 };
 const runGoal=async(goalId,repeatFirst=false)=>{
  const start=plannedMove(await graph(),m=>m.targetId===goalId&&m.purpose==='start'),attempt=await take(start.id),packet=await h.planningPacket(req({attempt_id:attempt.id})),p=JSON.parse(packet.files['packet.json']),input=p.draft.inputs[0],outputs=p.draft.outputs;
  const candidate={fields:fields(`TEST goal ${goalId}`,p.draft.inputs,outputs),resources:[{key:'middle',name:'TEST intermediate result',content:'TEST intermediate'},{key:'second-result',name:'TEST second result',content:'TEST second output'}],children:[{key:'one',kind:'Задача',fields:fields('TEST first task',[input],['middle'])},{key:'two',kind:'Задача',fields:fields('TEST second task',[input,'middle'],['second-result'])}],work:[],completion:['middle','second-result'],questions:[],deferred:[],chain:[{result:'middle',after:[]},{result:'second-result',after:['middle']}]};
  const planned=await plan(attempt,packet,candidate);
  const confirm=plannedMove(await graph(),m=>m.targetId===goalId&&m.purpose==='confirm');await complete(confirm.id,'TEST goal plan approved',{stage:'planning',outcome:'approved'});
  const afterPlan=await graph(),tasks=planned.built.stage.children.map(c=>afterPlan.elements.find(e=>e.id===c.element.id));assert.equal(tasks.length,2);assert.ok(tasks.every(Boolean));
  const taskStarts=(await graph()).moves.filter(m=>tasks.some(e=>e.id===m.targetId)&&m.purpose==='start');
  assert.equal(new Set(taskStarts.map(m=>m.previousId)).size,1,'sibling starts share the parent confirmation boundary');
  const dependencyId=planned.built.stage.symbols.middle,dependent=taskStarts.find(m=>m.targetId===tasks[1].id);assert.ok(dependent,'second task start exists');
  assert.ok(dependent.conditions.required_outputs.some(r=>r.output_key===dependencyId),'second task start depends on first task output');
  assert.equal(dependent.conditions.required_outputs.find(r=>r.output_key===dependencyId).revision_id,(await graph()).elements.find(e=>e.id===goalId).revision,'future output is bound to this goal revision');
  const readyNow=await available();assert.ok(!readyNow.some(m=>m.id===dependent.id),`the dependent task waits for its required resource: ${JSON.stringify({conditions:dependent.conditions,ready:readyNow.filter(m=>taskStarts.some(x=>x.id===m.id)).map(m=>({id:m.id,required:m.required_resource_ids}))})}`);
  await runTask(tasks[0].id,repeatFirst);await runTask(tasks[1].id,false);
  const review=plannedMove(await graph(),m=>m.targetId===goalId&&m.purpose==='review');await complete(review.id,'TEST goal outcome accepted',{stage:'final',outcome:'success'});
  const accept=plannedMove(await graph(),m=>m.targetId===goalId&&m.purpose==='accept');await complete(accept.id,'TEST accepted goal outcome');
 };
 const makeRoot=async(kind,label)=>{
  const eid=randomUUID(),rid=randomUUID(),planId=randomUUID(),items=[{id:randomUUID(),label:'TEST object A'},{id:randomUUID(),label:'TEST object B'}],resource={id:rid,title:`TEST input ${label}`,content:JSON.stringify({items})};
  const created=await h.structureCreate(req({elements:[{id:eid,kind:'task',title:`TEST draft ${label}`,initial_resources:[resource]}],moves:[{id:planId,element_id:eid,kind:'operation',purpose:'plan',title:`TEST plan ${label}`,conditions:{required_resources:[rid]}}]}));
  const sourceRevision=created.elements[0].revision;
  const classified=await h.elementReclassify(req({element_id:eid,expected_revision_id:sourceRevision,target_kind:kind,idempotency_key:randomUUID(),reason:`TEST classify ${kind}`}));assert.equal(classified.revision_id,sourceRevision);
  const attempt=await take(planId),packet=await h.planningPacket(req({attempt_id:attempt.id})),base=JSON.parse(packet.files['packet.json']).draft.inputs[0],childKind=kind==='quest'?'Цель':'Задача';
  const candidate={fields:fields(`TEST ${label} final`,[base],['root-result']),resources:[{key:'left-result',name:'TEST left result',content:'TEST left output'},{key:'right-result',name:'TEST right result',content:'TEST right output'},{key:'root-result',name:'TEST root result',content:'TEST final output'}],children:[{key:'left',kind:childKind,fields:fields(`TEST ${label} left`,[base],['left-result'])},{key:'right',kind:childKind,fields:fields(`TEST ${label} right`,[base,'left-result'],['right-result'])}],work:[],completion:['left-result','right-result'],questions:[],deferred:[],chain:[{result:'left-result',after:[]},{result:'right-result',after:['left-result']}]};
  const applied=await plan(attempt,packet,candidate),g=await graph(),children=applied.built.stage.children.map(c=>g.elements.find(e=>e.id===c.element.id)),starts=g.moves.filter(m=>m.targetId&&children.some(e=>e.id===m.targetId)&&m.purpose==='start'),confirm=g.moves.find(m=>m.targetId===eid&&m.purpose==='confirm');
  assert.equal(children.length,2);assert.equal(starts.length,2);assert.ok(starts.every(m=>m.ownerId===eid));
  assert.equal(g.moves.filter(m=>m.ownerId===eid&&m.purpose==='accept').length,2,'parent owns both child acceptance boundaries');
  for(const child of applied.built.stage.children){assert.ok(g.moves.some(m=>m.id===child.operation.id&&m.ownerId===eid&&m.targetId===child.element.id&&m.purpose==='start'));assert.ok(g.moves.some(m=>m.id===child.finish.id&&m.ownerId===eid&&m.targetId===child.element.id&&m.purpose==='accept'));}
  assert.ok(starts.every(m=>m.previousId===confirm.id),'siblings share approval predecessor; dependencies remain resource based');
  const firstChildOutput=applied.built.stage.symbols['left-result'],dependent=starts.find(m=>m.targetId===applied.built.stage.children[1].element.id);
  assert.ok(dependent.conditions.required_outputs.some(r=>r.output_key===firstChildOutput),'second sibling start depends on the first child output');
  assert.equal(dependent.conditions.required_outputs.find(r=>r.output_key===firstChildOutput).revision_id,applied.applied.revision_id);
  const expected=applied.built.stage.resources.filter(r=>r.state==='expected').map(r=>r.id);assert.ok(!g.resources.some(r=>expected.includes(r.id)),'future outputs are not resources before their producers run');
  assert.ok(!(await available()).some(m=>m.id===starts[0].id),'child planning is blocked before root approval');
  await complete(confirm.id,'TEST root plan approved',{stage:'planning',outcome:'approved'});
  assert.ok(!(await available()).some(m=>m.id===dependent.id),'dependent sibling starts only after its resource producer');
  return {id:eid,kind,children,planId};
 };
 const finishRoot=async(root)=>{
  const review=plannedMove(await graph(),m=>m.targetId===root.id&&m.purpose==='review');assert.ok(review);
  await complete(review.id,'TEST root decision approved',{stage:'final',outcome:'success'});
  const finish=plannedMove(await graph(),m=>m.targetId===root.id&&(m.purpose==='finish'||m.purpose==='accept'));assert.ok(finish);
  await complete(finish.id,'TEST root accepted');
  assert.equal((await graph()).elements.find(e=>e.id===root.id).status,'completed');
 };
 try{
  const goal=await makeRoot('goal','goal');
  assert.ok(!(await available()).some(m=>m.targetId===goal.id&&m.purpose==='finish'),'root acceptance waits for both children and the root decision');
  const goalTasks=goal.children;assert.equal(goalTasks.length,2);
  await runTask(goalTasks[0].id,false,true);await runTask(goalTasks[1].id,false);await finishRoot(goal);

  const quest=await makeRoot('quest','quest');assert.equal(quest.children.length,2);
  await runGoal(quest.children[0].id,true);await runGoal(quest.children[1].id,false);await finishRoot(quest);
  for(const root of [goal,quest])assert.equal((await graph()).elements.filter(e=>e.id===root.id||e.parentId===root.id).filter(e=>e.status!=='completed').length,0);
  assert.ok(Buffer.byteLength(JSON.stringify(await graph()))<524288,'completed hierarchy graph fits the NATS 512 KB payload limit');
  const foreignAttempt=(await graph()).attempts.find(a=>a.moveId===goal.planId).id;
  await assert.rejects(()=>h.planningPacket({user_id:owner+'-foreign',attempt_id:foreignAttempt}),/NOT_FOUND/);
  console.log('planning hierarchy PostgreSQL: Goal(2 tasks), Quest(2 goals × 2 tasks), decisions, resource dependencies, revision-bound outputs and repeat expansion passed');
 }finally{
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['outbox','element_resources','attempt_resources','resources','move_attempts','moves','element_revisions','elements'])await c.query(`DELETE FROM game_core.${table} WHERE owner_id=$1`,[owner]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await app.end();await admin.end();}
 }
});
