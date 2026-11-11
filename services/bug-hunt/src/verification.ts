// ABOUTME: Задаёт предметные данные и критерии доказанного вывода v3.
// ABOUTME: Модель предлагает вывод; сервер сверяет сохранённые bytes и receipts.
export type Executor = "codex_app_server" | "providers";
export type DefectVerdict = "confirmed" | "refuted" | "insufficient_evidence";
export type ExecutionState = "queued" | "running" | "waiting_dependency" | "blocked_policy" | "outcome_unknown" | "completed" | "failed" | "cancelled";
export type ReproductionOutcome = "reproduced" | "not_reproduced" | "not_attempted" | "blocked" | "invalid_test";
export interface Scope { installation_id:string; owner_id:string; investigation_id:string }
export interface Snapshot {
 version:3; cases:{case_id:string;report_id:string;input_hash:string;observation:Record<string,unknown>}[];
 group:{id:string;revision:number}|null; source:{id:string;commit:string;component_id:string}|null;
}
export interface Evidence {
 id:string; scope:Scope; kind:"requirement"|"source"|"diagnostic"|"artifact"|"runner";
 sha256:string; text:string; provenance:Record<string,unknown>;
 availability:"available"|"partial"|"unavailable"; external_allowed:boolean;
}
export interface Oracle { requirement_id:string; requirement_sha256:string; expected:string; version:string; refutes_claim?:string; confirms_claim?:string }
export interface RunnerReceipt {
 execution_id:string; scope:Scope; recipe_id:string; recipe_version:string;
 source_commit:string; source_sha256:string; source_tree_sha256:string;node_sha256:string;dependencies_sha256:string;spec_sha256:string; oracle_sha256:string;
 started_at:string|null; finished_at:string|null; exit_code:number|null;
 outcome:ReproductionOutcome; assertions:{name:string;expected:string;actual:string;passed:boolean}[];
 log_sha256:string; fidelity:"synthetic"; substituted_boundaries:string[];
 cleanup:"done"|"pending"; state:"completed"|"failed"|"unknown"|"cancelled";
}
export interface Candidate {
 claim:string; expected:string; facts:string[]; verdict:DefectVerdict;
 reproduction_outcome:ReproductionOutcome; observed_failure:"verified"|"contradicted"|"unknown";
 requirement_id:string|null; source_id:string|null; runner_id:string|null;
 evidence_ids:string[]; missing:string[]; limitations:string[];
}
export interface Review { accepted:boolean; candidate_sha256:string; evidence_ids:string[]; limitations:string[] }
export interface PinnedModel { id:string; effort:"high"|null; catalog_revision:string; resolver_version:"sol-stable-numeric-v1"|"providers-profile-v1" }
export interface ModelMetadata { id:string; supportedReasoningEfforts:{reasoningEffort:string}[]; hidden?:boolean }
export interface ModelIntent {
 id:string; scope:Scope; phase:"investigator"|"reviewer"; executor:Executor; config_hash:string;
 model:PinnedModel; deadline_at:string; input:Record<string,unknown>; input_hash:string;
}
export interface ModelCheckpoint {
 state:"not_sent"|"dispatching"|"running"|"completed"|"failed"|"unknown"|"blocked";
 native:Record<string,unknown>; result:unknown; code:string|null; usage:Record<string,unknown>|null;
}
/** Сохранение checkpoint предшествует эффекту; inspect не повторяет start. */
export interface InvestigationExecutor {
 preflight():Promise<{ready:boolean;code:string|null;models:ModelMetadata[];catalog_revision:string}>;
 startStep(intent:ModelIntent,save:(checkpoint:ModelCheckpoint)=>Promise<void>):Promise<ModelCheckpoint>;
 inspectStep(intent:ModelIntent,checkpoint:ModelCheckpoint,save:(checkpoint:ModelCheckpoint)=>Promise<void>):Promise<ModelCheckpoint>;
 cancelStep(intent:ModelIntent,checkpoint:ModelCheckpoint):Promise<ModelCheckpoint>;
 close?():void;
}
/** Повтор execution ID сверяет input hash; неизвестный запуск читается get. */
export interface ReproductionRunner {
 prepare(spec:RunSpec):Promise<{execution_id:string;spec_sha256:string;state:"prepared"}>;
 collect(scope:Scope,executionId:string):Promise<RunnerReceipt|null>;
 cleanup(scope:Scope,executionId:string):Promise<RunnerReceipt|null>;
 start(spec:RunSpec):Promise<RunnerReceipt>;
 get(scope:Scope,executionId:string):Promise<RunnerReceipt|null>;
 cancel(scope:Scope,executionId:string):Promise<RunnerReceipt>;
}
export interface RunSpec {
 execution_id:string; scope:Scope; recipe_id:string; recipe_version:string;
 source_id:string; source_commit:string; source_sha256:string;source_tree_sha256:string; spec_sha256:string;
 oracle:Oracle; oracle_sha256:string; fixture_ref:string; deadline_at:string;
}
/** Безопасное предметное ограничение без исходного тела или credentials. */
export class VerificationFault extends Error {
 constructor(public code:string,public outcome:"not_accepted"|"unknown"="not_accepted"){super(code);}
}
/** Выбирает canonical стабильные Sol численно; не угадывает preview и новые соглашения. */
export function resolveSol(models:ModelMetadata[],catalogRevision:string):PinnedModel {
 const stable=models.filter(m=>!m.hidden&&/^gpt-[1-9]\d*(?:\.\d+)?-sol$/.test(m.id));
 const version=(id:string)=>id.slice(4,-4).split(".").map(Number);
 stable.sort((a,b)=>{const x=version(a.id),y=version(b.id);return y[0]-x[0]||(y[1]??0)-(x[1]??0);});
 const latest=stable[0];
 if(!latest)throw new VerificationFault("SOL_CATALOG_UNAVAILABLE");
 if(!latest.supportedReasoningEfforts.some(e=>e.reasoningEffort==="high"))throw new VerificationFault("SOL_HIGH_UNAVAILABLE");
 if(!catalogRevision)throw new VerificationFault("CATALOG_REVISION_REQUIRED");
 return {id:latest.id,effort:"high",catalog_revision:catalogRevision,resolver_version:"sol-stable-numeric-v1"};
}
export const sameScope=(a:Scope,b:Scope)=>a.installation_id===b.installation_id&&a.owner_id===b.owner_id&&a.investigation_id===b.investigation_id;
/** Проверяет реальные bytes и receipts. Статическое LLM-доказательство не поддержано. */
export function validateResult(input:{scope:Scope;snapshot:Snapshot;candidate:Candidate;candidateHash:string;review:Review;evidence:Evidence[];receipt:RunnerReceipt|null;oracle:Oracle|null;hash:(value:unknown)=>string}) {
 const {scope,snapshot,candidate:c,review,evidence,receipt:r,oracle:o,hash}=input;
 const reject=(code:string):never=>{throw new VerificationFault(code);};
 if(!review.accepted||review.candidate_sha256!==input.candidateHash||input.candidateHash!==hash(c))reject("REVIEW_REJECTED");
 if(new Set(evidence.map(e=>e.id)).size!==evidence.length)reject("EVIDENCE_CONFLICT");
 for(const e of evidence)if(!sameScope(scope,e.scope)||e.sha256!==hash(e.text))reject("EVIDENCE_INTEGRITY");
 const byId=new Map(evidence.map(e=>[e.id,e]));
 if([...c.evidence_ids,...review.evidence_ids].some(id=>!byId.has(id)))reject("EVIDENCE_NOT_FOUND");
 if(!snapshot.cases.length||new Set(snapshot.cases.map(v=>v.case_id)).size!==snapshot.cases.length)reject("SNAPSHOT_INVALID");
 if(c.verdict==="insufficient_evidence")return {version:"runner-evidence-v1",verdict:c.verdict,scope,candidate_sha256:input.candidateHash};
 if(!snapshot.source||!c.requirement_id||!c.source_id||!c.runner_id||!r||!o)reject("PROOF_REQUIRED");
 const requirement=byId.get(c.requirement_id!),source=byId.get(c.source_id!);
 if(!requirement||requirement.kind!=="requirement"||requirement.availability!=="available"||
 !source||source.kind!=="source"||source.availability!=="available"||
 [source,requirement].some(e=>e.provenance.commit!==snapshot.source!.commit||e.provenance.source_id!==snapshot.source!.id||!e.provenance.blob_sha256))reject("PROOF_SOURCE_INVALID");
 if(![c.requirement_id,c.source_id,c.runner_id].every(id=>c.evidence_ids.includes(id!))||byId.get(c.runner_id!)?.kind!=="runner")reject("PROOF_REFS_INVALID");
 if(o!.requirement_id!==requirement!.id||o!.requirement_sha256!==requirement!.sha256||o!.expected!==c.expected||!o!.version)reject("ORACLE_INVALID");
 if(!sameScope(r!.scope,scope)||r!.source_commit!==snapshot.source!.commit||r!.source_sha256!==source!.provenance.blob_sha256||
 r!.oracle_sha256!==hash(o)||r!.state!=="completed"||!r!.finished_at||r!.exit_code!==0||r!.cleanup!=="done"||
 !r!.started_at||Date.parse(r!.finished_at)<Date.parse(r!.started_at)||!Number.isFinite(Date.parse(r!.finished_at))||
 !r!.assertions.length||r!.assertions.some(a=>a.expected!==o!.expected||a.passed!==(a.expected===a.actual))||
 hash(JSON.parse(byId.get(c.runner_id!)!.text))!==hash(r))reject("RECEIPT_INVALID");
 if(c.verdict==="confirmed"&&(r!.outcome!=="reproduced"||c.reproduction_outcome!=="reproduced"||c.observed_failure!=="verified"||o!.confirms_claim!==c.claim||r!.assertions.every(a=>a.passed)))reject("CONFIRMED_NOT_PROVEN");
 // AIDEV-NOTE: Зелёный тест не опровергает claim без явного требования, противоречащего ему.
 if(c.verdict==="refuted"&&(r!.outcome!=="not_reproduced"||c.observed_failure!=="contradicted"||c.reproduction_outcome!=="not_reproduced"||r!.assertions.some(a=>!a.passed)||o!.refutes_claim!==c.claim))reject("REFUTED_NOT_PROVEN");
 return {version:"runner-evidence-v1",verdict:c.verdict,scope,candidate_sha256:input.candidateHash,execution_id:r!.execution_id};
}
export interface VerificationPolicy {
 enabled:boolean;executor:Executor;revision:string;
 schedule:{enabled:boolean;intervalHours:number;manualEnabled:boolean;maxInvestigationsPerRun:number};
 externalAllowedOwners:string[];maxPending:number;maxDerivativeBytes:number;
 budgets:{dailyCalls:number;ownerDailyCalls:number;dailyTokens:number;attemptMs:number;toolCalls:number;runnerRuns:number};
 profiles:{codex_app_server:{endpointRef:string;revision:string};providers:{connectionId:string;provider:string;model:string;revision:string;inboxPrefix:string}};
}
/** Отсутствующий блок выключает dispatch и сохраняет v1/v2. Расписание по умолчанию — 6 часов. */
export function verificationPolicy(value:unknown):VerificationPolicy {
 const defaults:VerificationPolicy={enabled:false,executor:"codex_app_server",revision:"disabled-v1",schedule:{enabled:true,intervalHours:6,manualEnabled:true,maxInvestigationsPerRun:5},externalAllowedOwners:[],maxPending:100,maxDerivativeBytes:268435456,
 budgets:{dailyCalls:20,ownerDailyCalls:10,dailyTokens:100000,attemptMs:900000,toolCalls:24,runnerRuns:2},
 profiles:{codex_app_server:{endpointRef:"bug-hunt-codex",revision:"unprepared"},providers:{connectionId:"bug_hunt",provider:"openrouter",model:"deepseek/deepseek-v3.2",revision:"unprepared",inboxPrefix:"_INBOX.providers_client."}}};
 if(value===undefined)return defaults;
 if(!value||typeof value!=="object"||Array.isArray(value))throw new VerificationFault("CONFIG_ERROR");
 const raw=value as Record<string,unknown>;
 if(Object.keys(raw).some(k=>!Object.hasOwn(defaults,k)))throw new VerificationFault("CONFIG_ERROR");
 const p={...defaults,...raw,schedule:{...defaults.schedule,...raw.schedule as object},budgets:{...defaults.budgets,...raw.budgets as object},profiles:{...defaults.profiles,...raw.profiles as object}} as VerificationPolicy;
 for(const k of ["schedule","budgets","profiles"] as const)if(raw[k]!==undefined&&(!raw[k]||typeof raw[k]!=="object"||Array.isArray(raw[k])||Object.keys(raw[k]).some(x=>!Object.hasOwn(defaults[k],x))))throw new VerificationFault("CONFIG_ERROR");
 if(typeof p.enabled!=="boolean"||!["codex_app_server","providers"].includes(p.executor)||typeof p.revision!=="string"||!p.revision||p.revision.length>100||
 !Array.isArray(p.externalAllowedOwners)||p.externalAllowedOwners.length>100||p.externalAllowedOwners.some(v=>typeof v!=="string"||!v||v.length>255)||
 typeof p.schedule.enabled!=="boolean"||typeof p.schedule.manualEnabled!=="boolean")throw new VerificationFault("CONFIG_ERROR");
 const bounded=(n:number,min:number,max:number)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
 if(!bounded(p.schedule.intervalHours,1,168)||!bounded(p.schedule.maxInvestigationsPerRun,1,5)||!bounded(p.maxPending,1,1000)||!bounded(p.maxDerivativeBytes,16777216,1073741824)||
 !bounded(p.budgets.dailyCalls,0,1000)||!bounded(p.budgets.ownerDailyCalls,0,p.budgets.dailyCalls)||!bounded(p.budgets.dailyTokens,0,10000000)||
 !bounded(p.budgets.attemptMs,1000,900000)||!bounded(p.budgets.toolCalls,0,24)||!bounded(p.budgets.runnerRuns,0,2))throw new VerificationFault("CONFIG_ERROR");
 for(const key of ["codex_app_server","providers"] as const){const profile=p.profiles[key],def=defaults.profiles[key];
 if(!profile||typeof profile!=="object"||Object.keys(profile).some(k=>!Object.hasOwn(def,k))||Object.keys(def).some(k=>typeof (profile as any)[k]!=="string"||!(profile as any)[k]||(profile as any)[k].length>200))throw new VerificationFault("CONFIG_ERROR");}
 return structuredClone(p);
}
/** Невалидный reload сохраняет целиком последнюю действующую ревизию. */
export function policyReader(read:()=>unknown) {
 let current=verificationPolicy(read()),error:string|null=null;
 return {get(){try{current=verificationPolicy(read());error=null;}catch{error="CONFIG_ERROR";}return structuredClone(current);},status(){return {revision:current.revision,config_error:error};}};
}
