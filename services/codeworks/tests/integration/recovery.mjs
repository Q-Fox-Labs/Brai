// ABOUTME: Готовит и принимает настоящий pg_dump/pg_restore Codeworks в отдельную test DB.
// ABOUTME: SQL backup/restore выполняет оператор; этот fixture проверяет данные и продолжение Git.
import {readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {setup,readConfig} from './fixture.mjs';
import {createFlowGit} from '../../src/git-flow.mjs';
import {createCIEvidence} from '../../src/ci-evidence.mjs';
import {migrate} from '../../src/migrate.mjs';
import {createStore} from '../../src/storage.mjs';
import {createHandlers} from '../../src/domain.mjs';
import {createGit} from '../../src/git.mjs';
import {launchWorker} from '../../src/runtime.mjs';
const temporaryRoot=fileURLToPath(new URL('../../../../tmp/',import.meta.url));
const stateFile=process.env.CODEWORKS_TEST_RECOVERY_FILE??path.join(temporaryRoot,'codeworks-db-recovery.json');
if(!process.env.CODEWORKS_TEST_CONFIG_FILE)throw new Error('CODEWORKS_TEST_CONFIG_FILE_REQUIRED');
if(process.argv[2]==='prepare') {
  const f=await setup({git:createGit({flowGit:createFlowGit({localRemote:true})})});
  try {
    const project=await f.project({github:{repository:'fixture/repository',required_checks:[{name:'Codeworks components',app_id:42}],ci:{check_name:'Codeworks components',app_id:42,workflow_sha256:'c'.repeat(64),recipe_sha256:'a'.repeat(64)}}});
    const ciProject=project;
    const ciProof={published:{digest:'sha256:'+'b'.repeat(64)},composition:{runId:'123',attempt:'1',components:[]}};
    await createCIEvidence(f.app).save(ciProject,ciProof);
    const request=key=>({project_id:project.id,request_key:key,workspace_key:key,kind:'feature'});
    const ready=await f.prepare(request('ready'),'codex');await f.worker(project,ready.operation_id);
    const status=await f.h.call('status',{project_id:project.id,workspace_id:ready.workspace_id},'codex');
    const release=await f.h.call('release',{project_id:project.id,workspace_id:ready.workspace_id,request_key:'release',commit_sha:status.git.head},'codex');
    const archived=await f.prepare(request('archived'),'codex');
    await f.owner.query('UPDATE codeworks.operations SET archived=true WHERE id=$1',[archived.operation_id]);
    const pending=await f.prepare(request('pending'),'codex');
    assert.equal((await f.worker(project,pending.operation_id,'after-branch')).signal,'SIGKILL');
    await mkdir(temporaryRoot,{recursive:true});
    await writeFile(stateFile,JSON.stringify({project,ciProject,ciProof,ready,release,pending,archived,base_sha:status.git.head})+'\n',{mode:0o600});
    console.log('Recovery fixture prepared: ready workspace, queued release and interrupted Git intent; run operator backup/restore next.');
  }finally{await Promise.all([f.owner.end(),f.app.end()]);}
} else if(process.argv[2]==='verify') {
  const config=await readConfig();
  const state=JSON.parse(await readFile(stateFile,'utf8'));
  const {project,ready,release,pending,archived}=state;
  const root=path.dirname(project.repo_path);
  if(!root.startsWith(temporaryRoot+'codeworks-test-')||path.dirname(project.workspace_root)!==root)throw new Error('DISPOSABLE_GIT_ROOT_REQUIRED');
  for(const key of ['restore_owner_url','restore_app_url'])if(new URL(config[key]).pathname!=='/brai_codeworks_restore_test')throw new Error('RESTORE_TEST_ONLY');
  const owner=new Pool({connectionString:config.restore_owner_url}),app=new Pool({connectionString:config.restore_app_url}),source=new Pool({connectionString:config.owner_url});
  const h=createHandlers(createStore(app),createGit(),{allowedRepositories:[project.repo_path]});
  try {
    await migrate(owner,config.app_role);
    await migrate(owner,config.app_role);
    assert.deepEqual(await createCIEvidence(app).read(state.ciProject,'123','1'),state.ciProof);
    await createCIEvidence(app).save(state.ciProject,state.ciProof);
    await assert.rejects(app.query("UPDATE codeworks.verified_ci SET proof='{}'::jsonb"),{code:'42501'});
    const op=async id=>(await h.call('status',{project_id:project.id,operation_id:id},'codex')).operation;
    assert.equal((await op(ready.operation_id)).status,'succeeded');
    assert.equal((await op(release.operation_id)).status,'pending');
    assert.equal((await op(release.operation_id)).archived,false);
    assert.equal((await op(archived.operation_id)).archived,true);
    assert.equal((await createStore(app).pending(100)).some(row=>row.id===archived.operation_id),false);
    assert.equal((await op(pending.operation_id)).status,'running');
    const restoredStatus=await h.call('status',{project_id:project.id,workspace_id:ready.workspace_id},'codex');
    assert.equal(restoredStatus.git.head,state.base_sha);
    assert.equal('writer' in restoredStatus.workspace,false);assert.equal('legacy_writer' in restoredStatus.workspace,false);
    assert.equal('attachments' in restoredStatus,false);
    const child=launchWorker(project.common_dir,pending.operation_id,{...process.env,CODEWORKS_DATABASE_URL:config.restore_app_url,CODEWORKS_ALLOWED_REPOSITORIES:JSON.stringify([project.repo_path])});
    child.stderr.on('data',()=>{});
    assert.equal(await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}),0);
    assert.equal((await op(pending.operation_id)).status,'succeeded');
    assert.equal((await source.query('SELECT status FROM codeworks.operations WHERE id=$1',[pending.operation_id])).rows[0].status,'running');
    assert.equal((await h.call('status',{project_id:project.id,workspace_id:pending.workspace_id},'codex')).git.head,state.base_sha);
    console.log('Restored DB accepted: durable CI proof replay/append-only, repeat migration, archived history, ready Git, queued release and interrupted intent recovered; source DB unchanged.');
    await source.query('TRUNCATE codeworks.requests,codeworks.legacy_attachments,codeworks.releases,codeworks.operations,codeworks.workspaces,codeworks.projects CASCADE');
    await owner.query('DROP SCHEMA codeworks CASCADE; DROP TABLE public.codeworks_migrations');
    await rm(root,{recursive:true,force:true});await rm(stateFile);
  }finally{await Promise.all([owner.end(),app.end(),source.end()]);}
} else throw new Error('Expected prepare or verify');
