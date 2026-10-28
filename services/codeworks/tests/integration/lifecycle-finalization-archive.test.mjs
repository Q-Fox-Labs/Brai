// ABOUTME: Проверяет историческую отмену с настоящим standalone Git bundle и изолированным Qdrant.
// ABOUTME: Активный root и неподтверждённый или повреждённый архив не разрешают удаление.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,chmod,access} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {setup,configured} from './fixture.mjs';
import {command} from '../../src/git.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
import {createCodeIndex} from '../../src/code-index.mjs';
import {runCleanupObligation} from '../../src/worker.mjs';

test('archived cancelled workspace requires authorization, intact bundle and inactive root',{timeout:120000},async t=>{
  assert.ok(configured&&process.env.CODEWORKS_INDEX_QDRANT,'explicit disposable PostgreSQL and Qdrant are required');
  const f=await setup();t.after(()=>f.close());const project=await f.project();
  const prepared=await f.prepare({project_id:project.id,workspace_key:'archived-cancel',request_key:'archived-cancel'});await f.worker(project,prepared.operation_id);
  const w=(await f.app.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0];
  await writeFile(w.path+'/hello.txt','unique archived result\n');await command('git',['-C',w.path,'add','hello.txt']);await command('git',['-C',w.path,'commit','-m','archived result']);
  const head=(await command('git',['-C',w.path,'rev-parse','HEAD'])).stdout,archiveRoot=project.workspace_root+'/archive';
  await mkdir(archiveRoot,{mode:0o700});const bundle=archiveRoot+'/result.bundle';
  await command('git',['-C',project.repo_path,'bundle','create',bundle,'refs/heads/'+w.branch]);await chmod(bundle,0o600);
  const digest=createHash('sha256').update(await readFile(bundle)).digest('hex');
  const archive={path:bundle,sha256:digest,heads:[{ref:'refs/heads/'+w.branch,oid:head}]};
  project.cleanup_archive_roots=[archiveRoot];project.cleanup_archive_uid=process.getuid();
  await f.owner.query('UPDATE codeworks.projects SET config=$2 WHERE id=$1',[project.id,project]);
  const settings=project.workspace_root+'/index-runtime.json',configFile=project.workspace_root+'/index-config.json';
  await writeFile(settings,JSON.stringify({env:{QDRANT_MODE:'external',QDRANT_URL:process.env.CODEWORKS_INDEX_QDRANT,SOCRATICODE_AUTO_RESUME:'off',SOCRATICODE_WATCHER:'manual'}}));
  await writeFile(configFile,JSON.stringify({engine:'/opt/socraticode/node_modules/socraticode/dist/index.js',socraticodeConfig:settings,sources:{}}));
  const codeIndex=createCodeIndex(f.app,{configFile}),adapters=createActivityGit();
  const expected=await adapters.git.inspectResources(project,w),index=await codeIndex.inspect(project,w);
  const manifest={manifestVersion:1,reviewed:true,project_id:project.id,common_dir:project.common_dir,workspace_id:w.id,branch:expected.branch,remote:expected.remote,tracking:expected.tracking,ownership:expected.ownership,worktree:expected.worktree,provenance:[{kind:'fixture'}],manifest_sha256:'a'.repeat(64),index:{identity:index.identity,ownerRecordHash:index.owner.recordHash,collections:index.resources.collections,metadataPoints:index.resources.metadataPoints},disposition:{type:'archived',archive}};
  const owner='fixture/'+randomUUID(),id=randomUUID(),evidence={manifest,archive,archive_authorized:false};
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner) VALUES($1,$2,$3,'temporal')",[owner,project.id,w.id]);
  await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,owner_workflow_id,epoch,evidence,expected) VALUES($1,$2,$3,$4,'cancelled',$5,1,$6,$7)",[id,project.id,w.id,'workspace:'+w.id,owner,evidence,expected]);
  const run=()=>runCleanupObligation(f.app,id,owner,{...adapters,codeIndex,allowedRepositories:[project.repo_path]});
  let result=await run();assert.equal(result.blocker,'LIVE_TASK_PROTECTED');await access(w.path);
  await f.owner.query("UPDATE codeworks.workflow_registry SET state='draining',lifecycle='closing' WHERE workflow_id=$1",[owner]);
  await f.owner.query("UPDATE codeworks.cleanup_obligations SET state='pending' WHERE id=$1",[id]);
  result=await run();assert.equal(result.blocker,'ARCHIVE_UNVERIFIED');await access(w.path);
  evidence.archive_authorized=true;
  await f.owner.query("UPDATE codeworks.cleanup_obligations SET state='pending',evidence=$2 WHERE id=$1",[id,evidence]);
  const original=await readFile(bundle);await writeFile(bundle,'corrupt');
  result=await run();assert.equal(result.blocker,'ARCHIVE_UNVERIFIED');await access(w.path);
  await writeFile(bundle,original);await chmod(bundle,0o600);
  await f.owner.query("UPDATE codeworks.cleanup_obligations SET state='pending' WHERE id=$1",[id]);
  for(let i=0;i<8;i++){result=await run();assert.notEqual(result?.state,'waiting_decision',JSON.stringify(result));if(result?.state==='done')break;}
  assert.equal(result.state,'done');await assert.rejects(access(w.path));
  assert.equal(createHash('sha256').update(await readFile(bundle)).digest('hex'),digest);
  assert.ok((await f.app.query('SELECT removed_at FROM codeworks.workspaces WHERE id=$1',[w.id])).rows[0].removed_at);
  const zero=await codeIndex.inspect(project,w,{manifest,checkpointState:result.evidence.index_checkpoint});
  assert.equal(zero.complete,true);assert.equal(zero.owner.present,false);assert.deepEqual(zero.resources,{collections:[],metadataPoints:[]});
});
