// ABOUTME: Проверяет переходы долговечного состояния веб-превью без внешних адаптеров.
// ABOUTME: Особое внимание — незавершённому действию и сроку аренды.
import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {observePreview,renewPreview,acceptPreviewProof,beginPreviewAction,reconcilePreviewAction} from '../src/preview-domain.mjs';
const a='a'.repeat(40),b='b'.repeat(40),digest='sha256:'+'c'.repeat(64),image='ghcr.io/repo/web@'+digest,now='2026-01-01T00:00:00.000Z';
const proof={head_sha:a,run_id:'1',attempt:1,policy_sha256:'d'.repeat(64),composition_digest:digest};
const initial=()=>({id:'preview',desired_sha:a,generation:1,state:'waiting_ci',action:null,slot_id:null,queue_ticket:null});
const queued=()=>acceptPreviewProof(initial(),1,proof,image,7);
const publishing=()=>beginPreviewAction(queued(),'publish','01');
test('CI proof requires exact SHA and immutable image',()=>{
 assert.throws(()=>acceptPreviewProof(initial(),1,{...proof,head_sha:b},image,7),/PROOF_INVALID/);
 assert.equal(acceptPreviewProof(initial(),2,proof,image,7).state,'waiting_ci');
 assert.equal(queued().queue_ticket,7);
});
test('new pushes coalesce until old action has a confirmed outcome',()=>{
 let row=observePreview(publishing(),b);
 assert.equal(row.desired_sha,a);assert.equal(row.pending_sha,b);
 row=reconcilePreviewAction(row,{preview_id:'preview',generation:1,status:'ready',deployed_sha:a,image_reference:image},now,172800);
 assert.equal(row.state,'waiting_ci');assert.equal(row.desired_sha,b);assert.equal(row.deployed_sha,a);assert.equal(row.slot_id,'01');assert.equal(row.generation,2);
});
test('unknown and stale results do not release slots or replace desired',()=>{
 const row=publishing();
 assert.equal(reconcilePreviewAction(row,{preview_id:'preview',generation:1,status:'unknown'},now,172800),row);
 assert.equal(reconcilePreviewAction(row,{preview_id:'preview',generation:2,status:'ready',deployed_sha:a,image_reference:image},now,172800),row);
});
test('failed update preserves confirmed old version',()=>{
 const row={...publishing(),deployed_sha:b,deployed_image_reference:image,deployed_generation:0};
 assert.equal(reconcilePreviewAction(row,{preview_id:'preview',generation:1,status:'failed',deployed_sha:b,image_reference:image},now,172800).deployed_sha,b);
 assert.equal(reconcilePreviewAction(row,{preview_id:'preview',generation:1,status:'failed',deployed_sha:null,image_reference:null},now,172800),row);
});
test('same SHA renews once; polling does not resurrect expired preview',()=>{
 const ready=reconcilePreviewAction(publishing(),{preview_id:'preview',generation:1,status:'ready',deployed_sha:a,image_reference:image},now,172800);
 const renewed=renewPreview(ready,'sync-1',a,'2026-01-02T00:00:00.000Z',172800);
 assert.equal(renewed.expires_at,'2026-01-04T00:00:00.000Z');
 assert.equal(renewPreview(renewed,'sync-1',a,'2026-01-03T00:00:00.000Z',172800),renewed);
 const expired={...renewed,state:'expired',slot_id:null};assert.equal(observePreview(expired,a),expired);
 assert.equal(renewPreview(expired,'sync-2',a,now,172800).state,'waiting_ci');
});
test('removal is confirmed before freeing the slot',()=>{
 const row=beginPreviewAction({...publishing(),action:null,state:'ready'},'remove');
 assert.equal(reconcilePreviewAction(row,{preview_id:'preview',generation:1,status:'unknown'},now,172800),row);
 assert.equal(reconcilePreviewAction(row,{preview_id:'preview',generation:1,status:'absent'},now,172800).slot_id,null);
});
test('несовместимый протокол сообщает unsupported и сохраняет предыдущую версию',()=>{
 const row={...publishing(),deployed_sha:b,deployed_image_reference:image,deployed_generation:1};
 const result=reconcilePreviewAction(row,{preview_id:'preview',generation:1,status:'failed',error_code:'PREVIEW_PROTOCOL_UNSUPPORTED',deployed_sha:b,image_reference:image},now,172800);
 assert.equal(result.state,'unsupported');assert.equal(result.error,'PREVIEW_PROTOCOL_UNSUPPORTED');assert.equal(result.deployed_sha,b);assert.equal(result.slot_id,'01');
});
