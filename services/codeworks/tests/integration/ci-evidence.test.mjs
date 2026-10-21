// ABOUTME: Проверяет новую миграцию и append-only owner CI evidence на disposable PostgreSQL.
// ABOUTME: Запуск требует явного fixture config и Ansible snapshot/restore; обычный CI пропускает его.
import test from 'node:test';
import assert from 'node:assert/strict';
import {configured,setup} from './fixture.mjs';
import {createCIEvidence} from '../../src/ci-evidence.mjs';
test('real PG CI evidence is durable, append-only and included in own schema',{skip:!configured},async()=>{
  const f=await setup();
  try {
    const project=await f.project();project.github={repository:'fixture/repository',ci:{recipe_sha256:'a'.repeat(64)}};
    const store=createCIEvidence(f.app),proof={published:{digest:'sha256:'+'b'.repeat(64)},composition:{runId:'123',attempt:'1',components:[]}};
    await store.save(project,proof);await store.save(project,structuredClone(proof));
    assert.deepEqual(await createCIEvidence(f.app).read(project,'123','1'),proof);
    await assert.rejects(f.app.query("UPDATE codeworks.verified_ci SET proof='{}'::jsonb"),{code:'42501'});
    await assert.rejects(f.app.query('DELETE FROM codeworks.verified_ci'),{code:'42501'});
    await assert.rejects(store.save(project,{...proof,published:{digest:'sha256:'+'c'.repeat(64)}}),/CI_DURABLE_PROOF_CONFLICT/);
    assert.deepEqual(await store.read(project,'123','1'),proof);
    const columns=(await f.owner.query("SELECT column_name,col_description('codeworks.verified_ci'::regclass,ordinal_position) AS comment FROM information_schema.columns WHERE table_schema='codeworks' AND table_name='verified_ci'")).rows;
    assert.equal(columns.length,6);assert(columns.every(c=>c.comment));
  }finally{await f.close();}
});
