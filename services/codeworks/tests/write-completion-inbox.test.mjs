// ABOUTME: Проверяет точную привязку завершения к допущенному native вызову.
// ABOUTME: Legacy raw digest и новый canonical digest не дают завершить чужого писателя.
import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePostCompletion} from '../src/completion-inbox.mjs';

const make=()=>{
 const notice={project_id:'p',session_id:'s',turn_id:'t',tool_use_id:'u',tool_name:'apply_patch',input_sha256:'a'.repeat(64),canonical_input_sha256:'b'.repeat(64),outcome:'success'};
 const call={...notice,executor_id:'codex',state:'in_flight',admitted_at:new Date(),rewritten_sha256:notice.input_sha256,completion_input_sha256:null};
 return {notice,call};
};
test('legacy raw and new canonical digests accept only the admitted call',()=>{
 const {notice,call}=make();assert.doesNotThrow(()=>validatePostCompletion(call,notice,'codex'));
 assert.throws(()=>validatePostCompletion(call,{...notice,input_sha256:'c'.repeat(64)},'codex'),{code:'WRITE_CALL_MISMATCH'});
 call.completion_input_sha256=notice.canonical_input_sha256;
 assert.doesNotThrow(()=>validatePostCompletion(call,{...notice,input_sha256:'c'.repeat(64)},'codex'));
 for(const patch of [{canonical_input_sha256:'c'.repeat(64)},{tool_name:'Bash'},{tool_use_id:'other'},{turn_id:'other'},{session_id:'other'},{project_id:'other'}])assert.throws(()=>validatePostCompletion(call,{...notice,...patch},'codex'),{code:'WRITE_CALL_MISMATCH'});
 assert.throws(()=>validatePostCompletion(call,notice,'other'),{code:'WRITE_CALL_MISMATCH'});
});
test('unadmitted or unrelated terminal outcome cannot be treated as a Post',()=>{
 const {notice,call}=make();assert.throws(()=>validatePostCompletion({...call,admitted_at:null},notice,'codex'),{code:'WRITE_CALL_MISMATCH'});
 assert.throws(()=>validatePostCompletion({...call,state:'preparing'},notice,'codex'),{code:'WRITE_CALL_MISMATCH'});
 assert.throws(()=>validatePostCompletion({...call,state:'finished',tool_result:{outcome:'error'}},notice,'codex'),{code:'WRITE_CALL_MISMATCH'});
 assert.doesNotThrow(()=>validatePostCompletion({...call,state:'uncertain'},notice,'codex'));
});
test('typed not-started accepts the original input only when execution failed',()=>{
 const {notice,call}=make();call.original_input_sha256='d'.repeat(64);call.completion_input_sha256=notice.canonical_input_sha256;
 const original={...notice,input_sha256:'d'.repeat(64),canonical_input_sha256:'d'.repeat(64),execution_status:'not_started',outcome:'error'};
 for(const state of ['preparing','denied_pending','in_flight','uncertain'])assert.doesNotThrow(()=>validatePostCompletion({...call,state},original,'codex'));
 assert.throws(()=>validatePostCompletion(call,{...original,execution_status:'completed'},'codex'),{code:'WRITE_CALL_MISMATCH'});
 assert.throws(()=>validatePostCompletion(call,{...original,outcome:'success'},'codex'),{code:'WRITE_CALL_MISMATCH'});
 assert.throws(()=>validatePostCompletion(call,{...original,canonical_input_sha256:'e'.repeat(64)},'codex'),{code:'WRITE_CALL_MISMATCH'});
});
