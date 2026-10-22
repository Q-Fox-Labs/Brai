// ABOUTME: Проверяет explicit retry на отдельной реальной Stage6 PostgreSQL, включая конкуренцию.
// ABOUTME: Не использует A5 fixtures, пользовательские данные, Ansible runtime или автоматические повторы команд.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../src/migrate.mjs';
import {createCIEvidence} from '../../src/ci-evidence.mjs';
import {enqueueDeployment} from '../../src/deployment.mjs';
const configured=process.env.CODEWORKS_STAGE6_TEST_CONFIG;
test('real PG explicit failed retry is concurrent-idempotent and preserves original terminal receipt',{skip:!configured},async()=>{
 const c=JSON.parse(await readFile(configured,'utf8'));
 for(const key of ['owner_url','app_url','verifier_url'])assert.equal(new URL(c[key]).pathname,'/brai_codeworks_stage6_test');
 const owner=new Pool({connectionString:c.owner_url,max:1}),app=new Pool({connectionString:c.app_url,max:6}),verifier=new Pool({connectionString:c.verifier_url,max:6});
 try{
  await migrate(owner,c.app_role,c.verifier_role);await migrate(owner,c.app_role,c.verifier_role);
  const project={id:'retry_'+randomUUID(),github:{ci:{recipe_sha256:'b'.repeat(64)}}};
  await owner.query('INSERT INTO codeworks.projects(id,config) VALUES($1,$2)',[project.id,project]);
  const sha='a'.repeat(40),digest='sha256:'+'c'.repeat(64),composition={source:sha,recipe:project.github.ci.recipe_sha256,runId:'123',attempt:'1',components:[]},evidence={head_sha:sha,run_id:'123',attempt:1,composition_digest:digest};
  await createCIEvidence(verifier).save(project,{composition,published:{digest}});
  const call=async options=>{const db=await app.connect();try{return await enqueueDeployment(db,project,'dev',sha,evidence,verifier,options);}finally{db.release();}};
  const initial=await call();assert.equal(await call(),initial);
  await assert.rejects(call({retryOf:initial}),/FAILED_EXACT_ROLLOUT_REQUIRED/);
  await owner.query("UPDATE codeworks.operations SET status='failed',step='migration',result=$2 WHERE id=$1",[initial,{status:'failed',phase:'migration',code:'EXPECTED_TEST_FAULT'}]);
  await owner.query('UPDATE codeworks.deployments SET receipt=$2 WHERE operation_id=$1',[initial,{status:'failed',phase:'migration',code:'EXPECTED_TEST_FAULT'}]);
  const snapshot=async()=>(await owner.query('SELECT to_jsonb(o) AS operation,to_jsonb(d) AS deployment FROM codeworks.operations o JOIN codeworks.deployments d ON d.operation_id=o.id WHERE o.id=$1',[initial])).rows[0];
  const before=await snapshot();
  const ids=await Promise.all(Array.from({length:12},()=>call({retryOf:initial})));
  assert.equal(new Set(ids).size,1);const child=ids[0];assert.notEqual(child,initial);
  assert.equal(await call(),child);assert.equal(await call({retryOf:initial}),child);
  assert.deepEqual(await snapshot(),before);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM codeworks.deployments WHERE project_id=$1',[project.id])).rows[0].n,2);
  await assert.rejects(call({retryOf:child}),/FAILED_EXACT_ROLLOUT_REQUIRED/);
  await owner.query("UPDATE codeworks.operations SET status='succeeded' WHERE id=$1",[child]);
  await assert.rejects(call({retryOf:child}),/FAILED_EXACT_ROLLOUT_REQUIRED/);
  assert.deepEqual(await snapshot(),before);
  assert.equal((await owner.query('SELECT count(*)::int AS n FROM codeworks.verified_ci WHERE project_id=$1',[project.id])).rows[0].n,1);
 }finally{await Promise.all([owner.end(),app.end(),verifier.end()]);}
});
