// ABOUTME: Проверяет точные хеши, bounded Unicode чтение и owner attempt passthrough.
// ABOUTME: Использует подставной owner порт, без shell, файлов или пользовательских данных.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planningReadTool, readPlanningPacket } from '../planning-read.mjs';
import { createBraiTools, fault } from '../runtime.mjs';
const attempt = '00000000-0000-4000-8000-000000000001';
const packet = { baseline_id: 'planning-9.2-review-1.3', source_revision: 'revision', inputs_sha256: 'aggregate', files: {
  'packet.json': '{"name":"Casio"}\n', 'rules/test.md': 'Правило\r\n😀\n'.repeat(3000), 'inputs/test.md': 'исходный текст\n',
} };
test('manifest hashes exact full UTF-8 strings; Unicode chunks reconstruct all files', () => {
 const manifest=readPlanningPacket(packet, {attempt_id:attempt}, fault);
 assert.equal(manifest.inputs_sha256, 'aggregate');
 for (const [file_name, text] of Object.entries(packet.files)) {
  assert.equal(manifest.file_sha256[file_name], createHash('sha256').update(text,'utf8').digest('hex'));
  let offset=0, all='';
  do {
   const part=readPlanningPacket(packet,{attempt_id:attempt,file_name,offset,limit:17},fault);
   assert.equal(part.file_sha256[file_name],manifest.file_sha256[file_name]);
   assert.ok(Array.from(part.content).length<=17);
   all+=part.content; offset=part.next_offset;
  } while (offset!==null);
  assert.equal(all,text);
 }
 for(const file_name of ['../config.yaml','/etc/passwd','__proto__']) assert.throws(()=>readPlanningPacket(packet,{file_name},fault),/NOT_FOUND/);
 assert.throws(()=>readPlanningPacket(packet,{offset:1},fault),/INVALID_ARGUMENT/);
 assert.throws(()=>readPlanningPacket(packet,{file_name:'packet.json',offset:1000},fault),/INVALID_ARGUMENT/);
});
test('helper uses only existing owner packet read and preserves refusal without retry', async () => {
 const calls=[];
 const ports={list:async endpoint=>endpoint==='gameCore'?[{name:'game_core_planning_packet',inputSchema:{type:'object',properties:{attempt_id:{type:'string',format:'uuid'}},required:['attempt_id'],additionalProperties:false}}]:[],
  mcp:async(endpoint,name,args)=>{calls.push({endpoint,name,args});if(args.attempt_id!==attempt)throw fault('NOT_FOUND');return packet;},close:async()=>{}};
 const runtime=await createBraiTools({ownerId:'fixed-owner'},ports);
 assert.ok(runtime.tools.find(t=>t.name===planningReadTool.name));
 assert.deepEqual(await runtime.call(planningReadTool.name,{attempt_id:attempt}),readPlanningPacket(packet,{},fault));
 assert.deepEqual(calls,[{endpoint:'gameCore',name:'game_core_planning_packet',args:{attempt_id:attempt}}]);
 for(const invalid of [{attempt_id:attempt,owner_id:'foreign'},{attempt_id:attempt,file_name:'packet.json',offset:-1},{attempt_id:attempt,limit:12001},{attempt_id:attempt,file_name:'packet.json',limit:1.5},{attempt_id:attempt,path:'/etc/passwd'}])
  await assert.rejects(runtime.call(planningReadTool.name,invalid),/INVALID_ARGUMENT/);
 assert.equal(calls.length,1);
 await assert.rejects(runtime.call(planningReadTool.name,{attempt_id:'00000000-0000-4000-8000-000000000002'}),/NOT_FOUND/);
 assert.equal(calls.length,2);
});
