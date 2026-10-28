// ABOUTME: Проверяет необязательность, владение и повторы обслуживания индекса Codeworks.
// ABOUTME: Не подключается к рабочим SocratiCode, PostgreSQL и Temporal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createCodeIndex,indexIdentity} from '../src/code-index.mjs';
import {validate} from '../src/contracts.mjs';
import {validateCleanupSnapshot} from '../src/code-index-engine.mjs';

async function fixture(t,kind='feature'){
  const root=fileURLToPath(new URL('../../../tmp/',import.meta.url));await mkdir(root,{recursive:true});
  const dir=await mkdtemp(root+'code-index-');t.after(()=>rm(dir,{recursive:true,force:true}));
  const configFile=dir+'/config.json',source=kind==='feature'?'/fixture/dev':'/fixture/prod';
  await writeFile(configFile,JSON.stringify({sources:{brai:{feature:'/fixture/dev',hotfix:'/fixture/prod'}}}));
  const w={id:'fixture',path:'/fixture/workspaces/task',base_sha:'abc',kind,ownership_token:'fixture-token',preparation_state:'ready',code_index:null};
  let active=true,locked=false,calls=[];
  const query=async(sql,args)=>{
    if(sql.includes('SET code_index')){w.code_index=args[1];return {rows:[]};}
    if(sql.includes('pg_try_advisory'))return {rows:[{acquired:!locked}]};
    if(sql.includes('pg_advisory_unlock'))return {rows:[]};
    if(sql.includes('r.lifecycle'))return {rows:[{removed_at:null,lifecycle:active?'active':'cancelled'}]};
    throw Error('Unexpected fixture SQL');
  };
  const db={query,on(){},removeListener(){},release(){}};
  const pool={query,connect:async()=>db};let result={state:'ready'};
  const adapter=createCodeIndex(pool,{configFile,invoke:async(action,config,p,w,index,manifest,checkpointState)=>{calls.push({action,index,manifest,checkpointState});if(result instanceof Error)throw result;return result;}});
  return {w,source,adapter,calls,project:{id:'brai',workspace_root:'/fixture/workspaces'},setResult:v=>{result=v;},cancel:()=>{active=false;},busy:()=>{locked=true;}};
}

for(const kind of ['feature','hotfix'])test(kind+' clones its contour once, then updates only its identity',async t=>{
  const f=await fixture(t,kind);await f.adapter.maintain(f.project,f.w);
  assert.equal(f.w.code_index.source_path,f.source);assert.equal(f.w.code_index.identity,indexIdentity(f.w.path));
  assert.equal(f.w.code_index.state,'ready');assert.ok(f.w.code_index.last_success_at);
  await f.adapter.maintain(f.project,f.w);assert.deepEqual(f.calls.map(c=>c.action),['clone','update']);
  validate('workspace',{id:'00000000-0000-4000-8000-000000000001',project_id:'brai',workspace_key:'fixture',element_id:null,kind,base_ref:'refs/remotes/origin/dev',base_sha:'a'.repeat(40),branch:kind+'/fixture',path:f.w.path,preparation_state:'ready',created_at:new Date().toISOString(),removed_at:null,code_index:f.w.code_index});
});
test('not ready source waits, errors retry clone, source ahead is skipped permanently',async t=>{
  const f=await fixture(t);f.setResult({state:'waiting',reason:'SOURCE_NOT_READY'});
  await f.adapter.maintain(f.project,f.w);assert.equal(f.w.code_index.state,'waiting');
  f.setResult(Error('secret endpoint'));await f.adapter.maintain(f.project,f.w);assert.equal(f.w.code_index.error,'INDEX_MAINTENANCE_FAILED');
  assert.ok(!JSON.stringify(f.w.code_index).includes('secret'));
  f.setResult({state:'skipped',reason:'SOURCE_REVISION_CHANGED'});await f.adapter.maintain(f.project,f.w);
  await f.adapter.maintain(f.project,f.w);assert.equal(f.calls.length,3);
});
test('failed refresh retains successful clone and retries update',async t=>{
  const f=await fixture(t);await f.adapter.maintain(f.project,f.w);
  f.setResult(Error('transport'));await f.adapter.maintain(f.project,f.w);await f.adapter.maintain(f.project,f.w);
  assert.deepEqual(f.calls.map(c=>c.action),['clone','update','update']);
});
test('cancellation and contention perform no external writes',async t=>{
  const f=await fixture(t);f.cancel();await f.adapter.maintain(f.project,f.w);assert.equal(f.calls.length,0);
  const b=await fixture(t);b.busy();await b.adapter.maintain(b.project,b.w);assert.equal(b.calls.length,0);
});
test('cleanup is repeatable after path disappearance and rejects foreign identity',async t=>{
  const f=await fixture(t);await f.adapter.maintain(f.project,f.w);
  await f.adapter.remove(f.project,f.w);await f.adapter.remove(f.project,f.w);
  assert.deepEqual(f.calls.map(c=>c.action),['clone','inspect','remove','inspect','remove']);assert.equal(f.w.code_index.state,'removed');
  f.w.code_index={...f.w.code_index,state:'ready',identity:'foreign'};
  await assert.rejects(f.adapter.remove(f.project,f.w),/INDEX_OWNERSHIP_CONFLICT/);
});

test('awaiting first write does not index, but active and legacy do',async t=>{
  const f=await fixture(t);f.w.activation_state='awaiting_first_write';
  await f.adapter.maintain(f.project,f.w);assert.equal(f.calls.length,0);
  f.w.activation_state='active';await f.adapter.maintain(f.project,f.w);assert.equal(f.calls[0].action,'clone');
});
test('cleanup inspects even without index state and propagates backend errors',async t=>{
  const f=await fixture(t);await f.adapter.remove(f.project,f.w);
  assert.deepEqual(f.calls.map(c=>c.action),['inspect','remove']);
  f.setResult(Error('backend unavailable'));
  await assert.rejects(f.adapter.inspect(f.project,f.w),/backend unavailable/);
  await assert.rejects(f.adapter.remove(f.project,f.w),/backend unavailable/);
});

test('legacy checkpoint permits only previously verified remaining resources',()=>{
  const project={id:'fixture',common_dir:'/fixture/repo'},workspace={id:'id',path:'/fixture/area'};
  const resources={collections:['one','two'],metadataPoints:['base']};
  const manifest={manifestVersion:1,reviewed:true,project_id:project.id,common_dir:project.common_dir,workspace_id:workspace.id,worktree:{path:workspace.path},manifest_sha256:'a'.repeat(64),index:{identity:'index',ownerRecordHash:null,...resources}};
  const checkpointState={manifest_sha256:manifest.manifest_sha256,identity:'index',ownerRecordHash:null,resources};
  const snapshot={identity:'index',owner:{present:false,recordHash:null},resources,complete:true};
  const check=(state,checkpoint=checkpointState)=>validateCleanupSnapshot({action:'remove',project,workspace,manifest,checkpointState:checkpoint,snapshot:state});
  assert.doesNotThrow(()=>check(snapshot,undefined));
  for(const remaining of [{collections:['two'],metadataPoints:['base']},{collections:[],metadataPoints:['base']},{collections:[],metadataPoints:[]}])assert.doesNotThrow(()=>check({...snapshot,resources:remaining}));
  assert.throws(()=>check({...snapshot,resources:{collections:['foreign'],metadataPoints:[]}}),/INDEX_OWNERSHIP_CONFLICT/);
  assert.throws(()=>check({...snapshot,owner:{present:true,recordHash:'foreign'}}),/INDEX_OWNERSHIP_CONFLICT/);
  assert.throws(()=>check({...snapshot,resources:{collections:['two'],metadataPoints:[]}},null),/INDEX_OWNERSHIP_CONFLICT/);
  const owned={...manifest,index:{...manifest.index,ownerRecordHash:'hash'}};
  assert.throws(()=>validateCleanupSnapshot({action:'remove',project,workspace,manifest:owned,checkpointState:{...checkpointState,ownerRecordHash:'hash'},snapshot}),/INDEX_OWNERSHIP_CONFLICT/);
  assert.doesNotThrow(()=>validateCleanupSnapshot({action:'remove',project,workspace,manifest:owned,checkpointState:{...checkpointState,ownerRecordHash:'hash'},snapshot:{...snapshot,resources:{collections:[],metadataPoints:[]}}}));
});

test('checkpoint is persisted before deletion and failed persistence prevents deletion',async t=>{
  const f=await fixture(t),snapshot={identity:indexIdentity(f.w.path),owner:{recordHash:null},resources:{collections:['fixture'],metadataPoints:[]},complete:true},manifest={manifest_sha256:'a'.repeat(64)};
  f.setResult(snapshot);let saved;
  await f.adapter.remove(f.project,f.w,{manifest,checkpoint:async state=>{assert.deepEqual(f.calls.map(c=>c.action),['inspect']);saved=state;}});
  assert.deepEqual(f.calls.map(c=>c.action),['inspect','remove']);assert.deepEqual(f.calls[1].checkpointState,saved);
  f.calls.length=0;await assert.rejects(f.adapter.remove(f.project,f.w,{manifest,checkpoint:async()=>{throw Error('save failed');}}),/save failed/);
  assert.deepEqual(f.calls.map(c=>c.action),['inspect']);
  f.calls.length=0;await f.adapter.remove(f.project,f.w,{manifest,checkpointState:saved});
  assert.deepEqual(f.calls[1].checkpointState,saved);
});
