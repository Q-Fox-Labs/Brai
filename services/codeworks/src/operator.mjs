// ABOUTME: Принимает проверенный манифест исторической очистки в реестр Codeworks.
// ABOUTME: Проверяет фактические снимки и не удаляет ресурсы и не запускает старый workflow.
import {readFile,realpath} from 'node:fs/promises';
import {readFileSync,constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {Pool} from 'pg';
import {createGit,command,assertCleanupRoot} from './git.mjs';
import {createCodeIndex} from './code-index.mjs';
import {createFlowGit} from './git-flow.mjs';
import {verifyCleanupArchive} from './cleanup-archive.mjs';
import {createBranchCleanup} from './branch-cleanup.mjs';
import {attestNativeCompletion,assertRootDirectory,importNativeCompletion} from './write-completion.mjs';

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
  if(!/^refs\/heads\/(?:feature|hotfix|codex)\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.branch.ref??'')||manifest.remote.ref!==manifest.branch.ref)throw Error('INVALID_MANIFEST');
  if(manifest.subject_type==='branch'){
    if(manifest.workspace_id!==null||manifest.ownership.ref!==null||manifest.ownership.oid!==null||manifest.worktree.path!==null||manifest.worktree.registered!==false||manifest.index.scope!=='not_allocated_by_codeworks'||manifest.disposition.type!=='archived'||!manifest.provenance.some(p=>p?.kind==='reflog'))throw Error('INVALID_MANIFEST');
  }else if(!path.isAbsolute(manifest.worktree.path??'')||path.normalize(manifest.worktree.path)!==manifest.worktree.path)throw Error('INVALID_MANIFEST');
  for(const item of manifest.provenance)if(!item||!['ownership-ref','reflog','workspace-record','bundle'].includes(item.kind)||typeof item.ref!=='string'||!/^[0-9a-f]{64}$/.test(item.sha256??''))throw Error('INVALID_PROVENANCE');
  return manifest;
}
const equal=(a,b)=>canonical(a)===canonical(b);
/** Проверяет закреплённый DEV и все существующие головы; не меняет refs и не выполняет fetch. */
export async function verifyRetained(project,snapshot,disposition,{flowGit=createFlowGit()}={}){
  const sha=x=>typeof x==='string'&&/^[0-9a-f]{40}$/.test(x);
  if(disposition?.type!=='retained'||disposition.target!=='dev'||!sha(disposition.target_sha)||!sha(disposition.source_head))throw Error('RETAINED_EVIDENCE_INVALID');
  if(snapshot.worktree.pathExists&&snapshot.worktree.dirty!==false)throw Error('DIRTY_WORKTREE');
  const refs=[snapshot.branch.oid,snapshot.remote.oid,snapshot.worktree.head].filter(x=>x!==null);
  if(!refs.length||refs.some(x=>x!==disposition.source_head))throw Error('RETAINED_SOURCE_CHANGED');
  if(await flowGit.remote(project,'dev')!==disposition.target_sha)throw Error('RETAINED_TARGET_CHANGED');
  for(const head of new Set(refs))if(!await flowGit.ancestor(project,head,disposition.target_sha))throw Error('RETAINED_ANCESTRY_UNPROVEN');
  if(await flowGit.remote(project,'dev')!==disposition.target_sha)throw Error('RETAINED_TARGET_CHANGED');
  return {type:'retained',target:'dev',target_sha:disposition.target_sha,source_head:disposition.source_head,refs:{branch:snapshot.branch.oid,remote:snapshot.remote.oid,worktree:snapshot.worktree.head}};
}
/** Принимает orphan branch без подмены workspace identity; происхождение и архив обязательны. */
export async function importBranchCleanup(pool,projectId,manifest,{git,preflight=false,dryRun=false,allowedRepositories,verifyArchive=verifyCleanupArchive}={}){
 validateManifest(manifest,projectId);if(manifest.subject_type!=='branch')throw Error('INVALID_MANIFEST');if(preflight)dryRun=true;
 const db=await pool.connect();try{
  await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[projectId]);
  const project=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1 FOR SHARE',[projectId])).rows[0]?.config;
  if(!project||project.id!==projectId||project.common_dir!==manifest.common_dir||!Array.isArray(allowedRepositories)||!allowedRepositories.includes(project.repo_path))throw Error('PROJECT_MISMATCH');
  const guard=await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',['execution:branch:'+projectId+':'+manifest.branch.ref]);if(!guard.rows[0]?.acquired)throw Error('CLEANUP_BUSY');
  if((await db.query('SELECT id FROM codeworks.workspaces WHERE project_id=$1 AND branch=$2 FOR UPDATE',[projectId,manifest.branch.ref.slice('refs/heads/'.length)])).rowCount)throw Error('ACTIVE_OR_PENDING_WORK');
  const subject='branch:'+manifest.branch.ref,existing=(await db.query("SELECT * FROM codeworks.cleanup_obligations WHERE project_id=$1 AND subject_key=$2 AND (state<>'done' OR evidence->'manifest'->>'manifest_sha256'=$3) ORDER BY (state<>'done') DESC,created_at DESC LIMIT 1 FOR UPDATE",[projectId,subject,manifest.manifest_sha256])).rows[0];
  const prior=existing?.evidence?.manifest?.manifest_sha256;if(prior===manifest.manifest_sha256&&!preflight){await db.query(dryRun?'ROLLBACK':'COMMIT');return {id:existing.id,subject,state:existing.state,blocker:existing.blocker,duplicate:true,dry_run:dryRun};}if(prior)throw Error('CLEANUP_ALREADY_ADMITTED');
  const snapshot=await git.inspectBranchResources(project,{ref:manifest.branch.ref});
  for(const field of ['branch','remote','tracking','ownership','worktree','index'])if(!equal(snapshot[field],manifest[field]))throw Error('GIT_SNAPSHOT_CHANGED');
  let proven=false;for(const entry of manifest.provenance){if(entry.kind!=='reflog'||entry.ref!==snapshot.branch.ref||!snapshot.branch.oid)continue;const result=await command('git',['-C',project.repo_path,'reflog','show','--format=%H',entry.ref],{allowFailure:true});if(result.code===0&&result.stdout.split('\n').includes(snapshot.branch.oid)&&hash(result.stdout)===entry.sha256)proven=true;}if(!proven)throw Error('PROVENANCE_UNVERIFIED');
  const archive=manifest.disposition.archive;if(preflight&&archive)throw Error('INVALID_ARCHIVE_PREFLIGHT');if(!preflight&&!archive)throw Error('ARCHIVE_UNVERIFIED');
  let state='waiting_decision',blocker='DISPOSITION_PROOF_REQUIRED',authorized=false;if(archive){await verifyArchive(project,snapshot,archive,{manifest});state='pending';blocker=null;authorized=true;}
  const id=existing?.id??randomUUID(),evidence={...(existing?.evidence??{}),manifest,branch_subject:{ref:manifest.branch.ref},...(authorized?{archive,archive_authorized:true}:{})};let attached=false;
  if(existing){if(existing.step!=='inspect'||!['pending','waiting_decision'].includes(existing.state)||!existing.expected||Object.keys(existing.expected).length||(!preflight&&!authorized))throw Error('CLEANUP_ALREADY_ADMITTED');
   if(!dryRun){const updated=await db.query("UPDATE codeworks.cleanup_obligations SET evidence=$3::jsonb,expected=$4::jsonb,state='pending',blocker=NULL,next_attempt_at=NULL,epoch=epoch+1,updated_at=now() WHERE id=$1 AND epoch=$2 AND step='inspect' AND state IN ('pending','waiting_decision') AND expected='{}'::jsonb AND NOT (evidence ? 'manifest') RETURNING id",[id,existing.epoch,JSON.stringify(evidence),JSON.stringify(snapshot)]);if(!updated.rowCount)throw Error('CLEANUP_FENCE_LOST');}attached=true;
  }else if(!dryRun)await db.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,step,state,evidence,expected,blocker) VALUES($1,$2,NULL,$3,'cancelled','remote',$4,$5::jsonb,$6::jsonb,$7)",[id,projectId,subject,state,JSON.stringify(evidence),JSON.stringify(snapshot),blocker]);
  await db.query(dryRun?'ROLLBACK':'COMMIT');return {id,subject,state,blocker,duplicate:false,attached,dry_run:dryRun};
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}
/** Проверяет точную область и сохраняет durable intent в одной транзакции; dry-run не пишет. */
export async function importCleanup(pool,projectId,manifest,{git,codeIndex,dryRun=false,preflight=false,allowedRepositories,flowGit,verifyArchive=verifyCleanupArchive}={}){
  validateManifest(manifest,projectId);
  if(manifest.subject_type==='branch')return importBranchCleanup(pool,projectId,manifest,{git,preflight,dryRun,allowedRepositories,verifyArchive});
  if(preflight)dryRun=true;
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const row=(await db.query('SELECT config FROM codeworks.projects WHERE id=$1 FOR SHARE',[projectId])).rows[0];
    const project=row?.config;if(!project||project.id!==projectId||project.common_dir!==manifest.common_dir||!Array.isArray(allowedRepositories)||!allowedRepositories.includes(project.repo_path))throw Error('PROJECT_MISMATCH');
    const root=path.dirname(manifest.worktree.path);
    try{await assertCleanupRoot(project,root);}catch{throw Error('LEGACY_ROOT_FORBIDDEN');}
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['codeworks:cleanup-import:'+projectId+':'+manifest.branch.ref]);
    if(typeof manifest.workspace_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(manifest.workspace_id))throw Error('LEGACY_IDENTITY_UNVERIFIED');
    const guard=await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',['execution:workspace:'+manifest.workspace_id]);
    if(!guard.rows[0]?.acquired)throw Error('CLEANUP_BUSY');
    const matches=(await db.query('SELECT * FROM codeworks.workspaces WHERE project_id=$1 AND (id=$2 OR branch=$3 OR path=$4) FOR UPDATE',[projectId,manifest.workspace_id,manifest.branch.ref.slice(11),manifest.worktree.path])).rows;
    if(matches.length>1||matches.length===1&&(matches[0].id!==manifest.workspace_id||matches[0].branch!==manifest.branch.ref.slice(11)||matches[0].path!==manifest.worktree.path))throw Error('WORKSPACE_CONFLICT');
    let workspace=matches[0]??{id:manifest.workspace_id,project_id:projectId,branch:manifest.branch.ref.slice(11),path:manifest.worktree.path};
    if(workspace.id&&manifest.protected_task_ids.includes(workspace.id))throw Error('ACTIVE_OR_PENDING_WORK');
    if(workspace.id){
      await db.query('SELECT workflow_id FROM codeworks.workflow_registry WHERE workspace_id=$1 FOR UPDATE',[workspace.id]);
      const protectedRow=await db.query("SELECT 1 FROM codeworks.workflow_registry WHERE workspace_id=$1 AND lifecycle='active' UNION ALL SELECT 1 FROM codeworks.write_calls WHERE workspace_id=$1 AND state IN ('preparing','in_flight','uncertain') UNION ALL SELECT 1 FROM codeworks.operations WHERE workspace_id=$1 AND status IN ('pending','running','awaiting_ci','awaiting_deployment','awaiting_reconciliation') UNION ALL SELECT 1 FROM codeworks.release_queue q JOIN codeworks.operations o ON o.id=q.operation_id WHERE o.workspace_id=$1 AND q.state IN ('held','queued') LIMIT 1",[workspace.id]);
      if(protectedRow.rowCount)throw Error('ACTIVE_OR_PENDING_WORK');
    }
    const subject=matches[0]?'workspace:'+workspace.id:'legacy:'+manifest.manifest_sha256;
    const existing=(await db.query("SELECT * FROM codeworks.cleanup_obligations WHERE project_id=$1 AND subject_key=$2 AND (state<>'done' OR evidence->'manifest'->>'manifest_sha256'=$3) ORDER BY (state<>'done') DESC,created_at DESC LIMIT 1 FOR UPDATE",[projectId,subject,manifest.manifest_sha256])).rows[0];
    const previousDigest=existing?.evidence?.manifest?.manifest_sha256;
    if(previousDigest===manifest.manifest_sha256&&preflight)throw Error('CLEANUP_ALREADY_ADMITTED');
    if(previousDigest===manifest.manifest_sha256){await db.query(dryRun?'ROLLBACK':'COMMIT');return {id:existing.id,subject,state:existing.state,blocker:existing.blocker,duplicate:true,attached:false,dry_run:dryRun};}
    if(previousDigest)throw Error('CLEANUP_ALREADY_ADMITTED');
    if(!matches[0]){
      if(!manifest.ownership?.oid||!manifest.provenance.some(p=>p.kind==='ownership-ref'&&p.ref===manifest.ownership.ref))throw Error('LEGACY_IDENTITY_UNVERIFIED');
      const blob=await command('git',['-C',project.repo_path,'cat-file','blob',manifest.ownership.ref]);let marker;
      try{marker=JSON.parse(blob.stdout);}catch{throw Error('LEGACY_IDENTITY_UNVERIFIED');}
      const evidence=manifest.provenance.find(p=>p.kind==='ownership-ref'&&p.ref===manifest.ownership.ref);
      if(hash(blob.stdout)!==evidence.sha256||marker.workspace_id!==manifest.workspace_id||marker.workspace_id!==manifest.ownership.ref.slice('refs/codeworks/ownership/'.length)||marker.branch!==manifest.branch.ref.slice(11)||marker.path!==manifest.worktree.path||!/^[0-9a-f-]{36}$/i.test(marker.token??'')||!/^[0-9a-f]{40}$/.test(marker.base_sha??''))throw Error('LEGACY_IDENTITY_UNVERIFIED');
      workspace={id:marker.workspace_id,project_id:projectId,branch:marker.branch,path:marker.path,base_sha:marker.base_sha,kind:manifest.disposition.kind,ownership_token:marker.token};
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
      }else if(p.kind==='bundle'&&path.isAbsolute(p.ref)&&await realpath(p.ref)===p.ref&&snapshot.branch.oid){
        const bytes=await readFile(p.ref);const result=await command('git',['bundle','list-heads',p.ref],{allowFailure:true});
        if(hash(bytes)===p.sha256&&result.code===0&&result.stdout.split('\n').some(line=>line.split(/\s+/)[0]===snapshot.branch.oid))proven=true;
      }else if(p.kind==='reflog'&&p.ref===snapshot.branch.ref&&snapshot.branch.oid){
        const result=await command('git',['-C',project.repo_path,'reflog','show','--format=%H',p.ref],{allowFailure:true});
        if(result.code===0&&result.stdout.split('\n').includes(snapshot.branch.oid)&&hash(result.stdout)===p.sha256)proven=true;
      }
    }
    if(!proven)throw Error('PROVENANCE_UNVERIFIED');
    const disposition=manifest.disposition,head=snapshot.worktree.head??snapshot.branch.oid;
    if(preflight&&(disposition.type!=='archived'||disposition.archive))throw Error('INVALID_ARCHIVE_PREFLIGHT');
    let outcome='unused',state='waiting_decision',blocker='DISPOSITION_PROOF_REQUIRED',verified_disposition,archive_authorized=false;
    if(disposition.type==='archived'){
      if(!disposition.archive){if(!preflight)throw Error('ARCHIVE_UNVERIFIED');}
      else{await verifyArchive(project,snapshot,disposition.archive,{manifest});archive_authorized=true;outcome='cancelled';state='pending';blocker=null;}
    }else if(disposition.type==='retained'){
      verified_disposition=await verifyRetained(project,snapshot,disposition,{flowGit});outcome='released';state='pending';blocker=null;
    }else if(disposition.type==='unused'&&matches[0]&&/^[0-9a-f]{40}$/.test(workspace.base_sha)&&[head,snapshot.branch.oid,snapshot.remote.oid].every(v=>v===null||v===workspace.base_sha)&&(!snapshot.worktree.pathExists||snapshot.worktree.dirty===false)){
      outcome='unused';state='pending';blocker=null;
    }else if(disposition.type==='released'&&matches[0]&&typeof disposition.release_id==='string'){
      const release=(await db.query("SELECT * FROM codeworks.releases WHERE id=$1 AND workspace_id=$2 AND state='succeeded'",[disposition.release_id,workspace.id])).rows[0];
      const legs=workspace.kind==='hotfix'?[release?.details?.primary,release?.details?.backport]:[release?.details?.primary];
      let evidenceValid=!!release&&legs.every(l=>l?.merged&&l.deployment_evidence_id);
      if(evidenceValid)for(const leg of legs){const target=leg.target==='main'?'prod':'dev';const proof=await db.query('SELECT 1 FROM codeworks.deployment_evidence WHERE id=$1 AND project_id=$2 AND target=$3 AND commit_sha=$4',[leg.deployment_evidence_id,projectId,target,leg.merge_sha]);if(proof.rowCount!==1)evidenceValid=false;}
      if(evidenceValid&&[head,snapshot.branch.oid,snapshot.remote.oid].every(v=>v===null||v===release.requested_sha)){outcome='released';state='pending';blocker=null;}
    }
    const id=existing?.id??randomUUID();
    const evidence={...(existing?.evidence??{}),manifest,index_snapshot:index,...(verified_disposition?{verified_disposition}:{}),...(archive_authorized?{archive:disposition.archive,archive_authorized:true}:{}),...(!matches[0]?{workspace}:{})};
    let attached=false;
    if(existing&&!previousDigest){
      if(existing.step!=='inspect'||!['pending','waiting_decision'].includes(existing.state)||!existing.expected||Object.keys(existing.expected).length!==0||(!preflight&&state!=='pending'))throw Error('CLEANUP_ALREADY_ADMITTED');
      if(!dryRun){
        const updated=await db.query("UPDATE codeworks.cleanup_obligations SET evidence=$3::jsonb,expected=$4::jsonb,state='pending',blocker=NULL,next_attempt_at=NULL,epoch=epoch+1,updated_at=now() WHERE id=$1 AND epoch=$2 AND step='inspect' AND state IN ('pending','waiting_decision') AND expected='{}'::jsonb AND NOT (evidence ? 'manifest') RETURNING id",[id,existing.epoch,JSON.stringify(evidence),JSON.stringify(snapshot)]);
        if(!updated.rowCount)throw Error('CLEANUP_FENCE_LOST');
      }
      attached=true;
    }else if(!dryRun&&!existing)await db.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,step,state,evidence,expected,blocker) VALUES($1,$2,$3,$4,$5,'remote',$6,$7::jsonb,$8::jsonb,$9)",[id,projectId,matches[0]?.id??null,subject,outcome,state,JSON.stringify(evidence),JSON.stringify(snapshot),blocker]);
    await db.query(dryRun?'ROLLBACK':'COMMIT');return {id,subject,state:previousDigest?existing.state:state,blocker:previousDigest?existing.blocker:blocker,duplicate:!!previousDigest,attached,dry_run:dryRun};
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}
}
/** Разбирает только фиксированную операторскую команду и абсолютный путь манифеста. */
export function parseArgs(args){
  if(!['cleanup-import','cleanup-preflight'].includes(args[0]))throw Error('INVALID_ARGUMENT');
  const out={preflight:args[0]==='cleanup-preflight'};for(let i=1;i<args.length;i++){const name=args[i];if(name==='--dry-run'){if(out.dryRun||out.preflight)throw Error('INVALID_ARGUMENT');out.dryRun=true;continue;}if(!['--project','--manifest'].includes(name)||out[name]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('INVALID_ARGUMENT');out[name]=args[++i];}
  if(!out['--project']||!path.isAbsolute(out['--manifest']??''))throw Error('INVALID_ARGUMENT');return out;
}
/** Разбирает только owner-команды и не позволяет подменять политику UID. */
export function parseCompletionArgs(args){
 const method=args[0];if(!['write-completion-attest','write-completion-import'].includes(method))throw Error('INVALID_ARGUMENT');const out={method};
 for(let i=1;i<args.length;i++){const key=args[i];if(!['--call','--source','--receipt'].includes(key)||out[key]!==undefined||!args[i+1]||args[i+1].startsWith('--'))throw Error('INVALID_ARGUMENT');out[key]=args[++i];}
 if(!path.isAbsolute(out['--receipt']??'')||method==='write-completion-attest'&&(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(out['--call']??'')||!path.isAbsolute(out['--source']??''))||method==='write-completion-import'&&(out['--call']||out['--source']))throw Error('INVALID_ARGUMENT');return out;
}
/** Root проверяет известный журнал и создаёт отдельную неизменяемую receipt только один раз. */
export async function createCompletionReceipt(pool,args,{allowedRepositories}={}){
 if(process.geteuid?.()!==0)throw Error('OWNER_REQUIRED');
 const call=(await pool.query('SELECT * FROM codeworks.write_calls WHERE id=$1',[args['--call']])).rows[0];if(!call)throw Error('NATIVE_COMPLETION_UNVERIFIED');
 const project=(await pool.query('SELECT config FROM codeworks.projects WHERE id=$1',[call.project_id])).rows[0]?.config;
 const workspace=(await pool.query('SELECT * FROM codeworks.workspaces WHERE id=$1 AND project_id=$2',[call.workspace_id,call.project_id])).rows[0];
 if(!project||!workspace||!allowedRepositories?.includes(project.repo_path))throw Error('NATIVE_COMPLETION_UNVERIFIED');
 const proof=await attestNativeCompletion({sourcePath:args['--source'],call,project,workspace}),target=args['--receipt'];
 if(!path.isAbsolute(target)||path.normalize(target)!==target)throw Error('INVALID_ARGUMENT');await assertRootDirectory(path.dirname(target));
 const handle=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await handle.writeFile(JSON.stringify(proof)+'\n');await handle.sync();}finally{await handle.close();}
 return {write_call_id:call.id,created:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let pool;try{
    const raw=process.argv.slice(2),completion=raw[0]?.startsWith('write-completion-'),args=completion?parseCompletionArgs(raw):parseArgs(raw);
    const databaseURL=process.env.CODEWORKS_DATABASE_URL??JSON.parse(readFileSync(process.env.CODEWORKS_DATABASE_CONFIG_FILE,'utf8')).app_url;
    pool=new Pool({connectionString:databaseURL,max:3,connectionTimeoutMillis:3000,statement_timeout:10000});
    const allowedRepositories=JSON.parse(process.env.CODEWORKS_ALLOWED_REPOSITORIES??'[]');let result;
    if(completion){result=args.method==='write-completion-attest'?await createCompletionReceipt(pool,args,{allowedRepositories}):await importNativeCompletion(pool,args['--receipt'],{allowedRepositories});}
    else{const manifest=JSON.parse(await readFile(args['--manifest'],'utf8'));result=await importCleanup(pool,args['--project'],manifest,{git:{...createGit(),inspectBranchResources:createBranchCleanup().inspect},codeIndex:createCodeIndex(pool),dryRun:args.dryRun||args.preflight,preflight:args.preflight,allowedRepositories});}
    console.log(JSON.stringify(result));
  }catch(error){console.error('Owner operation failed: '+(/^[A-Z_]+$/.test(error.message)?error.message:'UNAVAILABLE'));process.exitCode=1;}finally{await pool?.end();}
}
