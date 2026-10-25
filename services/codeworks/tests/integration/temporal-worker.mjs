// ABOUTME: Запускает только изолированный тестовый Temporal worker для проверки SIGKILL и обновлений.
// ABOUTME: Принимает private fixture config и никогда не использует рабочую БД Codeworks.
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {NativeConnection,Worker} from '@temporalio/worker';
import {createActivities} from '../../src/temporal.mjs';
import {createFlowGit} from '../../src/git-flow.mjs';
import {executionContext} from '../../src/execution-context.mjs';
import {runOperation} from '../../src/worker.mjs';
import {createActivityGit,localGitStep} from '../../src/git-steps.mjs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(new URL(config.databaseURL).pathname!=='/brai_codeworks_temporal_test'||!config.taskQueue.startsWith('codeworks-fixture-'))throw Error('FIXTURE_REQUIRED');
const pool=new Pool({connectionString:config.databaseURL,max:8});
const native=await NativeConnection.connect({address:config.address});
let github;
if(config.githubURL){
  const url=new URL(config.githubURL);
  if(url.hostname!=='127.0.0.1')throw Error('LOCAL_GITHUB_FIXTURE_REQUIRED');
  const call=async(method,data)=>{const response=await fetch(url.href+method,{method:'POST',body:JSON.stringify(data),signal:executionContext()?.signal});return response.json();};
  github={find:(p,leg)=>call('find',leg),create:(p,leg,body)=>call('create',{...leg,body})};
}
const activities=createActivities(pool,{...config,
  execute:async(...args)=>{if(config.failOperation===args[1])throw Error('EXPECTED_FIXTURE_TECHNICAL_FAILURE');return runOperation(...args);},
  adapters:{github,...createActivityGit({...(github?{flowGit:createFlowGit({localRemote:true,requireLock:()=>{}})}:{}),step:async(method,p,w,args=[])=>{
    let env={};
    if(method==='branch'&&config.crashOnce&&!existsSync(config.crashOnce)){
      writeFileSync(config.crashOnce,'interruption',{flag:'wx',mode:0o600});
      env={CODEWORKS_TEST_MODE:'1',CODEWORKS_TEST_CRASH_AFTER:'after-branch'};
    }
    return localGitStep(method,p,w,args,{env});
  }})},
});
const worker=await Worker.create({connection:native,namespace:config.namespace,taskQueue:config.taskQueue,workflowBundle:{codePath:config.bundle??fileURLToPath(new URL('../../dist/workflows.js',import.meta.url))},activities,maxConcurrentActivityTaskExecutions:4,shutdownGraceTime:'1 second',shutdownForceTime:'5 seconds'});
process.on('SIGTERM',()=>worker.shutdown());process.on('SIGINT',()=>worker.shutdown());
try{await worker.run();}finally{await native.close();await pool.end();}
