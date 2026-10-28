// ABOUTME: Проверяет защиту уникальных ссылок при завершении задачи.
// ABOUTME: Использует подставные порты и не изменяет реальные ресурсы.
import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceCleanup} from '../src/cleanup-coordinator.mjs';

test('transfer сохраняет отдельную изменённую ветку или tracking ref',async()=>{
  for(const changed of ['branch','tracking']){
    const expected={branch:{oid:'head'},remote:{oid:'head'},tracking:{oid:'head'},worktree:{head:'head',pathExists:true,dirty:false}};
    expected[changed].oid='other';
    const item={id:'id',epoch:1,owner_workflow_id:'owner',workspace_id:'workspace',outcome:'transferred',step:'remote',expected,evidence:{transfer:{source_head:'head'}}};
    let reason,deleted=false;
    const db={query:async(sql,values)=>{
      if(sql.includes('SELECT 1 FROM codeworks.cleanup_obligations'))return {rowCount:1};
      if(sql.includes('SELECT 1 FROM codeworks.write_calls')||sql.includes('SELECT 1 FROM codeworks.release_queue'))return {rowCount:0};
      if(sql.includes('UPDATE codeworks.cleanup_obligations')){reason=values[3];return {rowCount:1,rows:[{state:'waiting_decision'}]};}
      if(sql.includes('UPDATE codeworks.operations'))return {rowCount:0};
      throw Error('unexpected query '+sql);
    }};
    const git={inspectResources:async()=>expected,cleanupStep:async()=>{deleted=true;}};
    const codeIndex={inspect:async()=>({complete:true,owner:{present:false},resources:{collections:[],metadataPoints:[]}})};
    const result=await advanceCleanup(db,item,{id:'project'},{id:'workspace',base_sha:'base'},{git,codeIndex});
    assert.equal(result.state,'waiting_decision');assert.equal(reason,'DISPOSITION_PROOF_REQUIRED');assert.equal(deleted,false);
  }
});

test('полный ноль закрывает старую область без доказательства выпуска и без удаления',async()=>{
  const item={id:'id',epoch:1,owner_workflow_id:'owner',workspace_id:'workspace',outcome:'released',step:'inspect',state:'pending',expected:{},evidence:{}};
  const empty={branch:{oid:null},ownership:{oid:null},remote:{known:true,oid:null},tracking:{oid:null},worktree:{registered:false,pathExists:false}};
  const index={complete:true,owner:{present:false},resources:{collections:[],metadataPoints:[]}};
  let deleted=false,releaseRead=false;
  const db={query:async(sql)=>{
    if(sql.includes('SELECT 1 FROM codeworks.cleanup_obligations'))return {rowCount:1};
    if(sql.includes('SELECT 1 FROM codeworks.write_calls')||sql.includes('SELECT 1 FROM codeworks.release_queue'))return {rowCount:0};
    if(sql.includes('SELECT * FROM codeworks.cleanup_obligations'))return {rows:[item]};
    if(sql.includes('SELECT * FROM codeworks.releases')){releaseRead=true;return {rows:[]};}
    if(sql.includes('UPDATE codeworks.cleanup_obligations'))return {rowCount:1,rows:[{state:'done'}]};
    return {rowCount:1,rows:[]};
  }};
  const result=await advanceCleanup(db,item,{id:'project'},{id:'workspace',base_sha:'base'},{git:{inspectResources:async()=>empty,cleanupStep:async()=>{deleted=true;}},codeIndex:{inspect:async()=>index,remove:async()=>{deleted=true;}}});
  assert.equal(result.state,'done');assert.equal(deleted,false);assert.equal(releaseRead,false);
});

test('недоступный индекс не подтверждает отсутствие ресурсов',async()=>{
  const item={id:'id',epoch:1,owner_workflow_id:'owner',workspace_id:'workspace',outcome:'released',step:'inspect',state:'pending',expected:{},evidence:{}};
  const empty={branch:{oid:null},ownership:{oid:null},remote:{known:true,oid:null},tracking:{oid:null},worktree:{registered:false,pathExists:false}};
  const db={query:async(sql)=>sql.includes('SELECT 1 FROM codeworks.cleanup_obligations')?{rowCount:1}:{rowCount:0}};
  await assert.rejects(advanceCleanup(db,item,{id:'project'},{id:'workspace'},{git:{inspectResources:async()=>empty},codeIndex:{inspect:async()=>({complete:false})}}),/INDEX_INSPECTION_INCOMPLETE/);
});

test('поздний Post между обнаружением писателя и постановкой ожидания не теряется',async()=>{
  const item={id:'id',epoch:1,owner_workflow_id:'owner',workspace_id:'workspace',outcome:'released',step:'inspect',state:'pending',expected:{},evidence:{}};
  let writer=true,readCount=0,stored;
  const db={query:async(sql,args=[])=>{
    if(sql.includes('SELECT 1 FROM codeworks.cleanup_obligations'))return {rowCount:1};
    if(sql.includes('SELECT 1 FROM codeworks.write_calls')){readCount++;return {rowCount:writer?1:0};}
    if(sql.includes('SELECT * FROM codeworks.cleanup_obligations'))return {rows:[item]};
    if(sql.startsWith("UPDATE codeworks.cleanup_obligations SET state=$2")){stored={state:args[1],blocker:args[2]};return {rows:[stored]};}
    return {rowCount:0,rows:[]};
  }};
  const result=await advanceCleanup(db,item,{id:'project'},{id:'workspace'},{git:{},checkpoint:async step=>{if(step==='writer-observed')writer=false;}});
  assert.equal(readCount,2);assert.deepEqual(result,{state:'pending',blocker:null});
});

test('неподтверждённая доставка не закрывается через проверку пустых ресурсов',async()=>{
  const item={id:'id',epoch:1,owner_workflow_id:'owner',workspace_id:'workspace',outcome:'released',step:'inspect',state:'pending',expected:{},evidence:{publication:{project_id:'project',workspace_id:'workspace'}}};
  let inspected=false;
  const db={query:async(sql)=>{
    if(sql.includes('SELECT 1 FROM codeworks.cleanup_obligations'))return {rowCount:1};
    if(sql.includes('SELECT 1 FROM codeworks.write_calls')||sql.includes('SELECT 1 FROM codeworks.release_queue'))return {rowCount:0};
    if(sql.includes('SELECT a.requested_sha'))return {rows:[]};
    if(sql.includes('UPDATE codeworks.cleanup_obligations'))return {rowCount:1,rows:[{state:'waiting_decision'}]};
    return {rowCount:0};
  }};
  const result=await advanceCleanup(db,item,{id:'project'},{id:'workspace',project_id:'project',kind:'feature'},{git:{inspectResources:async()=>{inspected=true;}},codeIndex:{}});
  assert.equal(result.state,'waiting_decision');assert.equal(inspected,false);
});

test('потеря подтверждения после внешней проверки не завершает транзакцию очистки',async()=>{
  const publication={project_id:'project',workspace_id:'workspace',original_attempt_id:'a',source_accepted_sha:'source',installed_commit:'installed',deployment_evidence_id:'evidence',deployment_operation_id:'rollout',delivery_release_operation_id:'b'};
  const item={id:'id',epoch:1,owner_workflow_id:'owner',workspace_id:'workspace',outcome:'released',step:'inspect',state:'pending',expected:{},evidence:{publication}};
  const composition={components:[]},receipt={verified:true,operation_id:'rollout',project_id:'project',target:'dev',commit_sha:'installed',composition_digest:'digest',composition};
  const row={requested_sha:'source',closed_at:'2026-01-01',state:'failed',original_status:'failed',installed_operation_id:'rollout',commit_sha:'installed',target:'dev',project_id:'project',composition_digest:'digest',composition,receipt,rollout_status:'succeeded',evidence_at:'2026-01-02',delivery_release_id:'b',delivery_release_state:'succeeded',delivery_operation_status:'succeeded',delivery_release_details:{primary:{target:'dev',merged:true,merge_sha:'installed',deployment_evidence_id:'evidence'}}};
  const empty={branch:{oid:null},ownership:{oid:null},remote:{known:true,oid:null},tracking:{oid:null},worktree:{registered:false,pathExists:false}};
  let reads=0,removed=false,rolledBack=false;
  const db={query:async(sql)=>{
    if(sql.includes('SELECT a.requested_sha'))return {rows:++reads===1?[row]:[]};
    if(sql.includes('SELECT 1 FROM codeworks.cleanup_obligations'))return {rowCount:1};
    if(sql.includes('SELECT 1 FROM codeworks.write_calls')||sql.includes('SELECT 1 FROM codeworks.release_queue')||sql.includes('SELECT 1 FROM codeworks.operations'))return {rowCount:0};
    if(sql.includes('SELECT * FROM codeworks.cleanup_obligations'))return {rows:[item]};
    if(sql==='ROLLBACK')rolledBack=true;
    if(sql.includes('UPDATE codeworks.workspaces SET removed_at'))removed=true;
    if(sql.includes('UPDATE codeworks.cleanup_obligations'))return {rowCount:1,rows:[{state:'waiting_decision'}]};
    return {rowCount:0,rows:[]};
  }};
  const result=await advanceCleanup(db,item,{id:'project'},{id:'workspace',project_id:'project',kind:'feature'},{git:{inspectResources:async()=>empty},codeIndex:{inspect:async()=>({complete:true,owner:{present:false},resources:{collections:[],metadataPoints:[]}})}});
  assert.equal(reads,2);assert.equal(rolledBack,true);assert.equal(removed,false);assert.equal(result.state,'waiting_decision');
});

test('историческую область удаляют только после повторной проверки разрешённого архива',async()=>{
  for(const [outcome,valid] of [['cancelled',false],['cancelled',true],['released',true],['unused',true],['transferred',true]]){
    const archive={path:'/backup/area.bundle',sha256:'a'.repeat(64),heads:[{ref:'refs/heads/task',oid:'b'.repeat(40)}],authorization_ref:'approved'};
    const item={id:'id',epoch:1,owner_workflow_id:'owner',workspace_id:'workspace',outcome,step:'worktree',state:'pending',expected:{branch:{oid:'b'.repeat(40)},remote:{oid:null},tracking:{oid:null},worktree:{head:'b'.repeat(40),pathExists:true,dirty:false}},evidence:{archive,archive_authorized:true,manifest:{reviewed:true,protected_task_ids:[],disposition:{type:'archived',archive}}}};
    let deleted=false,verified=false;
    const db={query:async(sql)=>{
      if(sql.includes('SELECT 1 FROM codeworks.cleanup_obligations'))return {rowCount:1};
      if(sql.includes('SELECT 1 FROM codeworks'))return {rowCount:0};
      if(sql.includes('UPDATE codeworks.cleanup_obligations'))return {rowCount:1,rows:[{state:valid?'pending':'waiting_decision'}]};
      return {rowCount:0};
    }};
    const git={cleanupStep:async()=>{deleted=true;}};
    const result=await advanceCleanup(db,item,{id:'project'},{id:'workspace'},{git,verifyArchive:async()=>{verified=true;if(!valid)throw Error('ARCHIVE_UNVERIFIED');}});
    assert.equal(verified,true);assert.equal(deleted,valid);assert.equal(result.state,valid?'pending':'waiting_decision');
  }
});

test('защищённые файлы проверяются перед удалением и изменённый source блокирует Git',async()=>{
  const proof={receipt_path:'/protected/receipt.json',receipt_sha256:'a'.repeat(64)};
  const snapshot={branch:{oid:'base'},remote:{oid:null,known:true},tracking:{oid:null},ownership:{oid:'owner'},worktree:{head:'base',pathExists:true,registered:true,dirty:false}};
  for(const step of ['remote','worktree']){
    const item={id:'id',epoch:1,owner_workflow_id:'owner',workspace_id:'workspace',outcome:'cancelled',step,state:'pending',expected:snapshot,evidence:{manifest:{filesystem_preservation:proof}}};
    let deleted=false;const phases=[];
    const db={query:async(sql)=>{
      if(sql.includes('SELECT 1 FROM codeworks.cleanup_obligations'))return {rowCount:1};
      if(sql.includes('SELECT 1 FROM codeworks'))return {rowCount:0};
      return {rows:[],rowCount:0};
    }};
    const git={inspectResources:async()=>snapshot,cleanupStep:async()=>{deleted=true;}};
    const codeIndex={inspect:async()=>({complete:true,owner:{present:false},resources:{collections:[],metadataPoints:[]}})};
    const error=Object.assign(Error('changed'),{code:'TARGET_CHANGED'});
    await assert.rejects(advanceCleanup(db,item,{id:'project'},{id:'workspace',base_sha:'base'},{git,codeIndex,verifyFilesystem:async(_p,_w,actual,options)=>{assert.equal(actual,proof);phases.push(options.phase);throw error;}}),{code:'TARGET_CHANGED'});
    assert.deepEqual(phases,['source']);assert.equal(deleted,false);
  }
});

test('после удаления дерева проверяется сохранённый архив до финального нуля',async()=>{
  const proof={receipt_path:'/protected/receipt.json',receipt_sha256:'a'.repeat(64)};
  const empty={branch:{oid:null},ownership:{oid:null},remote:{known:true,oid:null},tracking:{oid:null},worktree:{registered:false,pathExists:false}};
  const item={id:'id',epoch:1,owner_workflow_id:'owner',workspace_id:'workspace',outcome:'cancelled',step:'verify',state:'pending',expected:{branch:{oid:'base'},remote:{oid:null},tracking:{oid:null},worktree:{head:'base',pathExists:true,dirty:false}},evidence:{manifest:{filesystem_preservation:proof}}};
  const phases=[];let finished=false;
  const db={query:async(sql)=>{
    if(sql.includes('SELECT 1 FROM codeworks.cleanup_obligations'))return {rowCount:1};
    if(sql.includes('SELECT 1 FROM codeworks'))return {rowCount:0};
    if(sql.includes('SELECT * FROM codeworks.cleanup_obligations'))return {rows:[item]};
    if(sql.includes('UPDATE codeworks.cleanup_obligations')){finished=true;return {rowCount:1,rows:[{state:'done'}]};}
    return {rows:[],rowCount:0};
  }};
  const result=await advanceCleanup(db,item,{id:'project'},{id:'workspace',base_sha:'base'},{git:{inspectResources:async()=>empty},codeIndex:{inspect:async()=>({complete:true,owner:{present:false},resources:{collections:[],metadataPoints:[]}})},verifyFilesystem:async(_p,_w,_proof,{phase})=>{phases.push(phase);}});
  assert.deepEqual(phases,['archive']);assert.equal(finished,true);assert.equal(result.state,'done');
});
