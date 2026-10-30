// ABOUTME: Проверяет завершение по точным идентификаторам штатного API исполнителя.
// ABOUTME: Выполняющийся, чужой или отсутствующий item не освобождает писателя.
import test from 'node:test';
import assert from 'node:assert/strict';
import {executorProof} from '../src/executor-completion.mjs';
const call={id:'call',project_id:'p',workspace_id:'w',executor_id:'codex',session_id:'s',turn_id:'t',tool_use_id:'inner',tool_name:'Bash',state:'uncertain',admitted_at:new Date().toISOString(),payload_sha256:'a'.repeat(64),rewritten_sha256:'b'.repeat(64)};
test('terminal command and failed nested file change produce distinct private API evidence',()=>{
  const entry={turnId:'t',item:{id:'inner',type:'commandExecution',status:'completed',exitCode:0}};
  assert.equal(executorProof(call,entry).outcome,'success');
  assert.equal(executorProof({...call,tool_name:'apply_patch'},{turnId:'t',item:{id:'inner',type:'fileChange',status:'failed'}}).outcome,'error');
  for(const other of [{...entry,turnId:'other'},{...entry,item:{...entry.item,id:'other'}},{...entry,item:{...entry.item,status:'inProgress'}},{...entry,item:{...entry.item,exitCode:null}}])assert.equal(executorProof(call,other),null);
});
