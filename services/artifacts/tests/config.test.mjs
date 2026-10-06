// ABOUTME: Проверяет пределы платформенных таймеров и явные адреса runtime artifacts.
// ABOUTME: Не открывает подключения и не изменяет внешнее состояние.
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadArtifactsConfig} from '../dist/config.js';
import {createPostgresStore} from '../dist/postgres.js';
const env={ARTIFACTS_DATABASE_URL:'postgresql://fixture',NATS_URL:'nats://fixture',ARTIFACTS_DATA_DIR:'/tmp/fixture',ARTIFACTS_UPLOAD_BASE_URL:'http://fixture',ARTIFACTS_INTERNAL_BASE_URL:'http://internal'};
test('runtime rejects overflowing Node and PG timers, including shutdown grace',()=>{
  for(const key of ['ARTIFACTS_RECEIVE_TIMEOUT_MS','ARTIFACTS_RECONCILE_INTERVAL_MS','ARTIFACTS_LOCK_TIMEOUT_MS','ARTIFACTS_QUERY_TIMEOUT_MS']){
    assert.throws(()=>loadArtifactsConfig({...env,[key]:'2147483648'}),new RegExp(key));assert.doesNotThrow(()=>loadArtifactsConfig({...env,[key]:'2147483647'}));
  }
  assert.throws(()=>loadArtifactsConfig({...env,ARTIFACTS_REQUEST_TIMEOUT_MS:'2147482648'}),/ARTIFACTS_REQUEST_TIMEOUT_MS/);assert.equal(loadArtifactsConfig({...env,ARTIFACTS_REQUEST_TIMEOUT_MS:'2147482647'}).requestTimeoutMs,2147482647);
  assert.equal(loadArtifactsConfig({...env,ARTIFACTS_STALE_TEMP_AGE_MS:'9007199254740991'}).staleTempAgeMs,Number.MAX_SAFE_INTEGER);
  assert.throws(()=>createPostgresStore({}, {queryTimeoutMs:2147483648}),e=>e.code==='INVALID_ARGUMENT');assert.throws(()=>createPostgresStore({}, {lockTimeoutMs:2147483648}),e=>e.code==='INVALID_ARGUMENT');
});
test('runtime preserves configured response budget and rejects invalid roots and endpoints',()=>{
  assert.equal(loadArtifactsConfig({...env,ARTIFACTS_MAX_NATS_RESPONSE_BYTES:'2048'}).maxNatsResponseBytes,2048);
  for(const value of ['file:///tmp','http://name:secret@host','http://host/path','http://host/?token=x'])assert.throws(()=>loadArtifactsConfig({...env,ARTIFACTS_INTERNAL_BASE_URL:value}),/ARTIFACTS_INTERNAL_BASE_URL/);
  for(const value of ['0','-1','1.5','Infinity'])assert.throws(()=>loadArtifactsConfig({...env,ARTIFACTS_QUERY_TIMEOUT_MS:value}),/ARTIFACTS_QUERY_TIMEOUT_MS/);
});
