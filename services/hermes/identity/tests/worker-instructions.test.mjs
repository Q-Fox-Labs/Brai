// ABOUTME: Проверяет загрузку инструкций worker и общие native skills.
// ABOUTME: Сохраняет условия запуска прежних Python-проверок.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
test('Hermes worker instructions',()=>{
  const result=spawnSync(process.env.PYTHON||'python3',['-B','-m','unittest','discover','-s',here,'-p','test_worker_system.py','-v'],{encoding:'utf8',timeout:120000});
  assert.equal(result.status,0,result.stderr||result.error?.message||'Worker instruction tests failed');
});
test('native system skills remain shared across two users',{skip:process.getuid?.()!==0||!process.env.BRAI_NATIVE_ENGINE},()=>{
  const result=spawnSync(process.env.PYTHON||'python3',['-B',join(here,'test_system_skills_native.py')],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
});
