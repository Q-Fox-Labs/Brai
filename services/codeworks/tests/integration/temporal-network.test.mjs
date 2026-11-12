// ABOUTME: Запускает адресный native Temporal network scenario после одного disposable setup.
// ABOUTME: Не запускает остальные A/B или backup cases и закрывает только свой worker и roots.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {Connection,Client} from '@temporalio/client';
import {setup,configured} from './fixture.mjs';
import {temporalNetworkScenario} from './temporal-network-scenario.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('isolated slow GitHub, duplicate Activity and lost PG session remain independent',{skip:!configured||process.env.CODEWORKS_TEMPORAL_TEST!=='1',timeout:300000},async t=>{
  const f=await setup();let child,connection,client;const workflowIds=new Set();
  const tmp=fileURLToPath(new URL('../../../../tmp/',import.meta.url));await mkdir(tmp,{recursive:true});
  const root=await mkdtemp(tmp+'temporal-network-'),configFile=root+'/private.json';
  const config={databaseURL:f.config.app_url,allowedRepositories:[],address:process.env.CODEWORKS_TEMPORAL_ADDRESS??'127.0.0.1:7233',namespace:process.env.CODEWORKS_TEMPORAL_NAMESPACE??'brai',taskQueue:'codeworks-fixture-network-'+randomUUID(),bundle:fileURLToPath(new URL('../../dist/workflows.js',import.meta.url))};
  await writeFile(configFile,JSON.stringify(config),{mode:0o600});
  const stop=async(signal='SIGTERM')=>{if(!child)return;const current=child;child=null;if(current.exitCode!==null||current.signalCode!==null)return;const done=new Promise(resolve=>current.once('close',resolve));current.kill(signal);await done;};
  const start=async()=>{child=spawn(process.execPath,[fileURLToPath(new URL('./temporal-worker.mjs',import.meta.url)),configFile],{stdio:['ignore','ignore','pipe']});child.stderr.on('data',()=>{});child.once('error',()=>{});};
  t.after(async()=>{await stop();if(client)for(const id of workflowIds)await client.workflow.getHandle(id).terminate('isolated network fixture complete').catch(()=>{});await connection?.close();await f.close();});
  connection=await Connection.connect({address:config.address,connectTimeout:'5 seconds'});client=new Client({connection,namespace:config.namespace});
  const until=async(work,timeout=60000)=>{const deadline=Date.now()+timeout;for(;;){t.signal.throwIfAborted();if(await work())return;assert.ok(Date.now()<deadline,'network fixture condition timeout');await pause(100);}};
  await temporalNetworkScenario({f,config,configFile,start,stop,client,workflowIds,until});
});
