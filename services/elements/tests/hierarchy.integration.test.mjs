// ABOUTME: Проверяет полное планирование Goal/Quest на PostgreSQL без пользовательских записей.
// ABOUTME: Все записи имеют уникального TEST owner и удаляются по owner в finally.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {createGameHandlers} from '../dist/game.js';

const fields=(title,inputs=[],outputs=[])=>({title,summary:`TEST ${title}`,inputs,context:'TEST вход известен.',scope:'Только результат теста.',constraints:'Без внешних действий.',preferences:'',unknowns:'',hypothesis:`Если вход сохранён, то получен ${title}.`,expected_result:`TEST ${title} готов.`,result_types:['Артефакт'],outputs});
const emptyPlan=(element,title,output)=>({fields:fields(title,element.draft.inputs,[output]),resources:[],children:[],work:[{key:'make',title:`Создать ${title}`,actor:'agent',description:'Подготовить один тестовый результат.',instruction:`Сохранить TEST ${title}.`,inputs:element.draft.inputs,outputs:[output],criteria:[`Результат равен TEST ${title}.`]}],completion:[output],questions:[],deferred:[],chain:[{result:output,after:[]}]});

test('planning PostgreSQL: full Goal and Quest hierarchy, gates, boundaries and resource isolation',{skip:!process.env.ELEMENTS_OWNER_DATABASE_URL||!process.env.ELEMENTS_DATABASE_URL},async()=>{
 const admin=new Pool({connectionString:process.env.ELEMENTS_OWNER_DATABASE_URL}),app=new Pool({connectionString:process.env.ELEMENTS_DATABASE_URL});
 const owner=`hierarchy-test-${randomUUID()}`,h=createGameHandlers(app,{}),req=v=>({user_id:owner,...v});
 const graph=async()=>h.graphGet(req({}));
 const take=async(mid,executor='agent')=>{const m=(await h.movesAvailable(req({}))).items.find(x=>x.id===mid);assert.ok(m,`move ${mid} should be available`);return (await h.moveClaim(req({move_id:mid,idempotency_key:randomUUID(),executor_kind:executor,input_resource_ids:m.required_resource_ids??[]}))).attempt;};
 const complete=async(mid,content,decision)=>{const g=await graph(),m=g.moves.find(x=>x.id===mid);assert.ok(m);const a=await take(mid,decision?'human':'agent'),target=g.elements.find(e=>e.id===m.targetId);return h.moveComplete(req({attempt_id:a.id,result:{resources:m.fields.planning.output_contracts.map((x,i)=>({output_key:x.key,title:x.name,content,metadata:decision&&i===m.fields.planning.output_contracts.length-1?{element_id:m.targetId,revision_id:target.revision,...decision}:{}}))}}));};
 const packetFor=async(moveId)=>{const a=await take(moveId);return {attempt:a,packet:await h.planningPacket(req({attempt_id:a.id}))};};
 const bindBuildApply=async(attempt,packet,candidate)=>{
  const files=packet.files,source=JSON.parse(files['packet.json']),inputHashes=Object.fromEntries(Object.entries(files).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')]));
  const quote=files[`inputs/${source.resources[0].id}.md`];
  const baseline={inputs:inputHashes,requirements:[{id:'evidence',kind:'result',text:'TEST evidence',state:{object:'TEST result',property:'state',value:'ready'},after:[],each:candidate.chain.some(x=>Object.hasOwn(x,'each')),source_file:`inputs/${source.resources[0].id}.md`,quote:quote.trim()}]};
  await h.planningBind(req({attempt_id:attempt.id,baseline}));
  const built=await h.planningBuild(req({attempt_id:attempt.id,candidate}));
  const review={baseline_sha256:built.baseline_sha256,candidate_sha256:built.candidate_sha256,verdict:'accept',coverage:[{requirement:'evidence',items:[candidate.chain.at(-1).result]}],errors:[],notes:[]};
  const applied=await h.planningApply(req({attempt_id:attempt.id,candidate_sha256:built.candidate_sha256,review}));
  return {built,applied,review};
 };
 const makeRoot=async(kind,label)=>{
  const eid=randomUUID(),rid=randomUUID(),planId=randomUUID(),finishId=randomUUID(),items=[{id:randomUUID(),label:'TEST объект A'},{id:randomUUID(),label:'TEST объект B'}],resource={id:rid,title:`TEST исходник ${label}`,content:JSON.stringify({items})};
  const created=await h.structureCreate(req({elements:[{id:eid,kind:'task',title:`TEST черновик ${label}`,initial_resources:[resource]}],moves:[{id:planId,element_id:eid,kind:'operation',purpose:'plan',title:`TEST спланировать ${label}`},{id:finishId,element_id:eid,kind:'operation',purpose:'finish',title:`TEST завершить ${label}`}]}));
  const revision=created.elements[0].revision;
  const classified=await h.elementReclassify(req({element_id:eid,expected_revision_id:revision,target_kind:kind,idempotency_key:randomUUID(),reason:`TEST root ${kind}`}));
  assert.equal(classified.revision_id,revision,'classification preserves the initial revision');
  const {attempt,packet}=await packetFor(planId);
  assert.equal(packet.element_kind,kind);
  const source=JSON.parse(packet.files['packet.json']),base=source.draft.inputs[0];
  const childKind=kind==='quest'?'goal':'task';
  const child=(key,title,inputs,output)=>({key,kind:childKind,fields:fields(title,inputs,[output])});
  const candidate={fields:fields(`TEST ${label} итог`,[base],['root-result']),resources:[{key:'left-result',name:`TEST ${label} left`,content:'TEST left result'},{key:'right-result',name:`TEST ${label} right`,content:'TEST right result'},{key:'root-result',name:`TEST ${label} accepted`,content:'TEST root result'}],children:[child('left',`TEST ${label} left`,[base],'left-result'),child('right',`TEST ${label} right`,[base,'left-result'],'right-result')],work:[],completion:['left-result','right-result'],questions:[],deferred:[],chain:[{result:'left-result',after:[]},{result:'right-result',after:['left-result']}]};
  const result=await bindBuildApply(attempt,packet,candidate);
  const g=await graph(),confirm=g.moves.find(m=>m.targetId===eid&&m.purpose==='confirm'),starts=g.moves.filter(m=>m.targetId&&g.elements.some(e=>e.id===m.targetId&&e.parentId===eid)&&m.purpose==='start');
  assert.equal(starts.length,2);assert.ok(starts.every(m=>m.ownerId===eid),'parent owns child start boundaries');
  const children=g.elements.filter(e=>e.parentId===eid);assert.equal(children.length,2);
  const startIds=starts.map(x=>x.id);assert.ok(g.moves.filter(m=>m.targetId===eid&&m.purpose==='accept').length===2,'parent owns one accept boundary per child');
  assert.ok(g.moves.filter(m=>startIds.includes(m.id)).every(m=>m.previousId===confirm.id),'sibling starts share approval predecessor; resource inputs govern their dependency');
  const futureIds=result.built.stage.resources.filter(r=>r.state==='expected').map(r=>r.id);
  assert.ok(!g.resources.some(r=>futureIds.includes(r.id)),'future outputs stay absent until their producer runs');
  assert.ok(!(await h.movesAvailable(req({}))).items.some(m=>m.id===starts[0].id),'child start waits for parent planning approval');
  await complete(confirm.id,'TEST parent plan approved',{stage:'planning',outcome:'approved'});
  assert.ok(!(await h.movesAvailable(req({}))).items.some(m=>m.targetId===eid&&m.purpose==='finish'),'root acceptance waits for every child and a root decision');
  const opened=(await h.movesAvailable(req({}))).items.filter(m=>startIds.includes(m.id));assert.equal(opened.length,1,'the dependent sibling waits for its resource');
  const dependent=starts.find(m=>m.conditions.required_outputs?.length);assert.ok(dependent,'sibling order comes from its required output');
  assert.equal(dependent.conditions.required_outputs[0].revision_id,result.applied.revision_id,'future output is tied to the matching plan revision');
  const firstChild=children[0],firstStart=(await graph()).moves.find(m=>m.targetId===firstChild.id&&m.purpose==='start');
  if(kind==='quest') {
   const {attempt:goalAttempt,packet:goalPacket}=await packetFor(firstStart.id),p=JSON.parse(goalPacket.files['packet.json']),input=p.draft.inputs[0],outputs=p.draft.outputs;
   const goalPlan={fields:fields(`TEST ${label} nested goal`,p.draft.inputs,outputs),resources:[{key:'middle',name:'TEST middle result',content:'TEST intermediate'}],children:[{key:'one',kind:'task',fields:fields('TEST task one',[input],['middle'])},{key:'two',kind:'task',fields:fields('TEST task two',[input,'middle'],[outputs[0]])}],work:[],completion:['middle',outputs[0]],questions:[],deferred:[],chain:[{result:'middle',after:[]},{result:outputs[0],after:['middle']}]};
   const nested=await bindBuildApply(goalAttempt,goalPacket,goalPlan),afterGoal=await graph(),confirmGoal=afterGoal.moves.find(m=>m.targetId===firstChild.id&&m.purpose==='confirm');
   await complete(confirmGoal.id,'TEST nested goal approved',{stage:'planning',outcome:'approved'});
   const task=afterGoal.elements.find(e=>e.parentId===firstChild.id&&e.kind==='task'),taskStart=(await graph()).moves.find(m=>m.targetId===task.id&&m.purpose==='start');
   const {attempt:taskAttempt,packet:taskPacket}=await packetFor(taskStart.id),tp=JSON.parse(taskPacket.files['packet.json']),taskInput=tp.draft.inputs[0],taskOutput=tp.draft.outputs[0],sourceText=taskPacket.files[`inputs/${taskInput}.md`];
   const taskPlan={fields:fields('TEST repeated task',tp.draft.inputs,tp.draft.outputs),resources:[],children:[],work:[{key:'repeat',title:'TEST process each object',actor:'agent',description:'Process every listed object independently.',instruction:'For each listed object, record its label.',inputs:[taskInput],outputs:[taskOutput],criteria:['Each object has one result.']}],completion:[taskOutput],questions:[],deferred:[],chain:[{result:taskOutput,after:[],each:taskInput}]};
   await bindBuildApply(taskAttempt,taskPacket,taskPlan);
   const taskGraph=await graph(),marker=taskGraph.moves.find(m=>m.targetId===task.id&&m.purpose==='expand-repeat'),taskConfirm=taskGraph.moves.find(m=>m.targetId===task.id&&m.purpose==='confirm');assert.ok(marker,'repeat remains an explicit unexpanded template');
   assert.ok(!(await h.movesAvailable(req({}))).items.some(m=>m.id===marker.id),'repeat expansion waits for the child planning decision');
   await complete(taskConfirm.id,'TEST child task approved',{stage:'planning',outcome:'approved'});
   const originalPrevious=marker.previousId,expanded=await h.planningExpandRepeat(req({move_id:marker.id,revision_id:taskGraph.elements.find(e=>e.id===task.id).revision,resource_id:taskInput,items}));
   assert.equal(expanded.inserted_move_ids.length,2);
   const expandedGraph=await graph(),instances=expanded.inserted_move_ids.map(id=>expandedGraph.moves.find(m=>m.id===id));
   assert.equal(instances[0].previousId,originalPrevious,'repeated work continues from the template predecessor');
   assert.equal(instances[1].previousId,instances[0].id,'task work follows a strict previous chain');
   assert.equal(sourceText,resource.content,'child planning receives only the selected parent input');
   assert.ok(nested.applied.revision_id);
  }
  return {eid,kind,children,source:resource,planId,applied:result.applied};
 };
 try{
  const goal=await makeRoot('goal','goal'),quest=await makeRoot('quest','quest');
  assert.equal(goal.children.length,2);assert.equal(quest.children.length,2);
  // A child start retains the parent-created boundary UUID and selected revision.
  const g=await graph(),rootStarts=g.moves.filter(m=>m.ownerId===quest.eid&&m.purpose==='start');
  assert.equal(new Set(rootStarts.map(m=>m.id)).size,2);
  assert.ok(rootStarts.every(m=>m.conditions.required_outputs?.length===0||m.conditions.required_outputs.every(x=>x.revision_id===quest.applied.revision_id)),'future contracts bind to the applied parent revision');
  // Wrong owner cannot inspect or run the synthetic hierarchy.
  await assert.rejects(()=>h.planningPacket({user_id:owner+'-foreign',attempt_id:goal.planId}),/NOT_FOUND/);
  console.log('hierarchy integration: classification, packet/bind/build/apply, shared boundaries, approval gate and future-output isolation passed');
 }finally{
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['outbox','element_resources','attempt_resources','resources','move_attempts','moves','element_revisions','elements'])await c.query(`DELETE FROM game_core.${table} WHERE owner_id=$1`,[owner]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();await app.end();await admin.end();}
 }
});
