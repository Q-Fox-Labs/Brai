// ABOUTME: Запускает disposable Temporal worker и прерывает его после первой реальной очистки индекса.
// ABOUTME: Маркер и process SIGKILL позволяют проверить восстановление после потерянного ответа.
import {readFile,writeFile,access} from 'node:fs/promises';
import {Pool} from 'pg';
import {NativeConnection,Worker} from '@temporalio/worker';
import {createActivities} from '../../src/temporal.mjs';
import {createCodeIndex} from '../../src/code-index.mjs';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
if(new URL(config.databaseURL).pathname!=='/brai_codeworks_temporal_test'||!config.taskQueue.startsWith('codeworks-finalization-'))throw Error('FIXTURE_REQUIRED');
const pool=new Pool({connectionString:config.databaseURL,max:8});
const native=await NativeConnection.connect({address:config.address});
const index=createCodeIndex(pool,{configFile:config.indexConfig});
const faultIndex={...index,remove:async(...args)=>{
  await index.remove(...args);
  try{await access(config.crashMarker);}catch{await writeFile(config.crashMarker,'SIGKILL',{flag:'wx'});process.kill(process.pid,'SIGKILL');}
}};
const worker=await Worker.create({connection:native,namespace:config.namespace,taskQueue:config.taskQueue,workflowBundle:{codePath:config.bundle},activities:createActivities(pool,{allowedRepositories:config.allowedRepositories,codeIndex:faultIndex}),maxConcurrentActivityTaskExecutions:4,shutdownGraceTime:'1 second'});
process.on('SIGTERM',()=>worker.shutdown());
try{await worker.run();}finally{await native.close();await pool.end();}
