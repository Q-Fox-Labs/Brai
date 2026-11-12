// ABOUTME: Проверяет безопасные подсказки восстановления без внешних сервисов.
// ABOUTME: Подсказка не снимает блокировки и не объявляет неизвестный исход завершённым.
import test from 'node:test';
import assert from 'node:assert/strict';
import {recoveryStatus} from '../src/recovery-status.mjs';
import {parseRepairArgs,runRepairOperator} from '../src/repair-operator.mjs';
import {parseCompletionArgs} from '../src/operator.mjs';
test('completed task suppresses stale blockers and project quota',()=>{
 assert.equal(recoveryStatus({workflow:{state:'completed'},writerBlocked:true,control:{github_retry_at:'2099-01-01T00:00:00Z'}}),null);
});
test('unknown writer takes precedence over resume and quota',()=>{
 assert.deepEqual(recoveryStatus({writerBlocked:true,obligation:{state:'waiting_decision',blocker:'OWNERSHIP_CONFLICT'}}),{category:'unknown_outcome',code:'WRITER_OUTCOME_UNKNOWN',retry_at:null,action:'inspect_outcome'});
});
test('quota carries a real next-at while expired quota disappears',()=>{
 const control={github_retry_at:'2030-01-01T00:00:00Z',github_reason_code:'GITHUB_RATE_LIMITED'};
 assert.equal(recoveryStatus({control,now:0}).retry_at,'2030-01-01T00:00:00.000Z');
 assert.equal(recoveryStatus({control,now:Date.parse('2031-01-01')}),null);
});
test('proof rejection and infrastructure retry remain distinguishable',()=>{
 assert.equal(recoveryStatus({obligation:{state:'waiting_decision',blocker:'ARCHIVE_UNVERIFIED'}}).action,'review_evidence');
 assert.equal(recoveryStatus({obligation:{state:'retry',blocker:'TECHNICAL_RETRY',next_attempt_at:'2030-01-01'}}).category,'transient');
 assert.equal(recoveryStatus({postprocessing:{code:'RUNBOOK_POSTPROCESSING_FAILED'}}).action,'postprocess-repair');
});
test('private parser rejects executable flags, duplicate flags and non-object JSON',()=>{
 const a=['cleanup-resume-preflight','--project','p','--request-json','{"obligation_id":"00000000-0000-4000-8000-000000000001"}'];
 assert.equal(parseRepairArgs(a).request.obligation_id,'00000000-0000-4000-8000-000000000001');
 for(const suffix of [['--command','echo'],['--manifest','/tmp/a'],['--project','other']])assert.throws(()=>parseRepairArgs([...a,...suffix]),/INVALID_ARGUMENT/);
 for(const text of ['null','[]','false','x'])assert.throws(()=>parseRepairArgs(['workflow-repair','--project','p','--request-json',text]),/INVALID_ARGUMENT/);
 assert.throws(()=>parseRepairArgs(['project.register','--project','p','--request-json','{}']),/INVALID_ARGUMENT/);
});
test('non-root private repair never reaches a database',async t=>{
 t.mock.method(process,'geteuid',()=>1002);
 await assert.rejects(runRepairOperator({query:()=>assert.fail('must not query')},{method:'workflow-repair','--project':'p',request:{}}),/OWNER_REQUIRED/);
});
test('review manifest is accepted only for attest with an absolute path',()=>{
 const a=['write-completion-attest','--call','00000000-0000-4000-8000-000000000001','--source','/root/source','--receipt','/root/receipt'];
 assert.equal(parseCompletionArgs([...a,'--review-manifest','/root/review'])['--review-manifest'],'/root/review');
 assert.throws(()=>parseCompletionArgs([...a,'--review-manifest','relative']),/INVALID_ARGUMENT/);
 assert.throws(()=>parseCompletionArgs(['write-completion-import','--receipt','/root/receipt','--review-manifest','/root/review']),/INVALID_ARGUMENT/);
});
