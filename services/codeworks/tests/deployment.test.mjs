// ABOUTME: Проверяет выбор OCI относительно фактического состава и admission exact owner proof.
// ABOUTME: Не подменяет реальную приёмку Ansible, PostgreSQL или установленного DEV.
import test from 'node:test';
import assert from 'node:assert/strict';
import {deploymentDiff,enqueueDeployment,advanceDeployment} from '../src/deployment.mjs';
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
