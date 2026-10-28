// ABOUTME: Проверяет очистку unused, released и transferred через настоящий Git, PostgreSQL и Qdrant.
// ABOUTME: Доказательства выпуска и переноса принадлежат только созданным тестовым репозиториям.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setup,configured} from './fixture.mjs';
import {command} from '../../src/git.mjs';
import {createActivityGit} from '../../src/git-steps.mjs';
import {createCodeIndex} from '../../src/code-index.mjs';
import {runCleanupObligation} from '../../src/worker.mjs';

for(const outcome of ['unused','released','transferred'])test(outcome+' disposition removes only proven disposable resources',{timeout:120000},async t=>{
  assert.ok(configured&&process.env.CODEWORKS_INDEX_QDRANT,'explicit disposable PostgreSQL and Qdrant are required');
  const f=await setup();t.after(()=>f.close());const project=await f.project();
  const prepared=await f.prepare({project_id:project.id,workspace_key:'disposition-'+outcome,request_key:'disposition-'+outcome});
  await f.worker(project,prepared.operation_id);
  const workspace=(await f.owner.query('SELECT * FROM codeworks.workspaces WHERE id=$1',[prepared.workspace_id])).rows[0];
  const workflow='fixture/'+randomUUID(),id=randomUUID();
  await f.owner.query("INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,owner,state,lifecycle,outcome) VALUES($1,$2,$3,'temporal','draining','closing',$4)",[workflow,project.id,workspace.id,outcome]);
  let evidence={};
  if(outcome!=='unused'){
    await writeFile(workspace.path+'/hello.txt','retained fixture change\n');
    await command('git',['-C',workspace.path,'add','hello.txt']);await command('git',['-C',workspace.path,'commit','-m','retain change']);
    const head=(await command('git',['-C',workspace.path,'rev-parse','HEAD'])).stdout;
    await command('git',['-C',project.repo_path,'merge','--ff-only',workspace.branch]);
    if(outcome==='transferred'){
      const blob=(await command('git',['-C',workspace.path,'rev-parse','HEAD:hello.txt'])).stdout;
      evidence={transfer:{destination:{repo_path:project.repo_path,commit_sha:head},source_head:head,source_base:workspace.base_sha,files:[{status:'M',source_path:'hello.txt',destination_path:'hello.txt',source_blob:blob,destination_blob:blob}]}};
    }else{
      const operation=randomUUID(),release=randomUUID(),proof=randomUUID();
      await f.owner.query("INSERT INTO codeworks.operations(id,project_id,workspace_id,executor_id,kind,status,step,request) VALUES($1,$2,$3,'codex','release','succeeded','done','{}')",[operation,project.id,workspace.id]);
      await f.owner.query("INSERT INTO codeworks.deployment_evidence(id,project_id,target,commit_sha,evidence_url) VALUES($1,$2,'dev',$3,$4)",[proof,project.id,head,'https://fixture.invalid/'+proof]);
      await f.owner.query("INSERT INTO codeworks.releases(id,workspace_id,operation_id,target,requested_sha,state,details) VALUES($1,$2,$3,'dev',$4,'succeeded',$5)",[release,workspace.id,operation,head,{primary:{merged:true,merge_sha:head,target:'dev',deployment_evidence_id:proof}}]);
    }
  }
  await f.owner.query("INSERT INTO codeworks.cleanup_obligations(id,project_id,workspace_id,subject_key,outcome,owner_workflow_id,epoch,evidence) VALUES($1,$2,$3,$4,$5,$6,1,$7)",[id,project.id,workspace.id,'workspace:'+workspace.id,outcome,workflow,evidence]);
  const settings=project.workspace_root+'/index-runtime.json',configFile=project.workspace_root+'/index-config.json';
  await writeFile(settings,JSON.stringify({env:{QDRANT_MODE:'external',QDRANT_URL:process.env.CODEWORKS_INDEX_QDRANT,SOCRATICODE_AUTO_RESUME:'off',SOCRATICODE_WATCHER:'manual'}}));
  await writeFile(configFile,JSON.stringify({engine:'/opt/socraticode/node_modules/socraticode/dist/index.js',socraticodeConfig:settings,sources:{}}));
  const codeIndex=createCodeIndex(f.app,{configFile}),adapters=createActivityGit();
  for(let i=0;i<8;i++){
    const result=await runCleanupObligation(f.app,id,workflow,{...adapters,codeIndex,allowedRepositories:[project.repo_path]});
    assert.notEqual(result?.state,'waiting_decision',JSON.stringify(result));
    if(result?.state==='done')break;
  }
  assert.equal((await f.app.query('SELECT state FROM codeworks.cleanup_obligations WHERE id=$1',[id])).rows[0].state,'done');
  assert.ok((await f.app.query('SELECT removed_at FROM codeworks.workspaces WHERE id=$1',[workspace.id])).rows[0].removed_at);
  await assert.rejects(access(workspace.path));
  assert.notEqual((await command('git',['-C',project.repo_path,'show-ref','--verify','refs/heads/'+workspace.branch],{allowFailure:true})).code,0);
  if(outcome!=='unused')assert.equal((await command('git',['-C',project.repo_path,'show','dev:hello.txt'])).stdout,'retained fixture change');
});
