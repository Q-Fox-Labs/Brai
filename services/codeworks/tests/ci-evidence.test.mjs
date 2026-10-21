// ABOUTME: Проверяет append-only сохранение CI proofs и компактный deterministic catalog.
// ABOUTME: Fake query port моделирует уникальность записей без подключения к PostgreSQL.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCIEvidence} from '../src/ci-evidence.mjs';

class FakeDatabase {
  records=new Map();
  async query(sql,values) {
    if(sql.startsWith('INSERT INTO codeworks.verified_ci')) {
      const [projectId,runId,attempt,policy,proof]=values,key=[projectId,runId,attempt,policy].join('/');
      if(!this.records.has(key))this.records.set(key,{projectId,runId,attempt,policy,proof,createdAt:this.records.size});
      return {rows:[],rowCount:1};
    }
    if(sql.includes('WHERE project_id=$1 AND run_id=$2')) {
      const [projectId,runId,attempt,policy]=values;
      const row=this.records.get([projectId,runId,attempt,policy].join('/'));
      return {rows:row?[{proof:row.proof}]:[]};
    }
    if(sql.includes('ORDER BY created_at,run_id,attempt')) {
      const [projectId,policy]=values;
      const rows=[...this.records.values()].filter(row=>row.projectId===projectId&&row.policy===policy)
        .sort((a,b)=>a.createdAt-b.createdAt||a.runId.localeCompare(b.runId)||a.attempt.localeCompare(b.attempt))
        .map(({proof})=>({proof}));
      return {rows};
    }
    throw Error(`Unexpected SQL in fixture: ${sql}`);
  }
}

const recipe='a'.repeat(64),repository='owner/repo',source='b'.repeat(40);
const project={id:7,github:{repository,ci:{recipe_sha256:recipe,check_name:'Codeworks CI'}}};
const ref=(kind,keyChar,digestChar,runId)=>({
  digest:'sha256:'+digestChar.repeat(64),
  metadata:{repository,recipe,kind,key:keyChar.repeat(64),source,runId:String(runId),attempt:'1'},
});
function proof(runId,components) {return {composition:{runId:String(runId),attempt:'1',components}};}

test('proof save is append-only and rejects a conflicting run identity',async()=>{
  const evidence=createCIEvidence(new FakeDatabase()),first=proof(101,[{id:'probe',artifact:ref('runtime','c','d',101)}]);
  assert.equal(await evidence.read(project,101,1),null);
  await evidence.save(project,first);
  assert.deepEqual(await evidence.read(project,101,1),first);
  await evidence.save(project,structuredClone(first));
  const conflict=proof(101,[{id:'probe',artifact:ref('runtime','e','f',101)}]);
  await assert.rejects(evidence.save(project,conflict),/CI_DURABLE_PROOF_CONFLICT/);
  assert.deepEqual(await evidence.read(project,101,1),first,'conflicting input must not replace the stored proof');
});

test('catalog is deterministic and includes only compact runtime, check and build identities',async()=>{
  const evidence=createCIEvidence(new FakeDatabase());
  await evidence.save(project,proof(102,[{id:'zeta',artifact:ref('runtime','c','d',102),check:ref('check','e','f',102),build:ref('build','1','2',102)}]));
  await evidence.save(project,proof(101,[{id:'alpha',artifact:ref('runtime','3','4',101),check:ref('check','5','6',101)}]));
  const first=await evidence.catalog(project),second=await evidence.catalog(project);
  assert.deepEqual(first,second);
  assert.equal(first.format,'brai-verified-ci-catalog-v1');
  assert.equal(first.repository,repository);assert.equal(first.recipe,recipe);
  assert.equal(first.entries.length,5);
  assert.deepEqual(first.entries.map(entry=>`${entry.id}/${entry.kind}`).sort(),[
    'alpha/check','alpha/runtime','zeta/build','zeta/check','zeta/runtime',
  ]);
  for(const entry of first.entries)assert.deepEqual(Object.keys(entry).sort(),[
    'attempt','digest','id','key','kind','recipe','repository','runId','source',
  ]);
});
