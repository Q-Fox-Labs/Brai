// ABOUTME: Проверяет привязку локального обновления к принятому commit и разрешённому подготовщику.
// ABOUTME: Не меняет Git и пакеты; реальные эффекты проверяются изолированными Git/Temporal fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {synchronizeSource} from '../src/source-checkout.mjs';
const sha='a'.repeat(40),project={repo_path:'/repo',preparer_path:'/repo/.git/hooks/prepare-brai-worktree'},workspace={path:'/workspaces/own'};
const ready={state:'ready',commit_sha:sha,lock_sha256:'b'.repeat(64),dependency_graph_sha256:'c'.repeat(64)};
test('source synchronization invokes only the registered helper with the exact commit and closing tree',async()=>{
  let called;
  assert.deepEqual(await synchronizeSource(project,workspace,sha,{run:async(...args)=>{called=args;return {stdout:JSON.stringify(ready)};}}),ready);
  assert.deepEqual(called.slice(0,2),['/repo/.git/hooks/synchronize-brai-source',['/repo',sha,'--closing-worktree','/workspaces/own']]);
  assert.equal(called[2].timeout,1800000);
});
test('source conflicts remain explicit waiting; unrelated or malformed receipts never complete a release',async()=>{
  assert.deepEqual(await synchronizeSource(project,workspace,sha,{run:async()=>({stdout:JSON.stringify({state:'waiting',reason:'LOCAL_CHECKOUT_DIRTY'})})}),{state:'waiting',reason:'LOCAL_CHECKOUT_DIRTY'});
  for(const receipt of [{...ready,commit_sha:'d'.repeat(40)},{...ready,lock_sha256:null},{state:'ready'},null,{state:'waiting',reason:'private error text'}]){
    await assert.rejects(synchronizeSource(project,workspace,sha,{run:async()=>({stdout:JSON.stringify(receipt)})}),{code:'GIT_FAILED'});
  }
});
test('invalid source identity is rejected before starting external operations',async()=>{
  await assert.rejects(synchronizeSource(project,workspace,'dev',{run:()=>assert.fail('not admitted')}),{code:'INVALID_ARGUMENT'});
});
