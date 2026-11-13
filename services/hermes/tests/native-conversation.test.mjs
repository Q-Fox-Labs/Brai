// ABOUTME: Проверяет совместную работу native conversation и identity adapter.
// ABOUTME: Запускает существующий Python-тест без установленного runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('extensions: test_native_conversation.py',{timeout:60000},()=>{
  const result=spawnSync('python3',['-B',fileURLToPath(new URL('../extensions/tests/test_native_conversation.py',import.meta.url))],{encoding:'utf8',timeout:55000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
