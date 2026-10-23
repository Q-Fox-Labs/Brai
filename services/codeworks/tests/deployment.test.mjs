// ABOUTME: Проверяет выбор OCI относительно фактического состава и admission exact owner proof.
// ABOUTME: Не подменяет реальную приёмку Ansible, PostgreSQL или установленного DEV.
import test from 'node:test';
import assert from 'node:assert/strict';
import {deploymentDiff,enqueueDeployment,advanceDeployment,installedComposition} from '../src/deployment.mjs';
const component=(id,digest)=>({id,artifact:{digest}});
const composition={source:'a'.repeat(40),recipe:'b'.repeat(64),components:[component('a','x'),component('b','y')]};
test('unknown bootstrap explicit; unchanged compares actual installed, never failed previous candidate',()=>{
 assert.deepEqual(deploymentDiff(composition,null),{bootstrap:true,changed:['a','b'],unchanged:[]});
 assert.deepEqual(deploymentDiff(composition,{components:[component('a','x'),component('b','old')]}),{bootstrap:false,changed:['b'],unchanged:['a']});
 assert.deepEqual(deploymentDiff(composition,composition),{bootstrap:false,changed:[],unchanged:['a','b']});
});
test('owner enqueue rejects agent-like evidence with no immutable owner proof before any write',async()=>{
 const queries=[],db={query:async(...args)=>{queries.push(args);return {rows:[]};}};
 const p={id:'p',github:{ci:{recipe_sha256:composition.recipe}}};
 await assert.rejects(enqueueDeployment(db,p,'dev',composition.source,{head_sha:composition.source,run_id:'1',attempt:1,composition_digest:'fake'}),/OWNER_PROOF_REQUIRED/);
 assert.equal(queries.length,1);assert.match(queries[0][0],/^SELECT proof/);
});
test('running and failed adapter outcomes never record installed/evidence; mismatched success rejected',async()=>{
 const d={project_id:'p',target:'dev',commit_sha:composition.source,composition,composition_digest:'digest'},queries=[];
 const db={query:async(sql,args)=>{queries.push(sql);return {rows:sql.startsWith('SELECT')?[d]:[]};}};
 assert.equal((await advanceDeployment(db,{id:'id'},async()=>({status:'running'}))).status,'awaiting_deployment');
 assert.equal((await advanceDeployment(db,{id:'id'},async()=>({status:'failed',phase:'download'}))).status,'failed');
 await assert.rejects(advanceDeployment(db,{id:'id'},async()=>({status:'succeeded',receipt:{operation_id:'wrong'}})),/RECEIPT_MISMATCH/);
 assert.equal(queries.some(q=>q.includes('INSERT INTO codeworks.installed')),false);
});

test('installed subset retains exact trusted refs; inactive refs never become installed',()=>{
 const inactive=[{id:'b',artifact:composition.components[1].artifact,reason:'disabled-in-production'}];
 assert.deepEqual(installedComposition(composition,{installed_components:composition.components,inactive:[]}),composition);
 assert.deepEqual(installedComposition(composition,{installed_components:[composition.components[0]],inactive}).components,[composition.components[0]]);
 assert.throws(()=>installedComposition(composition,{installed_components:[component('a','unknown')],inactive}),/INSTALLED_SUBSET_INVALID/);
 assert.throws(()=>installedComposition(composition,{installed_components:[component('unknown','x')],inactive}),/INSTALLED_SUBSET_INVALID/);
 assert.throws(()=>installedComposition(composition,{installed_components:[composition.components[0]],inactive:[]}),/INSTALLED_SUBSET_INVALID/);
});

test('one explicit failed rollout creates one child; polling and replay never create its next retry',async()=>{
 const project={id:'p',github:{ci:{recipe_sha256:composition.recipe}}},digest='sha256:'+'c'.repeat(64);
 const evidence={head_sha:composition.source,run_id:'123',attempt:1,composition_digest:digest};
 const previous={operation_id:'0997203d-1266-4cf7-9668-d985b3eec801',project_id:'p',target:'dev',commit_sha:composition.source,run_id:'123',attempt:'1',composition_digest:digest,composition:structuredClone(composition),status:'failed',archived:false,operation_archived:false};
 const deployments=[previous],operations=new Map();let inserts=0;
 const db={query:async(sql,args=[])=>{
  if(sql.startsWith('SELECT proof'))return {rows:[{proof:{composition,published:{digest}}}]};
  if(sql.startsWith('SELECT d.*,o.status'))return {rows:deployments.filter(d=>d.operation_id===args[0])};
  if(sql.startsWith('SELECT operation_id FROM codeworks.deployments WHERE retry_of='))return {rows:deployments.filter(d=>d.retry_of===args[0]&&!d.archived).map(d=>({operation_id:d.operation_id}))};
  if(sql.startsWith('SELECT operation_id FROM codeworks.deployments WHERE project_id=')){
   const latest=deployments.filter(d=>d.project_id===args[0]&&d.target===args[1]&&d.run_id===args[2]&&d.attempt===args[3]&&!d.archived).at(-1);
   return {rows:latest?[{operation_id:latest.operation_id}]:[]};
  }
  if(sql.startsWith('INSERT INTO codeworks.operations'))operations.set(args[0],{status:'pending'});
  if(sql.startsWith('INSERT INTO codeworks.deployments')){
   inserts++;
   const [operation_id,project_id,target,commit_sha,run_id,attempt,composition_digest,body,retry_of]=args;
   deployments.push({operation_id,project_id,target,commit_sha,run_id,attempt,composition_digest,composition:body,retry_of,...operations.get(operation_id),archived:false,operation_archived:false});
  }
  return {rows:[]};
 }};
 const call=options=>enqueueDeployment(db,project,'dev',composition.source,evidence,db,options);
 const snapshot=structuredClone(previous);
 assert.equal(await call(),previous.operation_id);assert.equal(inserts,0);
 const child=await call({retryOf:previous.operation_id});assert.notEqual(child,previous.operation_id);assert.equal(inserts,1);
 assert.equal(await call({retryOf:previous.operation_id}),child);assert.equal(await call(),child);assert.equal(inserts,1);
 await assert.rejects(call({retryOf:child}),/FAILED_EXACT_ROLLOUT_REQUIRED/);
 deployments.find(d=>d.operation_id===child).status='failed';
 assert.equal(await call({retryOf:previous.operation_id}),child);assert.equal(await call(),child);assert.equal(inserts,1);
 const next=await call({retryOf:child});assert.notEqual(next,child);assert.equal(inserts,2);
 assert.equal(await call({retryOf:child}),next);assert.equal(inserts,2);assert.deepEqual(previous,snapshot);
 for(const flag of ['archived','operation_archived']){
  previous[flag]=true;await assert.rejects(call({retryOf:previous.operation_id}),/FAILED_EXACT_ROLLOUT_REQUIRED/);previous[flag]=false;
 }
 assert.equal(inserts,2);assert.deepEqual(previous,snapshot);
});
