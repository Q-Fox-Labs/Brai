// ABOUTME: Удостоверяет настоящий Actions job и GHCR composition точного commit.
// ABOUTME: Только owner runtime подключает этот read-only порт; agent report не является доказательством.
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import {descriptorValidator} from '../components/descriptor-validation.mjs';
import {verifyCatalog,catalogContains,catalogPackage} from '../ci/catalog.mjs';
const validateComposition=descriptorValidator(JSON.parse(readFileSync(new URL('../schemas/ci-composition.schema.json',import.meta.url),'utf8')));
const hash=value=>createHash('sha256').update(value).digest('hex');
const workflow='.github/workflows/codeworks.yml';
export const recipeFiles=[
  '.github/workflows/codeworks.yml','services/codeworks/ci/pipeline.mjs','services/codeworks/ci/registry.mjs','services/codeworks/ci/catalog.mjs','services/codeworks/ci/toolchain.json',
  'services/codeworks/components/graph.mjs','services/codeworks/components/cli.mjs','services/codeworks/components/lock-inputs.mjs','services/codeworks/components/descriptor-validation.mjs','services/codeworks/components/package-runtime.mjs','services/codeworks/schemas/component.schema.json','services/codeworks/schemas/ci-composition.schema.json','services/codeworks/src/ci-verifier.mjs',
];
const match=(value,expected)=>Object.entries(expected).every(([key,item])=>value?.[key]===item);
const no=state=>({verified:false,state});
export const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
/** Проверяет все исполняемые build/verification recipe bytes на exact source, без доверия label. */
export async function verifyRecipeAt(api,sha,expected) {
  const digest=createHash('sha256').update('{}');
  for(const path of [...recipeFiles].sort()) {
    const file=await api(`contents/${path}?ref=${sha}`);
    if(file.encoding!=='base64')return false;
    digest.update(path).update('\0').update(Buffer.from(file.content,'base64')).update('\0');
  }
  return digest.digest('hex')===expected;
}
/** Читает единственный result JSON из GitHub immutable ZIP; digest проверяется до распаковки. */
export async function downloadProof({repository,token},artifact,{fetcher=fetch}={}) {
  if(!Number.isSafeInteger(artifact.id)||!/^sha256:[0-9a-f]{64}$/.test(artifact.digest)||artifact.size_in_bytes>2*1024*1024)throw Error('CI_PROOF_METADATA_INVALID');
  const response=await fetcher(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error('CI_PROOF_DOWNLOAD_UNAVAILABLE');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>2*1024*1024||'sha256:'+hash(bytes)!==artifact.digest)throw Error('CI_PROOF_DIGEST_MISMATCH');
  let result;
  for(let cursor=0;cursor+46<=bytes.length;cursor++)if(bytes.readUInt32LE(cursor)===0x02014b50) {
    const compressed=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24),nameLength=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),offset=bytes.readUInt32LE(cursor+42);
    if(cursor+46+nameLength+extra+comment>bytes.length||offset+30>bytes.length||bytes.readUInt32LE(offset)!==0x04034b50)throw Error('CI_PROOF_ZIP_INVALID');
    const name=bytes.subarray(cursor+46,cursor+46+nameLength).toString();
    if(name==='ci-result.json') {
      if(result!==undefined||size>4*1024*1024)throw Error('CI_PROOF_ZIP_INVALID');
      const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28),method=bytes.readUInt16LE(cursor+10);
      if(start+compressed>bytes.length||![0,8].includes(method))throw Error('CI_PROOF_ZIP_INVALID');
      const content=method===8?inflateRawSync(bytes.subarray(start,start+compressed),{maxOutputLength:4*1024*1024}):bytes.subarray(start,start+compressed);
      if(content.length!==size)throw Error('CI_PROOF_ZIP_INVALID');result=JSON.parse(content);
    }
    cursor+=45+nameLength+extra+comment;
  }
  if(!result)throw Error('CI_PROOF_FILE_MISSING');return result;
}
/** Находит только proof указанной попытки в подлинном Actions artifact service. */
export async function loadRunProof(api,readProof,runId,attempt,source) {
  const list=await api(`actions/runs/${runId}/artifacts?per_page=100`);
  if(!Array.isArray(list.artifacts)||list.total_count!==list.artifacts.length||list.total_count>100)throw Error('CI_PROOF_LIST_INVALID');
  const matching=list.artifacts.filter(a=>a.name===`codeworks-proof-${runId}-${attempt}`);
  if(matching.length!==1||matching[0].expired||String(matching[0].workflow_run?.id)!==String(runId)||matching[0].workflow_run?.head_sha!==source)throw Error('CI_PROOF_IDENTITY_MISMATCH');
  return readProof(matching[0]);
}
/** API и registry читаются независимо от agent input; policy закрепляет workflow и recipe bytes. */
export async function verifyCI(project,sha,checks,{api,registry,readProof,readVerified=async()=>null,saveVerified=async()=>{}}) {
  const policy=project.github.ci,repository=project.github.repository;
  if(!policy)return no('CI_POLICY_REQUIRED');
  const candidates=checks.filter(c=>c.name===policy.check_name&&c.app?.id===policy.app_id&&c.head_sha===sha);
  if(candidates.length!==1)return no('EXACT_CI_CHECK_REQUIRED');
  const check=candidates[0];
  if(check.status!=='completed'||check.conclusion!=='success') {
    const annotations=await api(`check-runs/${check.id}/annotations?per_page=100`);
    if(Array.isArray(annotations)&&annotations.some(a=>/spending limit|billing|payments have failed|budget/i.test(a.message??'')))return no('CI_BILLING_BLOCKED');
    return no('EXACT_CI_SUCCESS_REQUIRED');
  }
  const url=new URL(check.details_url??'https://invalid/');
  const parsed=url.pathname.match(/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/job\/\d+)?$/);
  if(url.origin!=='https://github.com'||!parsed||parsed[1].toLowerCase()!==repository.toLowerCase())return no('CI_RUN_IDENTITY_MISMATCH');
  const runId=parsed[2],run=await api(`actions/runs/${runId}`);
  if(!match(run,{head_sha:sha,path:workflow,event:'push',status:'completed',conclusion:'success'})||run.repository?.full_name?.toLowerCase()!==repository.toLowerCase()||!Number.isInteger(run.run_attempt)||run.run_attempt<1)return no('CI_RUN_IDENTITY_MISMATCH');
  const jobs=await api(`actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`);
  if(jobs.total_count!==1||jobs.jobs?.length!==1)return no('CI_JOB_IDENTITY_MISMATCH');
  const job=jobs.jobs[0];
  if(!match(job,{name:policy.check_name,head_sha:sha,status:'completed',conclusion:'success'})||job.check_run_url!==`https://api.github.com/repos/${repository}/check-runs/${check.id}`||job.labels?.length!==1||job.labels[0]!=='ubuntu-24.04')return no('CI_JOB_IDENTITY_MISMATCH');
  const content=await api(`contents/${workflow}?ref=${sha}`);
  if(content.encoding!=='base64'||hash(Buffer.from(content.content,'base64'))!==policy.workflow_sha256)return no('CI_WORKFLOW_UNTRUSTED');
  if(!await verifyRecipeAt(api,sha,policy.recipe_sha256))return no('CI_RECIPE_UNTRUSTED');
  const hit=await registry.lookup('release',`run-${runId}-${run.run_attempt}`);
  if(!hit||!/^sha256:[0-9a-f]{64}$/.test(hit.digest)||!match(hit.metadata,{format:'brai-ci-object-v1',repository,source:sha,runId,attempt:String(run.run_attempt),kind:'composition',recipe:policy.recipe_sha256}))return no('CI_COMPOSITION_IDENTITY_MISMATCH');
  const manifest=await registry.readJSON('release',hit.digest,'release.json');
  if(!validateComposition(manifest))return no('CI_COMPOSITION_SCHEMA_INVALID');
  if(!match(manifest,{format:'brai-release-composition-v1',repository,source:sha,runId,attempt:String(run.run_attempt),workflow,recipe:policy.recipe_sha256})||manifest.billing?.state!=='hard-stop-confirmed'||!Array.isArray(manifest.components)||!manifest.components.length||new Set(manifest.components.map(c=>c.id)).size!==manifest.components.length)return no('CI_COMPOSITION_IDENTITY_MISMATCH');
  // Источники reuse принадлежат прошлому успешному exact run того же доверенного recipe.
  const proof=await readVerified(runId,run.run_attempt)??await loadRunProof(api,readProof,runId,run.run_attempt,sha);
  if(proof.published?.digest!==hit.digest||!equal(proof.composition,manifest))return no('CI_RUN_DIGEST_MISMATCH');
  let catalog;
  if(manifest.reuseCatalog) {
    const ref=manifest.reuseCatalog;
    if(ref.reference!==`ghcr.io/${repository.toLowerCase()}-components/${catalogPackage}@${ref.digest}`)return no('CI_CATALOG_IDENTITY_MISMATCH');
    catalog=await registry.readJSON(catalogPackage,ref.digest,'catalog.json');
    if(!verifyCatalog(catalog,policy.reuse_public_key,{repository,recipe:policy.recipe_sha256}))return no('CI_CATALOG_UNTRUSTED');
  }
  const sources=new Map([[sha,Promise.resolve(true)]]),runs=new Map(),proofs=new Map([[runId+'/'+run.run_attempt,Promise.resolve(proof)]]);
  for(const component of manifest.components)for(const kind of ['artifact','check',...(component.build?['build']:[])]) {
    const expectedKind=kind==='artifact'?'runtime':kind,reference=component[kind],key=kind==='artifact'?component.keys?.artifact:kind==='build'?component.keys?.build:component.keys?.checks;
    if(!/^[a-z][a-z0-9-]*$/.test(component.id)||!reference||!/^sha256:[0-9a-f]{64}$/.test(reference.digest)||reference.reference!==`ghcr.io/${repository.toLowerCase()}-components/${component.id}@${reference.digest}`)return no('CI_ARTIFACT_IDENTITY_MISMATCH');
    const actual=await registry.lookup(component.id,reference.digest),m=actual?.metadata;
    if(!match(m,{format:'brai-ci-object-v1',repository,recipe:policy.recipe_sha256,kind:expectedKind,key})||!equal(reference.metadata,m)||!/^\d+$/.test(m.runId)||!/^\d+$/.test(m.attempt)||!/^[0-9a-f]{40}$/.test(m.source))return no('CI_ARTIFACT_IDENTITY_MISMATCH');
    const runKey=m.runId+'/'+m.attempt;if(!runs.has(runKey))runs.set(runKey,api(`actions/runs/${m.runId}/attempts/${m.attempt}`));
    const origin=await runs.get(runKey);
    if(!match(origin,{head_sha:m.source,path:workflow,event:'push',status:'completed',conclusion:'success'})||String(origin.run_attempt)!==m.attempt||origin.repository?.full_name!==repository)return no('CI_REUSE_ORIGIN_UNVERIFIED');
    if(!sources.has(m.source))sources.set(m.source,verifyRecipeAt(api,m.source,policy.recipe_sha256));
    if(!await sources.get(m.source))return no('CI_REUSE_RECIPE_UNTRUSTED');
    if(catalogContains(catalog,component.id,actual))continue;
    if(!proofs.has(runKey))proofs.set(runKey,(async()=>await readVerified(m.runId,m.attempt)??await loadRunProof(api,readProof,m.runId,m.attempt,m.source))());
    const originProof=await proofs.get(runKey),originComponent=originProof.composition?.components?.find(c=>c.id===component.id);
    if(originComponent?.[kind]?.digest!==reference.digest||(kind==='artifact'?originComponent?.keys?.artifact:kind==='build'?originComponent?.keys?.build:originComponent?.keys?.checks)!==key)return no('CI_REUSE_DIGEST_UNVERIFIED');
  }
  await saveVerified(proof);
  return {verified:true,state:'CI_VERIFIED',evidence:{run_id:runId,attempt:run.run_attempt,head_sha:sha,workflow,recipe:policy.recipe_sha256,composition_digest:hit.digest,composition_reference:hit.reference,url:`https://github.com/${repository}/actions/runs/${runId}`}};
}
