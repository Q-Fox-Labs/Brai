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

test('историческую область удаляют только после повторной проверки разрешённого архива',async()=>{
  for(const valid of [false,true]){
    const archive={path:'/backup/area.bundle',sha256:'a'.repeat(64),heads:[{ref:'refs/heads/task',oid:'b'.repeat(40)}],authorization_ref:'approved'};
    const item={id:'id',epoch:1,owner_workflow_id:'owner',workspace_id:'workspace',outcome:'cancelled',step:'worktree',state:'pending',expected:{branch:{oid:'b'.repeat(40)},remote:{oid:null},tracking:{oid:null},worktree:{head:'b'.repeat(40),pathExists:true,dirty:false}},evidence:{archive,archive_authorized:true,manifest:{reviewed:true,protected_task_ids:[],disposition:{type:'archived',archive}}}};
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
