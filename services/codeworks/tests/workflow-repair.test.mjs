// ABOUTME: Проверяет доказательства ledger и наследование run fencing без внешних служб.
// ABOUTME: Отсутствие истории и чужое поколение не превращаются в разрешение новой бизнес-операции.
import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRepairLedger,validateRepairRequest,inspectRepairCheckpoints,verifyRepairMerge} from '../src/workflow-repair.mjs';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {command as gitCommand} from '../src/git.mjs';
import {createFlowGit} from '../src/git-flow.mjs';
import {withExecutionContext,executionContext} from '../src/execution-context.mjs';
const registry={workflow_id:'codeworks/test/p/workspace/w',project_id:'p',workspace_id:'w',generation:2,state:'open',lifecycle:'active',next_sequence:1,position:0};
const command={operation_id:'op',workflow_id:registry.workflow_id,operation_project_id:'p',operation_workspace_id:'w',generation:2,sequence:1,kind:'prepare',operation_kind:'prepare',state:'pending',operation_status:'pending',operation_request:{key:'same'},admitted_request:{key:'same'},archived:false};
test('repair request accepts no caller supplied event or business operation',()=>{
  const request={workflow_id:registry.workflow_id,expected_generation:2,request_key:'repair-1'};
  validateRepairRequest(request);
  for(const extra of [{event_id:4},{action:'restart'},{generation:3}])assert.throws(()=>validateRepairRequest({...request,...extra}),/INVALID_ARGUMENT/);
});
test('retained command ledger is contiguous, exact and fenced; completed history remains a tombstone',()=>{
  assert.equal(verifyRepairLedger(registry,[command]).command_count,1);
  for(const patch of [{sequence:2},{generation:1},{operation_request:{key:'changed'}},{archived:true},{state:'reconciliation'},{operation_workspace_id:'foreign'}])assert.throws(()=>verifyRepairLedger(registry,[{...command,...patch}]),/WORKFLOW_LEDGER_INCOMPLETE/);
  for(const patch of [{state:'completed'},{lifecycle:'removed'},{completed_at:'2026-11-11'}])assert.throws(()=>verifyRepairLedger({...registry,...patch},[command]),/WORKFLOW_COMPLETED/);
  assert.equal(verifyRepairLedger(registry,[{...command,state:'done',operation_status:'succeeded',generation:1}]).command_count,1);
});
test('nested execution scope keeps root run fencing and isolates concurrent scopes',async()=>{
  await Promise.all(['run-a','run-b'].map(workflowRunId=>withExecutionContext({workflowRunId,signal:'outer'},async()=>{
    await Promise.resolve();
    await withExecutionContext({signal:'inner'},async()=>{await Promise.resolve();assert.deepEqual(executionContext(),{workflowRunId,signal:'inner'});});
    assert.deepEqual(executionContext(),{workflowRunId,signal:'outer'});
  })));
  assert.equal(executionContext(),undefined);
});
test('unknown release external effect explicitly refuses complete restart proof',async()=>{
  const db={query:async sql=>({rows:sql.includes('workspaces')?[{id:'w'}]:[{details:{primary:{pr_attempted:true}}}]})};
  const proof=await inspectRepairCheckpoints(db,{},registry,[{...command,kind:'release'}],{git:{inspectResources:async()=>({ownership:{oid:null},branch:{oid:null},worktree:{pathExists:false}})}});
  assert.deepEqual(proof,{complete:false,reason_code:'EXTERNAL_EFFECT_UNKNOWN'});
});

test('native merged-leg proof reads immutable Git objects without invoking lock-required fetch',async t=>{
  const tmp=fileURLToPath(new URL('../../../tmp/',import.meta.url));await mkdir(tmp,{recursive:true});
  const root=await mkdtemp(tmp+'repair-merge-');t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=root+'/repo',remote=root+'/origin.git';
  await gitCommand('git',['init','--initial-branch=dev',repo]);
  await gitCommand('git',['init','--bare',remote]);
  const git=(args,options)=>gitCommand('git',['-C',repo,...args],options);
  await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);
  const tree=(await git(['mktree'],{input:''})).stdout;
  const base=(await git(['commit-tree',tree],{input:'base\\n'})).stdout;
  const head=(await git(['commit-tree',tree,'-p',base],{input:'head\\n'})).stdout;
  const merge=(await git(['commit-tree',tree,'-p',base,'-p',head],{input:'merge\\n'})).stdout;
  await git(['update-ref','refs/heads/dev',merge]);await git(['remote','add','origin',remote]);
  await git(['push','origin','refs/heads/dev']);
  const project={repo_path:repo,github:{repository:'fixture/codeworks'}},flowGit=createFlowGit({localRemote:true});
  const leg={target:'dev',target_sha:base,head,merge_sha:merge,merged:true,pr_number:1};
  assert.equal(await verifyRepairMerge(project,leg,{flowGit}),true);
  const workspace={id:'w',preparation_state:'intent'};
  const db={query:async sql=>({rows:sql.includes('workspaces')?[workspace]:[{details:{primary:leg}}]})};
  const proof=await inspectRepairCheckpoints(db,project,registry,[{...command,kind:'release'}],{
    flowGit,git:{inspectResources:async()=>({ownership:{oid:null},branch:{oid:null},worktree:{pathExists:false}})},
    github:{get:async()=>({merged:true,merge_commit_sha:merge})},
  });
  assert.equal(proof.complete,true,'default requireLock remains enabled; a fetch would reject this proof');
  assert.equal(await verifyRepairMerge(project,{...leg,target_sha:head},{flowGit}),false);
  await gitCommand('git',['-C',remote,'config','user.name','Fixture']);await gitCommand('git',['-C',remote,'config','user.email','fixture@example.invalid']);
  const absent=(await gitCommand('git',['-C',remote,'commit-tree',tree,'-p',merge],{input:'remote-only\\n'})).stdout;
  await gitCommand('git',['-C',remote,'update-ref','refs/heads/dev',absent]);
  assert.equal(await verifyRepairMerge(project,leg,{flowGit}),false,'missing local ancestry cannot be inferred or fetched without a project lock');
});
