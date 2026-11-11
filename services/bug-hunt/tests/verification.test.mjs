// ABOUTME: Проверяет доказательные критерии, конфигурацию и выбор Sol v3 на независимых контрольных данных.
// ABOUTME: Модельный текст не служит oracle; негативные примеры должны блокировать ложные выводы.
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {resolveSol,verificationPolicy,policyReader,validateResult} from "../dist/verification.js";
import {verificationHash as hash} from "../dist/verification-store.js";
import {validateVerification} from "../dist/verification-api.js";
const model=(id,efforts=["high"])=>({id,supportedReasoningEfforts:efforts.map(reasoningEffort=>({reasoningEffort}))});
test("Sol resolver orders numeric versions and never downgrades effort/family",()=>{
 assert.equal(resolveSol([model("gpt-6.9-sol"),model("gpt-6.10-sol"),model("gpt-99-sol-preview"),model("gpt-99-astra")],"catalog").id,"gpt-6.10-sol");
 assert.throws(()=>resolveSol([model("gpt-6.9-sol"),model("gpt-6.10-sol",["low"])],"c"),e=>e.code==="SOL_HIGH_UNAVAILABLE");
 assert.throws(()=>resolveSol([model("future-sol-6")],"c"),e=>e.code==="SOL_CATALOG_UNAVAILABLE");
});
test("configuration defaults, one executor switch and atomic invalid reload",()=>{
 const first=verificationPolicy(undefined);assert.equal(first.executor,"codex_app_server");assert.equal(first.schedule.intervalHours,6);assert.equal(first.schedule.manualEnabled,true);
 let raw={...first,enabled:true,revision:"one"},reader=policyReader(()=>raw);
 raw={...raw,executor:"providers",revision:"two"};assert.equal(reader.get().executor,"providers");
 raw={...raw,schedule:{...raw.schedule,maxInvestigationsPerRun:100}};assert.equal(reader.get().revision,"two");assert.equal(reader.status().config_error,"CONFIG_ERROR");
 for(const field of [{executor:"automatic"},{schedule:{manualEnabled:1}},{profiles:{providers:{model:"foreign"}}},{budgets:{toolCalls:25}}])assert.throws(()=>verificationPolicy(field));
});
test("closed API refuses model/owner injection and validates Unicode",()=>{
 for(const target of [{kind:"case",id:randomUUID()},{kind:"pending"}])assert.doesNotThrow(()=>validateVerification("run-request",{request_id:"one",target}));
 for(const extra of [{owner_id:"foreign"},{executor:"providers"},{reviewer:true},{command:"shell"}])assert.throws(()=>validateVerification("run-request",{request_id:"one",target:{kind:"pending"},...extra}));
 assert.throws(()=>validateVerification("review",{request_id:"x",investigation_id:randomUUID(),expected_revision:0,verdict:"confirmed",explanation:"\ud800"}));
});
function fixture(verdict="confirmed"){
 const scope={installation_id:"synthetic-installation",owner_id:"synthetic-owner",investigation_id:randomUUID()},commit="a".repeat(40),claim=verdict==="refuted"?"Contract rejection is a defect":"Valid zero was rejected";
 const evidence=(kind,text,provenance={})=>({id:randomUUID(),scope,kind,text,sha256:hash(text),provenance,external_allowed:true,availability:"available"});
 const requirement=evidence("requirement","Accept zero; reject a negative integer",{commit,source_id:"fixture",blob_sha256:hash("Accept zero; reject a negative integer")}),source=evidence("source","export const accept = x => x > 0",{commit,source_id:"fixture",blob_sha256:hash("export const accept = x => x > 0")});
 const oracle={requirement_id:requirement.id,requirement_sha256:requirement.sha256,expected:verdict==="refuted"?"rejected":"accepted",version:"independent-spec-v1",...(verdict==="confirmed"?{confirms_claim:claim}:{}),...(verdict==="refuted"?{refutes_claim:claim}:{})};
 const receipt={execution_id:randomUUID(),scope,recipe_id:"contract-fixture",recipe_version:"1",source_commit:commit,source_sha256:source.sha256,spec_sha256:hash("spec"),oracle_sha256:hash(oracle),started_at:"2026-11-11T00:00:00Z",finished_at:"2026-11-11T00:00:01Z",exit_code:0,outcome:verdict==="refuted"?"not_reproduced":"reproduced",assertions:[{name:"boundary zero or negative",expected:oracle.expected,actual:"rejected",passed:verdict==="refuted"}],log_sha256:hash("log"),fidelity:"synthetic",substituted_boundaries:["network","user_data"],cleanup:"done",state:"completed"};
 const run=evidence("runner",JSON.stringify(receipt)),candidate={claim,expected:oracle.expected,facts:["Observed synthetic boundary"],verdict,reproduction_outcome:receipt.outcome,observed_failure:verdict==="refuted"?"contradicted":"verified",requirement_id:requirement.id,source_id:source.id,runner_id:run.id,evidence_ids:[requirement.id,source.id,run.id],missing:[],limitations:["Synthetic fixture"]};
 return {scope,snapshot:{version:3,cases:[{case_id:randomUUID(),report_id:randomUUID(),input_hash:hash("original"),observation:{}}],group:null,source:{id:"fixture",commit,component_id:"fixture"}},candidate,candidateHash:hash(candidate),review:{accepted:true,candidate_sha256:hash(candidate),evidence_ids:candidate.evidence_ids,limitations:[]},evidence:[requirement,source,run],receipt,oracle,hash};
}
test("confirmed, explicit refuted and honest insufficient use three distinct criteria",()=>{
 for(const verdict of ["confirmed","refuted"])assert.equal(validateResult(fixture(verdict)).verdict,verdict);
 const f=fixture();f.candidate={...f.candidate,verdict:"insufficient_evidence",runner_id:null,reproduction_outcome:"not_attempted",observed_failure:"unknown",missing:["No supported recipe"]};f.candidateHash=hash(f.candidate);f.review.candidate_sha256=f.candidateHash;f.receipt=null;f.oracle=null;assert.equal(validateResult(f).verdict,"insufficient_evidence");
});
test("false conclusions fail on version, owner, hash, receipt, reviewer or missing oracle",()=>{
 const mutations=[
 f=>{f.receipt.source_commit="b".repeat(40);},
 f=>{f.evidence[0].scope={...f.scope,owner_id:"foreign"};},
 f=>{f.evidence[0].text="altered";},
 f=>{f.receipt.cleanup="pending";},
 f=>{f.receipt.exit_code=null;},
 f=>{f.receipt.state="unknown";},
 f=>{f.receipt.assertions=[];},
 f=>{f.receipt=null;},
 f=>{f.review.accepted=false;},
 f=>{f.oracle.requirement_id=randomUUID();}
 ];
 for(const mutate of mutations){const f=fixture();mutate(f);assert.throws(()=>validateResult(f));}
});
test("not reproduced alone never refutes a claim",()=>{
 const f=fixture("refuted");delete f.oracle.refutes_claim;f.receipt.oracle_sha256=hash(f.oracle);const run=f.evidence.at(-1);run.text=JSON.stringify(f.receipt);run.sha256=hash(run.text);assert.throws(()=>validateResult(f),e=>e.code==="REFUTED_NOT_PROVEN");
});
