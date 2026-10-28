// ABOUTME: Принимает проверенный манифест исторической очистки в реестр Codeworks.
// ABOUTME: Проверяет фактические снимки и не удаляет ресурсы и не запускает старый workflow.
import {readFile,realpath} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {Pool} from 'pg';
import {createGit,command} from './git.mjs';
import {createCodeIndex} from './code-index.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
/** Канонический JSON сортирует ключи рекурсивно; массивы сохраняют порядок. */
export function canonical(value){
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  throw Error('INVALID_MANIFEST');
}
/** Проверяет digest и структуру, не считая флаг review доказательством происхождения. */
export function validateManifest(manifest,projectId){
  if(!manifest||Array.isArray(manifest)||manifest.manifestVersion!==1||manifest.reviewed!==true||manifest.project_id!==projectId||!/^[0-9a-f]{64}$/.test(manifest.manifest_sha256??'')||!Array.isArray(manifest.protected_task_ids)||manifest.protected_task_ids.some(id=>typeof id!=='string')||!Array.isArray(manifest.provenance)||!manifest.provenance.length||!manifest.disposition||!manifest.index||!manifest.branch||!manifest.ownership||!manifest.remote||!manifest.worktree)throw Error('INVALID_MANIFEST');
  const {manifest_sha256,...payload}=manifest;
  if(hash(canonical(payload))!==manifest_sha256)throw Error('MANIFEST_DIGEST_MISMATCH');
  if(!/^refs\/heads\/(?:feature|hotfix|codex)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.branch.ref??'')||manifest.remote.ref!==manifest.branch.ref||!path.isAbsolute(manifest.worktree.path??'')||path.normalize(manifest.worktree.path)!==manifest.worktree.path)throw Error('INVALID_MANIFEST');
  for(const item of manifest.provenance)if(!item||!['ownership-ref','reflog','workspace-record'].includes(item.kind)||typeof item.ref!=='string'||!/^[0-9a-f]{64}$/.test(item.sha256??''))throw Error('INVALID_PROVENANCE');
  return manifest;
}
const equal=(a,b)=>canonical(a)===canonical(b);
/** Проверяет точную область и сохраняет durable intent в одной транзакции; dry-run не пишет. */
export async function importCleanup(pool,projectId,manifest,{git,codeIndex,dryRun=false,allowedRepositories}={}){
  validateManifest(manifest,projectId);
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const row=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1 FOR SHARE',[projectId])).rows[0];
    const project=row?.config;if(!project||project.id!==projectId||project.common_dir!==manifest.common_dir||!Array.isArray(allowedRepositories)||!allowedRepositories.includes(project.repo_path))throw Error('PROJECT_MISMATCH');
    const root=path.dirname(manifest.worktree.path);
    if(!(project.legacy_workspace_roots??[]).includes(root)||await realpath(root)!==root)throw Error('LEGACY_ROOT_FORBIDDEN');
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['codeworks:cleanup-import:'+projectId+':'+manifest.branch.ref]);
    const matches=(await db.query('SELECT * FROM codeworks.workspaces WHERE project_id=$1 AND (id=$2 OR branch=$3 OR path=$4) FOR UPDATE',[projectId,manifest.workspace_id,manifest.branch.ref.slice(11),manifest.worktree.path])).rows;
    if(matches.length>1||matches.length===1&&(matches[0].id!==manifest.workspace_id||matches[0].branch!==manifest.branch.ref.slice(11)||matches[0].path!==manifest.worktree.path))throw Error('WORKSPACE_CONFLICT');
    const workspace=matches[0]??{id:manifest.workspace_id,project_id:projectId,branch:manifest.branch.ref.slice(11),path:manifest.worktree.path,base_sha:manifest.disposition.base_sha,kind:manifest.disposition.kind,ownership_token:null};
    if(workspace.id&&manifest.protected_task_ids.includes(workspace.id))throw Error('ACTIVE_OR_PENDING_WORK');
    if(workspace.id){
      const protectedRow=await db.query("SELECT 1 FROM codeworks.workflow_registry WHERE workspace_id=$1 AND lifecycle='active' UNION ALL SELECT 1 FROM codeworks.write_calls WHERE workspace_id=$1 AND state IN ('preparing','in_flight','uncertain') UNION ALL SELECT 1 FROM codeworks.operations WHERE workspace_id=$1 AND status IN ('pending','running','awaiting_ci','awaiting_deployment','awaiting_reconciliation') UNION ALL SELECT 1 FROM codeworks.release_queue q JOIN codeworks.operations o ON o.id=q.operation_id WHERE o.workspace_id=$1 AND q.state IN ('held','queued') LIMIT 1",[workspace.id]);
      if(protectedRow.rowCount)throw Error('ACTIVE_OR_PENDING_WORK');
    }
    const snapshot=await git.inspectResources(project,workspace,{manifest});
    for(const key of ['branch','remote'])if(!equal(snapshot[key],key==='remote'?{...manifest[key],known:true}:manifest[key]))throw Error('GIT_SNAPSHOT_CHANGED');
    if(snapshot.ownership.ref!==manifest.ownership.ref||snapshot.ownership.oid!==manifest.ownership.oid||snapshot.worktree.path!==manifest.worktree.path||snapshot.worktree.registered!==manifest.worktree.registered||snapshot.worktree.lock!==manifest.worktree.lock||snapshot.worktree.head!==manifest.worktree.head||snapshot.worktree.pathExists!==manifest.worktree.pathExists||snapshot.worktree.dirty!==manifest.worktree.dirty||!equal(snapshot.tracking,manifest.tracking))throw Error('GIT_SNAPSHOT_CHANGED');
    const index=await codeIndex.inspect(project,workspace,{manifest});
    if(index.complete!==true)throw Error('INDEX_SNAPSHOT_UNKNOWN');
    let proven=false;
    for(const p of manifest.provenance){
      if(p.kind==='workspace-record'&&matches[0]&&p.ref===workspace.id){
        const record={id:workspace.id,project_id:workspace.project_id,branch:workspace.branch,path:workspace.path,base_sha:workspace.base_sha};
        if(hash(canonical(record))===p.sha256)proven=true;
      }else if(p.kind==='ownership-ref'&&p.ref===snapshot.ownership.ref&&snapshot.ownership.oid){
        const result=await command('git',['-C',project.repo_path,'cat-file','blob',p.ref]);
        let marker;try{marker=JSON.parse(result.stdout);}catch{throw Error('PROVENANCE_UNVERIFIED');}
        if(hash(result.stdout)===p.sha256&&marker.workspace_id===p.ref.slice('refs/codeworks/ownership/'.length)&&marker.branch===workspace.branch&&marker.path===workspace.path)proven=true;
      }else if(p.kind==='reflog'&&p.ref===snapshot.branch.ref&&snapshot.branch.oid){
        const result=await command('git',['-C',project.repo_path,'reflog','show','--format=%H',p.ref],{allowFailure:true});
        if(result.code===0&&result.stdout.split('\n').includes(snapshot.branch.oid)&&hash(result.stdout)===p.sha256)proven=true;
      }
    }
    if(!proven)throw Error('PROVENANCE_UNVERIFIED');
    const disposition=manifest.disposition,head=snapshot.worktree.head??snapshot.branch.oid;
    let outcome='unused',state='waiting_decision',blocker='DISPOSITION_PROOF_REQUIRED';
    if(disposition.type==='unused'&&matches[0]&&/^[0-9a-f]{40}$/.test(workspace.base_sha)&&[head,snapshot.branch.oid,snapshot.remote.oid].every(v=>v===null||v===workspace.base_sha)&&(!snapshot.worktree.pathExists||snapshot.worktree.dirty===false)){
      outcome='unused';state='pending';blocker=null;
    }else if(disposition.type==='released'&&matches[0]&&typeof disposition.release_id==='string'){
      const release=(await db.query("SELECT * FROM codeworks.releases WHERE id=$1 AND workspace_id=$2 AND state='succeeded'",[disposition.release_id,workspace.id])).rows[0];
      const legs=workspace.kind==='hotfix'?[release?.details?.primary,release?.details?.backport]:[release?.details?.primary];
      let evidenceValid=!!release&&legs.every(l=>l?.merged&&l.deployment_evidence_id);
      if(evidenceValid)for(const leg of legs){const target=leg.target==='main'?'prod':'dev';const proof=await db.query('SELECT 1 FROM codeworks.deployment_evidence WHERE id=$1 AND project_id=$2 AND target=$3 AND commit_sha=$4',[leg.deployment_evidence_id,projectId,target,leg.merge_sha]);if(proof.rowCount!==1)evidenceValid=false;}
      if(evidenceValid&&[head,snapshot.branch.oid,snapshot.remote.oid].every(v=>v===null||v===release.requested_sha)){outcome='released';state='pending';blocker=null;}
    }
    const subject=matches[0]?'workspace:'+workspace.id:'legacy:'+manifest.manifest_sha256;
    const existing=(await db.query("SELECT id,evidence FROM codeworks.cleanup_obligations WHERE project_id=$1 AND subject_key=$2 AND state<>'done' FOR UPDATE",[projectId,subject])).rows[0];
    if(existing&&existing.evidence?.manifest?.manifest_sha256!==manifest.manifest_sha256)throw Error('CLEANUP_ALREADY_ADMITTED');
    const id=existing?.id??randomUUID();
    if(!dryRun&&!existing)await db.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,step,state,evidence,expected,blocker) VALUES($1,$2,$3,$4,$5,'remote',$6,$7::jsonb,$8::jsonb,$9)",[id,projectId,matches[0]?.id??null,subject,outcome,state,JSON.stringify({manifest,index_snapshot:index}),JSON.stringify(snapshot),blocker]);
    await db.query(dryRun?'ROLLBACK':'COMMIT');return {id,subject,state,blocker,duplicate:!!existing,dry_run:dryRun};
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}
/** Разбирает только фиксированную операторскую команду и абсолютный путь манифеста. */
export function parseArgs(args){
  if(args[0]!=='cleanup-import')throw Error('INVALID_ARGUMENT');
  const out={};for(let i=1;i<args.length;i++){const name=args[i];if(name==='--dry-run'){if(out.dryRun)throw Error('INVALID_ARGUMENT');out.dryRun=true;continue;}if(!['--project','--manifest'].includes(name)||out[name]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('INVALID_ARGUMENT');out[name]=args[++i];}
  if(!out['--project']||!path.isAbsolute(out['--manifest']??''))throw Error('INVALID_ARGUMENT');return out;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let pool;try{
    const args=parseArgs(process.argv.slice(2));const manifest=JSON.parse(await readFile(args['--manifest'],'utf8'));
    const databaseURL=process.env.CODEWORKS_DATABASE_URL??JSON.parse(readFileSync(process.env.CODEWORKS_DATABASE_CONFIG_FILE,'utf8')).app_url;
    pool=new Pool({connectionString:databaseURL,max:3,connectionTimeoutMillis:3000,statement_timeout:10000});
    const result=await importCleanup(pool,args['--project'],manifest,{git:createGit(),codeIndex:createCodeIndex(pool),dryRun:args.dryRun,allowedRepositories:JSON.parse(process.env.CODEWORKS_ALLOWED_REPOSITORIES??'[]')});console.log(JSON.stringify(result));
  }catch(error){console.error('Cleanup import failed: '+(/^[A-Z_]+$/.test(error.message)?error.message:'UNAVAILABLE'));process.exitCode=1;}finally{await pool?.end();}
}
