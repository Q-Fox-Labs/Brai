// ABOUTME: Запускает только изолированный тестовый Temporal worker для проверки SIGKILL и обновлений.
// ABOUTME: Принимает private fixture config и никогда не использует рабочую БД Codeworks.
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {NativeConnection,Worker} from '@temporalio/worker';
import {createActivities} from '../../src/temporal.mjs';
import {launchWorker} from '../../src/runtime.mjs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(new URL(config.databaseURL).pathname!=='/brai_codeworks_temporal_test'||!config.taskQueue.startsWith('codeworks-fixture-'))throw Error('FIXTURE_REQUIRED');
const pool=new Pool({connectionString:config.databaseURL,max:8});
const native=await NativeConnection.connect({address:config.address});
const activities=createActivities(pool,{...config,launchWorker:(dir,id,env)=>{
  if(config.failOperation===id)throw Error('EXPECTED_FIXTURE_TECHNICAL_FAILURE');
  if(config.crashOnce&&!existsSync(config.crashOnce)){
    writeFileSync(config.crashOnce,'interruption',{flag:'wx',mode:0o600});
    env={...env,CODEWORKS_TEST_MODE:'1',CODEWORKS_TEST_CRASH_AFTER:'after-branch'};
  }
  return launchWorker(dir,id,env);
}});
const worker=await Worker.create({connection:native,namespace:config.namespace,taskQueue:config.taskQueue,workflowBundle:{codePath:config.bundle??fileURLToPath(new URL('../../dist/workflows.js',import.meta.url))},activities,maxConcurrentActivityTaskExecutions:4,shutdownGraceTime:'1 second',shutdownForceTime:'5 seconds'});
process.on('SIGTERM',()=>worker.shutdown());process.on('SIGINT',()=>worker.shutdown());
try{await worker.run();}finally{await native.close();await pool.end();}
