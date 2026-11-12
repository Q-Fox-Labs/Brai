// ABOUTME: Проверяет отказы входа ремонта и защищённую конфигурацию адаптера без внешних процессов.
// ABOUTME: Реальный журнал, очередь контура и квитанции проверяют интеграционные тесты PostgreSQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import {repairPostprocess,createPostprocessRepairAdapter} from '../src/postprocess-repair.mjs';

test('invalid or expanded repair inputs are rejected before any database access',async()=>{
  const pool={connect:()=>{throw Error('database must not be touched');}};
  for(const request of [null,{}, {deployment_id:'invalid',expected_runtime_sha256:'a'.repeat(64),expected_composition_digest:'sha256:'+'b'.repeat(64),request_key:'invalid'}])await assert.rejects(repairPostprocess(pool,'fixture',request,{adapter:{}}),{code:'INVALID_ARGUMENT'});
  const valid={deployment_id:'b24e5f7d-2728-4435-b5b8-ff3d385430b8',expected_runtime_sha256:'a'.repeat(64),expected_composition_digest:'sha256:'+'b'.repeat(64),request_key:'c3c2b025-2cef-464d-911b-f0739e59fbb2'};
  await assert.rejects(repairPostprocess(pool,'fixture',{...valid,command:'/tmp/untrusted'},{adapter:{}}),{code:'INVALID_ARGUMENT'});
});
test('an absent fixed adapter stays unavailable without inventing a command',()=>{
  assert.equal(createPostprocessRepairAdapter(null),null);
});
