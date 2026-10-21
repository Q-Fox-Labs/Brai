// ABOUTME: Принимает подтверждение проверенной установки только от доверенного deployment verifier.
// ABOUTME: Не является методом NATS/MCP/agent tools; credentials этого входа нельзя выдавать агентам.
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {Pool} from 'pg';
/** Owner-порт будущего deployment: report означает выполненные rollout + health/acceptance, а не запрос установки. */
export async function recordDeployment(pool,report,{allowedRepositories=[]}={}) {
  if(!report||Object.keys(report).some(k=>!['project_id','target','commit_sha','evidence_url'].includes(k))||typeof report.project_id!=='string'||!['dev','prod'].includes(report.target)||!/^[0-9a-f]{40}$/.test(report.commit_sha)||typeof report.evidence_url!=='string'||report.evidence_url.length>2048||!/^https:\/\/[^\s]+$/.test(report.evidence_url))throw new Error('INVALID_DEPLOYMENT_REPORT');
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[report.project_id]);
    const project=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1',[report.project_id])).rows[0]?.config;
    if(!project||!allowedRepositories.includes(project.repo_path))throw new Error('FORBIDDEN_DEPLOYMENT_REPORT');
    const previous=(await db.query('SELECT * FROM codeworks.deployment_evidence WHERE project_id=$1 AND target=$2 AND evidence_url=$3',[report.project_id,report.target,report.evidence_url])).rows[0];
    if(previous&&previous.commit_sha!==report.commit_sha)throw new Error('DEPLOYMENT_REPORT_CONFLICT');
    if(previous){await db.query('COMMIT');return {id:previous.id};}
    const id=randomUUID();
    await db.query('INSERT INTO codeworks.deployment_evidence(id,project_id,target,commit_sha,evidence_url) VALUES($1,$2,$3,$4,$5)',[id,report.project_id,report.target,report.commit_sha,report.evidence_url]);
    await db.query('COMMIT');return {id};
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(!process.env.CODEWORKS_EVIDENCE_DATABASE_URL)throw new Error('TRUSTED_VERIFIER_CONFIGURATION_REQUIRED');
  const pool=new Pool({connectionString:process.env.CODEWORKS_EVIDENCE_DATABASE_URL,max:1});
  try{
    let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>65536)throw new Error('REPORT_TOO_LARGE');}
    console.log(JSON.stringify(await recordDeployment(pool,JSON.parse(input),{allowedRepositories:JSON.parse(process.env.CODEWORKS_ALLOWED_REPOSITORIES??'[]')})));
  }catch{console.error('Deployment evidence rejected; no release was claimed.');process.exitCode=1;}finally{await pool.end();}
}
