// ABOUTME: Проверяет установку документов навыков через настоящий Python-тест.
// ABOUTME: Использует только временный профиль и синтетический Git.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('extensions: test_skill_docs.py',{timeout:60000},()=>{
  const result=spawnSync('python3',['-B',fileURLToPath(new URL('../extensions/tests/test_skill_docs.py',import.meta.url))],{encoding:'utf8',timeout:55000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
