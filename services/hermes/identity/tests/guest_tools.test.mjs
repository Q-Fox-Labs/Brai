// ABOUTME: Проверяет публичный браузер и ограниченные гостевые writers в общем входе Hermes.
// ABOUTME: Использует только временные файлы, собственные сокеты и подставные внешние порты.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
for(const [directory,pattern] of [
 ['identity','test_guest_*.py'], ['files','test_document.py'],
 ['files','test_structured.py'], ['files','test_generated_files.py'],
]){
 const result=spawnSync('python3',['-B','-m','unittest','discover',
  '-s','services/hermes/'+directory+'/tests','-p',pattern,'-v'],{
   cwd:root,encoding:'utf8',timeout:120000,
   env:{...process.env,PYTHONPATH:fileURLToPath(new URL('../../',import.meta.url)),
    ...(process.env.BRAI_ENGINE_TEST_ROOT||process.env.HERMES_TEST_ENGINE
      ?{BRAI_ENGINE_TEST_ROOT:process.env.BRAI_ENGINE_TEST_ROOT||process.env.HERMES_TEST_ENGINE}:{})},
 });
 assert.equal(result.error,undefined,result.error?.message);
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
 process.stdout.write(result.stdout+result.stderr);
}
