#!/usr/bin/env node
// ABOUTME: Связывает настоящий тестовый native Pre/Post с отдельной disposable PostgreSQL.
// ABOUTME: Не использует рабочий сервер и не печатает входы или учётные данные.
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {runHook,readHookJSON} from '../../src/hook.mjs';
import {createHandlers} from '../../src/domain.mjs';
import {createStore} from '../../src/storage.mjs';
import {createGit} from '../../src/git.mjs';
import {launchWorker} from '../../src/runtime.mjs';

const cfg=JSON.parse(await readFile(process.env.CODEWORKS_TEST_CONFIG_FILE,'utf8'));
const fixture=JSON.parse(await readFile(process.env.CODEWORKS_NATIVE_FIXTURE_CONFIG,'utf8'));
const testRoot=await realpath(fileURLToPath(new URL('../../../../tmp/',import.meta.url)));
const repo=await realpath(fixture.project.repo_path),areas=await realpath(fixture.project.workspace_root);
if(cfg.fixture!=='temporal'||new URL(cfg.app_url).pathname!=='/brai_codeworks_temporal_test'||!repo.startsWith(testRoot+path.sep)||!areas.startsWith(testRoot+path.sep)||!fixture.project.id.startsWith('test_'))throw Error('DISPOSABLE_FIXTURE_REQUIRED');
const pool=new Pool({connectionString:cfg.app_url,max:3});
try{
 const event=await readHookJSON(process.stdin),handlers=createHandlers(createStore(pool),createGit(),{allowedRepositories:[repo]});
 const connect=async()=>({call:async(method,args)=>{
  const result=await handlers.call(method,args,'codex');
  if(method==='write.begin'&&result.operation_id){
   const worker=launchWorker(fixture.project.common_dir,result.operation_id,{...process.env,CODEWORKS_DATABASE_URL:cfg.app_url,CODEWORKS_ALLOWED_REPOSITORIES:JSON.stringify([repo]),CODEWORKS_TEST_MODE:'1'});
   const exit=await new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('close',(code,signal)=>resolve({code,signal}));});
   if(exit.code!==0||exit.signal)throw Error('FIXTURE_WORKER_FAILED');
  }
  return result;
 },close:async()=>{}});
 const output=await runHook(event,{config:{projects:[fixture.project],completion_spool:fixture.spool},env:{CODEWORKS_EXECUTOR_ID:'codex',CODEWORKS_WORKSPACE_KEY:'native-bridge'},connect,polls:3});
 process.stdout.write(JSON.stringify(output)+'\n');
}finally{await pool.end();}
