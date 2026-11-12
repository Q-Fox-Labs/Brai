// ABOUTME: Запускает installed immutable worker в собственной bootstrap test queue.
// ABOUTME: Использует SDK и код только указанной старой поставки; runtime установки не включает.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const input=process.argv[2],config=JSON.parse(readFileSync(input,'utf8')),artifact=realpathSync(config.artifact);
if(!/^\/opt\/brai-components\/codeworks\/[a-f0-9]{64}$/.test(artifact)||new URL(config.databaseURL).pathname!=='/brai_codeworks_temporal_test'||!config.taskQueue.startsWith('codeworks-fixture-bootstrap-'))throw Error('BOOTSTRAP_FIXTURE_REQUIRED');
const require=createRequire(artifact+'/package.json');
const {NativeConnection,Worker}=await import(pathToFileURL(require.resolve('@temporalio/worker')));
const {Pool}=require('pg');
const {createActivities}=await import(pathToFileURL(artifact+'/services/codeworks/src/temporal.mjs'));
const {runOperation}=await import(pathToFileURL(artifact+'/services/codeworks/src/worker.mjs'));
const {createActivityGit}=await import(pathToFileURL(artifact+'/services/codeworks/src/git-steps.mjs'));
const {createFlowGit}=await import(pathToFileURL(artifact+'/services/codeworks/src/git-flow.mjs'));
const pool=new Pool({connectionString:config.databaseURL,max:4});
const native=await NativeConnection.connect({address:config.address});
const adapters=createActivityGit({flowGit:createFlowGit({localRemote:true,requireLock:()=>{}})});
adapters.github={checks:async(_,sha)=>[{name:'checks',app_id:42,sha,status:'completed',conclusion:'success'}]};
adapters.git.synchronizeCheckout=async(project,workspace,sha)=>{
  const current=await adapters.git.inspect(project,workspace);
  if(current.dirty||current.head!==sha)throw Error('BOOTSTRAP_CHECKOUT_CHANGED');
  return {state:'ready',commit_sha:sha,lock_sha256:'a'.repeat(64),dependency_graph_sha256:'b'.repeat(64)};
};
const calls=[];
const activities=createActivities(pool,{allowedRepositories:config.allowedRepositories,adapters,execute:async(...args)=>{
  const op=(await pool.query('SELECT id,kind FROM codeworks.operations WHERE id=$1',[args[1]])).rows[0];
  calls.push(op);writeFileSync(config.callsFile,JSON.stringify(calls),{mode:0o600});
  if(op?.kind==='repair')throw Error('REPAIR_REACHED_OLD_WORKER');
  return runOperation(...args);
}});
const loadCommands=activities.loadCommands;activities.loadCommands=async(...args)=>{const result=await loadCommands(...args);writeFileSync(config.observedFile,JSON.stringify(result.checkpoint??{}),{mode:0o600});return result;};
const worker=await Worker.create({connection:native,namespace:config.namespace,taskQueue:config.taskQueue,workflowBundle:{codePath:artifact+'/services/codeworks/dist/workflows.js'},activities,maxConcurrentActivityTaskExecutions:2,shutdownGraceTime:'1 second',shutdownForceTime:'5 seconds'});
process.on('SIGTERM',()=>worker.shutdown());
try{const running=worker.run();writeFileSync(config.readyFile,artifact,{mode:0o600});await running;}finally{await native.close();await pool.end();}
