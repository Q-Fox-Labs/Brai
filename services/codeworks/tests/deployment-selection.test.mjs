// ABOUTME: Проверяет приёмку выборочного DEV receipt против доверенного предыдущего installed.
// ABOUTME: Подмена сохранённых refs и гонка базы отклоняются до записи evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installedComposition,advanceDeployment} from '../src/deployment.mjs';
const old='11111111-1111-4111-8111-111111111111',op='22222222-2222-4222-8222-222222222222';
const component=(id,digest)=>({id,artifact:{digest}});
const composition={target:'dev',source:'a'.repeat(40),components:[component('diary','new'),component('hermes','incoming')]};
const previous={operation_id:old,composition:{components:[component('hermes','installed'),component('web','installed')]}};
const receipt={operation_id:op,project_id:'brai',target:'dev',commit_sha:composition.source,composition_digest:'digest',composition,verified:true,
 selection:{version:1,components:['diary'],previous_operation_id:old,origins:{hermes:old,web:old}},
 installed_components:[composition.components[0],...previous.composition.components],inactive:[]};
test('effective installed preserves exact trusted previous refs and full candidate remains unchanged',()=>{
 const before=structuredClone(composition);
 assert.deepEqual(installedComposition(composition,receipt,previous).components,receipt.installed_components);
 assert.deepEqual(composition,before);
});
test('selection cannot omit, inject, alter or switch the trusted base and cannot apply in PROD',()=>{
 for(const mutate of [r=>r.installed_components.pop(),r=>r.installed_components[1]=component('hermes','incoming'),r=>r.installed_components.push(component('alien','x')),r=>r.selection.components.push('missing'),r=>r.selection.components.push('diary'),r=>r.selection.previous_operation_id=op,r=>delete r.selection.origins.hermes,r=>r.inactive.push({id:'web'})]){
  const r=structuredClone(receipt);mutate(r);assert.throws(()=>installedComposition(composition,r,previous),/SELECTION_INVALID/);
 }
 assert.throws(()=>installedComposition({...composition,target:'prod'},receipt,previous),/SELECTION_INVALID/);
 assert.throws(()=>installedComposition(composition,receipt),/SELECTION_INVALID/);
});
test('owner transaction checks current base under lock before persisting selected installed and evidence',async()=>{
 const queries=[],d={...receipt},db={query:async(sql,args)=>{
  queries.push({sql,args});
  if(sql.startsWith('SELECT * FROM codeworks.deployments'))return {rows:[d]};
  if(sql.startsWith('SELECT * FROM codeworks.installed'))return {rows:[previous]};
  return {rows:[]};
 }};
 assert.equal((await advanceDeployment(db,{id:op},async()=>({status:'succeeded',receipt}))).status,'succeeded');
 const lock=queries.findIndex(q=>q.sql.includes('FOR UPDATE')),insert=queries.findIndex(q=>q.sql.startsWith('INSERT INTO codeworks.installed'));
 assert.ok(lock>queries.findIndex(q=>q.sql==='BEGIN')&&insert>lock);
 assert.deepEqual(queries[insert].args[3].components,receipt.installed_components);
 assert.deepEqual(queries[insert].args[3].source,composition.source);
});
test('base race rolls back without persisting receipt, installed or release evidence',async()=>{
 const queries=[],db={query:async(sql)=>{
  queries.push(sql);
  if(sql.startsWith('SELECT * FROM codeworks.deployments'))return {rows:[receipt]};
  if(sql.startsWith('SELECT * FROM codeworks.installed'))return {rows:[{...previous,operation_id:op}]};
  return {rows:[]};
 }};
 await assert.rejects(advanceDeployment(db,{id:op},async()=>({status:'succeeded',receipt})),/SELECTION_INVALID/);
 assert.equal(queries.at(-1),'ROLLBACK');
 assert.equal(queries.some(sql=>/^(UPDATE|INSERT)/.test(sql)),false);
});
test('lost acknowledgement accepts only the already stored identical receipt and previous composition',async()=>{
 const d={...receipt,receipt},current={operation_id:op,composition:{...composition,components:receipt.installed_components},previous_composition:previous.composition};
 const db={query:async sql=>({rows:sql.startsWith('SELECT receipt FROM codeworks.deployments')?[{receipt}]:sql.startsWith('SELECT * FROM codeworks.deployments')?[d]:sql.startsWith('SELECT * FROM codeworks.installed')?[current]:[]})};
 assert.equal((await advanceDeployment(db,{id:op},async()=>({status:'succeeded',receipt}))).status,'succeeded');
 const changed=structuredClone(receipt);changed.selection.previous_operation_id='33333333-3333-4333-8333-333333333333';
 await assert.rejects(advanceDeployment(db,{id:op},async()=>({status:'succeeded',receipt:changed})),/SELECTION_INVALID/);
});
