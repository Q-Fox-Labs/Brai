// ABOUTME: Проверяет polling только собственного сохранённого release после revoked/cleanup.
// ABOUTME: Core double запрещает workspace lookup и новые release intents в этом read-only сценарии.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createAgentHost,socketCall} from '../src/agent-host.mjs';
for(const terminal of ['succeeded','failed'])test('bound release polling pending→'+terminal+' survives revoked workspace cleanup',async()=>{
 const state=await mkdtemp(tmpdir()+'/cwp-'),id=randomUUID(),operation=randomUUID(),args={project_id:'brai',workspace_id:randomUUID(),idempotency_key:'bound-own-release'};
 let status='pending',calls=[];let host;
 try{
  await writeFile(state+'/'+id+'.json',JSON.stringify({id,project_id:'brai',executor_id:'codex',revoked:true,release_request:{key:'same',args}}));
  host=await createAgentHost({state_root:state,projects:['brai'],adapter_project_id:'brai',executors:{codex:{},hermes:{}},require_immutable:false},async(method,request,executor)=>{
   calls.push(method);assert.equal(executor,'codex');
   if(method==='request-release'){assert.deepEqual(request,args);return {operation_id:operation};}
   assert.equal(method,'operation-status');assert.deepEqual(request,{project_id:'brai',operation_id:operation});return {operation:{id:operation,status}};
  });
  const poll=()=>socketCall(state+'/'+id+'.sock',{action:'request-release',request_key:'same'});
  assert.equal((await poll()).operation.status,'pending');status=terminal;
  assert.equal((await poll()).operation.status,terminal);
  assert.deepEqual(calls,['request-release','operation-status','request-release','operation-status']);
  await assert.rejects(socketCall(state+'/'+id+'.sock',{action:'request-release',request_key:'new'}),/WRITER_FENCED/);
 }finally{await host?.close();await rm(state,{recursive:true,force:true});}
});
