// ABOUTME: Ставит exact owner-verified состав в durable rollout и принимает проверенный receipt.
// ABOUTME: Ansible adapter задаёт оператор; NATS/agent не выбирает программу, пути или proof.
import {randomUUID} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {command} from './git.mjs';
import {createCIEvidence} from './ci-evidence.mjs';
import {canonical} from './ci-verifier.mjs';
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
/** Сравнивает candidate только с фактически проверенными digest; unknown bootstrap явен. */
export function deploymentDiff(composition,actual) {
  const known=new Map((actual?.components??[]).map(c=>[c.id,c.artifact.digest]));
  return {bootstrap:!actual,changed:composition.components.filter(c=>known.get(c.id)!==c.artifact.digest).map(c=>c.id),unchanged:composition.components.filter(c=>known.get(c.id)===c.artifact.digest).map(c=>c.id)};
}
/** Вызывается worker после exact CI gate; proof загружается из owner store, не из запроса. */
export async function enqueueDeployment(db,project,target,sha,evidence,evidenceDB=db) {
  if(!['dev','prod'].includes(target)||evidence?.head_sha!==sha)throw Error('DEPLOYMENT_CI_REQUIRED');
  const proof=await createCIEvidence(evidenceDB).read(project,evidence.run_id,evidence.attempt),c=proof?.composition;
  if(!c||c.source!==sha||c.recipe!==project.github.ci.recipe_sha256||proof.published?.digest!==evidence.composition_digest)throw Error('DEPLOYMENT_OWNER_PROOF_REQUIRED');
  const old=(await db.query('SELECT operation_id FROM codeworks.deployments WHERE project_id=$1 AND target=$2 AND run_id=$3 AND attempt=$4',[project.id,target,String(evidence.run_id),String(evidence.attempt)])).rows[0];
  if(old)return old.operation_id;
  const id=randomUUID();
  await db.query('BEGIN');
  try {
    await db.query("INSERT INTO codeworks.operations(id,project_id,executor_id,kind,status,step,request) VALUES($1,$2,'codeworks_owner','rollout','pending','verified-ci',$3)",[id,project.id,{target,commit_sha:sha,ci:evidence}]);
    await db.query('INSERT INTO codeworks.deployments(operation_id,project_id,target,commit_sha,run_id,attempt,composition_digest,composition) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,project.id,target,sha,String(evidence.run_id),String(evidence.attempt),evidence.composition_digest,c]);
    await db.query('COMMIT');return id;
  }catch(error){await db.query('ROLLBACK');throw error;}
}
/** Root-owned operator config contains only fixed argv; UUID is the sole varying command argument. */
export function createDeploymentAdapter(configFile=process.env.CODEWORKS_DEPLOYMENT_CONFIG) {
  if(!configFile)return null;
  const info=lstatSync(configFile);
  if(!info.isFile()||info.uid!==0||(info.mode&0o022))throw Error('UNTRUSTED_DEPLOYMENT_ADAPTER');
  const cfg=JSON.parse(readFileSync(configFile,'utf8'));
  if(!Array.isArray(cfg.command)||!cfg.command.length||!cfg.command[0].startsWith('/')||cfg.command.some(a=>typeof a!=='string'||a.includes('\0')))throw Error('DEPLOYMENT_ADAPTER_INVALID');
  return async id=>{
    if(!/^[0-9a-f-]{36}$/.test(id))throw Error('DEPLOYMENT_ID_INVALID');
    const result=await command(cfg.command[0],[...cfg.command.slice(1),id],{timeout:120000});
    return JSON.parse(result.stdout);
  };
}
/** Bounded poll starts/reconciles one managed Ansible operation; success atomically records installed + evidence. */
export async function advanceDeployment(db,op,adapter) {
  if(!adapter)return {status:'awaiting_deployment',reason:'DEPLOYMENT_ADAPTER_REQUIRED'};
  const d=(await db.query('SELECT * FROM codeworks.deployments WHERE operation_id=$1',[op.id])).rows[0];
  const result=await adapter(op.id);
  if(result.status==='running')return {status:'awaiting_deployment',reason:'ANSIBLE_ROLLOUT_RUNNING'};
  if(result.status==='failed') {
    await db.query('UPDATE codeworks.deployments SET receipt=$2 WHERE operation_id=$1',[op.id,result]);
    return {status:'failed',reason:'ANSIBLE_ROLLOUT_FAILED'};
  }
  const r=result.receipt;
  if(result.status!=='succeeded'||r?.operation_id!==op.id||r.project_id!==d.project_id||r.target!==d.target||r.commit_sha!==d.commit_sha||r.composition_digest!==d.composition_digest||!equal(r.composition,d.composition)||r.verified!==true)throw Error('DEPLOYMENT_RECEIPT_MISMATCH');
  await db.query('BEGIN');
  try {
    await db.query('UPDATE codeworks.deployments SET receipt=$2 WHERE operation_id=$1',[op.id,r]);
    await db.query('INSERT INTO codeworks.installed(project_id,target,operation_id,composition) VALUES($1,$2,$3,$4) ON CONFLICT(project_id,target) DO UPDATE SET previous_composition=codeworks.installed.composition,composition=excluded.composition,operation_id=excluded.operation_id,updated_at=clock_timestamp() WHERE codeworks.installed.operation_id<>excluded.operation_id',[d.project_id,d.target,op.id,d.composition]);
    await db.query('INSERT INTO codeworks.deployment_evidence(id,project_id,target,commit_sha,evidence_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,target,evidence_url) DO NOTHING',[randomUUID(),d.project_id,d.target,d.commit_sha,r.evidence_url]);
    await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}
  return {status:'succeeded',reason:'ANSIBLE_ROLLOUT_VERIFIED'};
}
