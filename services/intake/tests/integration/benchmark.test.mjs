// ABOUTME: Сравнивает одинаковый SQL sink через JetStream и Temporal на настоящем стенде.
// ABOUTME: Измеряет контрольную нагрузку, не обещая производительность полного Telegram-сценария.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {connect,AckPolicy} from 'nats';
import {Client,Connection} from '@temporalio/client';
import {Worker,NativeConnection,Runtime,DefaultLogger} from '@temporalio/worker';
import {integrationConfig} from './fixtures.mjs';
const cfg=integrationConfig();
test('same durable SQL sink benchmark through JetStream and Temporal',{skip:!cfg,timeout:120000},async()=>{
 Runtime.install({logger:new DefaultLogger('WARN')});
 const nc=await connect({servers:cfg.natsUrl,user:'fixture',pass:'intake-test'}),pool=new Pool({connectionString:cfg.ownerUrl});
 const conn=await Connection.connect({address:cfg.temporalAddress}),native=await NativeConnection.connect({address:cfg.temporalAddress});
 try{await conn.workflowService.registerNamespace({namespace:'intake_test',workflowExecutionRetentionPeriod:{seconds:86400}});}catch(e){if(e.code!==6)throw e;}
 const client=new Client({connection:conn,namespace:'intake_test'}),token=randomUUID().replaceAll('-',''),stream='INTAKE_BENCH_'+token,subject='brai.intake.fixture.bench.'+token,queue='intake-benchmark-'+token;
 const m=await nc.jetstreamManager(),ids=[],workflows=[];let worker,running;
 try{
  await pool.query('CREATE SCHEMA IF NOT EXISTS intake_fixture');
  await pool.query('CREATE TABLE IF NOT EXISTS intake_fixture.benchmark_effects(id text PRIMARY KEY)');
  const writeSink=async id=>{await pool.query('INSERT INTO intake_fixture.benchmark_effects(id) VALUES($1) ON CONFLICT DO NOTHING',[id]);};
  await m.streams.add({name:stream,subjects:[subject],storage:'file',retention:'workqueue',discard:'new',max_bytes:1048576,max_age:0});
  await m.consumers.add(stream,{durable_name:'benchmark',ack_policy:AckPolicy.Explicit,filter_subject:subject,max_deliver:-1});
  const c=await nc.jetstream().consumers.get(stream,'benchmark');
  const rssBeforeWorker=process.memoryUsage().rss;
  worker=await Worker.create({connection:native,namespace:'intake_test',taskQueue:queue,workflowsPath:fileURLToPath(new URL('./benchmark.workflow.mjs',import.meta.url)),activities:{writeSink},maxConcurrentActivityTaskExecutions:4,maxConcurrentWorkflowTaskExecutions:8,maxCachedWorkflows:32,shutdownGraceTime:'1 second'});
  running=worker.run();const rssReady=process.memoryUsage().rss;
  const direct=async()=>{const id=randomUUID();ids.push(id);const start=performance.now();await nc.jetstream().publish(subject,Buffer.from(id));const msg=await c.next({expires:5000});assert.ok(msg);assert.equal(new TextDecoder().decode(msg.data),id);await writeSink(id);msg.ack();return performance.now()-start;};
  const temporal=async()=>{const id=randomUUID(),workflowId='intake-benchmark/'+id;ids.push(id);workflows.push(workflowId);const start=performance.now();await client.workflow.execute('intakeBenchmark',{workflowId,taskQueue:queue,args:[id]});return performance.now()-start;};
  await direct();await temporal();
  const count=20,jetstream=[],workflow=[];
  for(let i=0;i<count;i++)jetstream.push(await direct());
  for(let i=0;i<count;i++)workflow.push(await temporal());
  const summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,p50Ms:sorted[Math.ceil(values.length*.5)-1],p95Ms:sorted[Math.ceil(values.length*.95)-1],sequentialPerSecond:1000*values.length/values.reduce((a,b)=>a+b,0)};};
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM intake_fixture.benchmark_effects WHERE id=ANY($1::text[])',[ids])).rows[0].n),ids.length);
  const report={measuredAt:new Date().toISOString(),operation:'same PostgreSQL INSERT with durable commit; one warmup excluded',jetstream:summary(jetstream),temporal:summary(workflow),rssBytes:{beforeWorker:rssBeforeWorker,readyWorker:rssReady,afterRuns:process.memoryUsage().rss},limits:{activities:4,workflowTasks:8,cache:32},note:'RSS belongs to the combined test client/worker process; excludes server PostgreSQL/NATS/Temporal and is not RAM per workflow'};
  await writeFile(new URL('../../../../tmp/intake-benchmark.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log('INTAKE_BENCHMARK '+JSON.stringify(report));
 }finally{
  for(const id of workflows){try{const h=client.workflow.getHandle(id);if((await h.describe()).status.name==='RUNNING')await h.terminate('own benchmark cleanup');}catch{}}
  if(worker){worker.shutdown();await running.catch(()=>{});}
  await m.streams.delete(stream).catch(()=>{});await nc.close();await native.close();await conn.close();await pool.end();
 }
});
