// ABOUTME: Проверяет prepared recipes через настоящий Temporal, runner, PostgreSQL и приватный Codex.
// ABOUTME: Scope синтетический; внешний runner, его сервис и DATA остаются у операторского владельца.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {connect,StringCodec} from 'nats';
import {Connection,Client} from '@temporalio/client';
import {NativeConnection,Worker} from '@temporalio/worker';
import {readPrivate} from '../../dist/config.js';
import {activeIdentity} from '../../dist/identity.js';
import {migrate} from '../../dist/migrate.js';
import {createStore} from '../../dist/storage.js';
import {createVerificationStore,verificationHash as hash} from '../../dist/verification-store.js';
import {verificationPolicy} from '../../dist/verification.js';
import {sourceReader} from '../../dist/verification-sources.js';
import {startRunnerServer,runnerClient,treeDigest,fileDigest} from '../../dist/verification-runner.js';
import {createVerificationEngine} from '../../dist/verification-engine.js';
import {verificationProcess} from '../../dist/verification-process.js';
import {deliverVerification} from '../../dist/verification-worker.js';
import {codexExecutor} from '../../dist/verification-models.js';
import {verificationFlowConfig,verificationFlowPolicyInput} from './verification-flow-config.mjs';
import {fixtureNetwork,fixtureDatabase,fixtureServices} from './fixture-network.mjs';

const flowConfig=verificationFlowConfig(process.env);
const required=name=>{const value=process.env[name];assert.ok(value,`${name} is required`);return value;};
const proof=fixtureNetwork();
const fixture=readPrivate(required('BUG_HUNT_FLOW_DB_CONFIG'));
for(const [key,role] of [['ownerURL','owner'],['appURL','app']])fixtureDatabase(fixture[key],role,'brai_bug_hunt_test',proof);
const profile=readPrivate(required('BUG_HUNT_NATIVE_PROFILE_FILE'));
assert.ok(profile.process&&!profile.socketUrl,'a private process NativeProfile is required');
const registryPath=required('BUG_HUNT_RECIPE_REGISTRY');assert.ok(isAbsolute(registryPath));
const registry=JSON.parse(readFileSync(registryPath,'utf8'));
assert.ok(Array.isArray(registry.sources)&&Array.isArray(registry.recipes)&&Array.isArray(registry.runnerRecipes));
const deps=required('BUG_HUNT_RECIPE_DEPENDENCIES_ROOT');assert.ok(isAbsolute(deps));
const temporalAddress=required('BUG_HUNT_TEST_TEMPORAL_ADDRESS');
const namespace=required('BUG_HUNT_TEST_TEMPORAL_NAMESPACE');
const natsURL=fixtureServices(required('BUG_HUNT_TEST_NATS_URL'),temporalAddress,namespace,proof);

test('real prepared recipes, independent reviewer, Temporal and isolated originals',async t=>{
 const {externalWorker,runnerSocket:externalRunnerSocket,installationId,ownerId,taskQueue}=flowConfig;
 const root=await mkdtemp(join(tmpdir(),'bug-hunt-real-flow-')),socket=externalRunnerSocket??join(root,'runner.sock');
 const owner=new Pool({connectionString:fixture.ownerURL,max:1}),app=new Pool({connectionString:fixture.appURL,max:6});
 const p={ownerId,actorId:'fixture',source:'codex',reviewer:false};
 const policy=verificationPolicy(verificationFlowPolicyInput(flowConfig));
 const handles=[];let server,nc,subscription,control,native,worker,workerRun,execution;
 try{
  await migrate(owner,'bug_hunt_owner','bug_hunt_app');
  const originals=createStore(app,{installationId,cursorKey:'synthetic-originals-cursor-key-at-least32',maxReports:100,reportsPerMinute:100,maxDatabaseBytes:1073741824});
  const store=createVerificationStore(app,{installationId,cursorKey:'synthetic-verification-cursor-key-atleast32',policy:()=>policy,maxDatabaseBytes:1073741824});
  if(externalRunnerSocket===undefined){
   const node=await realpath(process.execPath),nodeRoot=dirname(dirname(node));
   const runnerConfig={socket,stateRoot:join(root,'runs'),node,nodeRoot,dependenciesRoot:deps,dependencies_sha256:await treeDigest(deps,2147483648),node_sha256:await fileDigest(node),recipes:registry.runnerRecipes};
   server=await startRunnerServer(runnerConfig,event=>{if(event.exit_code!==0)console.log(JSON.stringify({synthetic_runner_exit_code:event.exit_code}));});
  }
  nc=await connect({servers:natsURL.href,...(process.env.NATS_USER?{user:process.env.NATS_USER,pass:process.env.NATS_PASSWORD}: {})});
  const codec=StringCodec();subscription=nc.subscribe('brai.auth.v2.identity-get',{callback:(_error,msg)=>{
   try{const input=JSON.parse(codec.decode(msg.data));msg.respond(codec.encode(JSON.stringify({user:{id:input.userId,status:input.userId===p.ownerId?'active':'blocked'}})));}catch{msg.respond(codec.encode('{}'));}
  }});await nc.flush();
  if(!externalWorker){
   const engine=createVerificationEngine({stopping:()=>execution?.stopping??false,store,sources:sourceReader(registry.sources),runner:runnerClient(socket),recipes:registry.recipes,
    activeOwner:async id=>{try{await activeIdentity(async(subject,input)=>JSON.parse(codec.decode((await nc.request(subject,codec.encode(JSON.stringify(input)),{timeout:2000})).data)),id);return true;}catch{return false;}},
    executor:(_r,dispatch)=>codexExecutor(profile,dispatch)});
   execution=verificationProcess(engine);
  }
  control=await Connection.connect({address:temporalAddress});
  if(!externalWorker)native=await NativeConnection.connect({address:temporalAddress});
  const client=new Client({connection:control,namespace});
  if(!externalWorker){
   worker=await Worker.create({connection:native,namespace,taskQueue,workflowBundle:{codePath:fileURLToPath(new URL('../../dist/verification-workflow-bundle.cjs',import.meta.url))},activities:{advance:id=>execution.advance(id)},maxConcurrentActivityTaskExecutions:1,maxConcurrentWorkflowTaskExecutions:2});
   workerRun=worker.run();
  }
  const recipe=ref=>{const found=registry.recipes.filter(x=>x.ref===ref);assert.equal(found.length,1,ref);return found[0];};
  const baseline=recipe('reviewer-baseline'),fixed=recipe('reviewer-fixed');
  assert.ok(!registry.recipes.some(item=>item.source_commit==='0'.repeat(40)));
  assert.notEqual(baseline.source_commit,fixed.source_commit);
  const cases=[
   {name:'reviewer-baseline',verdict:'confirmed',binding:baseline},
   {name:'reviewer-fixed',verdict:'refuted',binding:fixed},
   {name:'dto-v1',verdict:'refuted',binding:recipe('dto-v1')},
   {name:'dto-v3',verdict:'refuted',binding:recipe('dto-v3')},
   {name:'unsupported',verdict:'insufficient_evidence',binding:fixed,commit:'0'.repeat(40)},
   {name:'unrelated',verdict:'insufficient_evidence',binding:fixed,observation:{title:'Unrelated synthetic observation',operation:'Inspect an unrelated fixture',expected:'available',observed:'missing'}},
   {name:'mixed-group',verdict:'insufficient_evidence',binding:fixed,group:true}
  ];
  for(const scenario of cases)await t.test(scenario.name,async()=>{
   const binding=scenario.binding,observation={...(scenario.observation??binding.observation),component_id:binding.source_id,commit_sha:scenario.commit??binding.source_commit};
   const reportInput={request_id:randomUUID(),observation},receipt=await originals.report(p,reportInput,async()=>{});
   const reports=[receipt.report_id];let target={kind:'case',id:receipt.case_id};
   if(scenario.group){
    const other=await originals.report(p,{request_id:randomUUID(),observation:{title:'Unrelated synthetic observation',operation:'Inspect an unrelated fixture',expected:'available',observed:'missing',component_id:binding.source_id,commit_sha:binding.source_commit}},async()=>{});
    reports.push(other.report_id);const group=randomUUID();
    await owner.query('INSERT INTO observation_group(id,installation_id,owner_id) VALUES($1,$2,$3)',[group,installationId,p.ownerId]);
    for(const caseId of [receipt.case_id,other.case_id])await owner.query("INSERT INTO group_membership(installation_id,owner_id,case_id,group_id,method) VALUES($1,$2,$3,$4,'manual')",[installationId,p.ownerId,caseId,group]);
    target={kind:'group',id:group};
   }
   const originalDigest=async()=>hash((await owner.query('SELECT id,observation FROM report WHERE id=ANY($1::uuid[]) ORDER BY id',[reports])).rows);
   const before=await originalDigest();
   const input={request_id:randomUUID(),target},admitted=await store.request(p,input),id=admitted.investigation_ids[0];
   assert.deepEqual(await store.request(p,input),{...admitted,replayed:true});
   await deliverVerification(store,client,taskQueue);
   const workflow=(await owner.query('SELECT workflow_id FROM verification_investigation WHERE id=$1',[id])).rows[0].workflow_id;
   const handle=client.workflow.getHandle(workflow);handles.push(handle);await handle.result();
   const result=await store.get(p,id);assert.equal(result.state,'completed',JSON.stringify({scenario:scenario.name,state:result.state,code:result.code}));
   assert.equal(result.results[0].payload.verdict,scenario.verdict);assert.equal(result.results[0].validator_receipt.verdict,scenario.verdict);
   assert.equal(await originalDigest(),before);
   const effects=(await owner.query("SELECT kind,step_key,checkpoint FROM verification_effect WHERE investigation_id=$1 ORDER BY id",[id])).rows;
   const investigator=effects.find(e=>e.kind==='model'&&e.step_key==='investigator'),reviewer=effects.find(e=>e.kind==='model'&&e.step_key==='reviewer');
   assert.ok(investigator&&reviewer);assert.ok(investigator.checkpoint.native.threadId&&reviewer.checkpoint.native.threadId);assert.notEqual(investigator.checkpoint.native.threadId,reviewer.checkpoint.native.threadId);
   const runs=effects.filter(e=>e.kind==='runner');
   if(scenario.verdict==='insufficient_evidence')assert.equal(runs.length,0);
   else{assert.equal(runs.length,1);const proof=runs[0].checkpoint.result;assert.equal(proof.state,'completed');assert.equal(proof.cleanup,'done');assert.equal(proof.source_commit,binding.source_commit);assert.equal(proof.fidelity,'synthetic');assert.ok(proof.substituted_boundaries.includes('network'));}
   const effectHash=hash(effects);assert.deepEqual(await store.request(p,input),{...admitted,replayed:true});
   assert.equal(hash((await owner.query("SELECT kind,step_key,checkpoint FROM verification_effect WHERE investigation_id=$1 ORDER BY id",[id])).rows),effectHash);
   await assert.rejects(store.get({...p,ownerId:'synthetic-foreign'},id),e=>e.code==='NOT_FOUND');
  });
 }finally{
  for(const handle of handles)await handle.terminate('synthetic fixture cleanup').catch(()=>{});
  if(execution)await execution.stop().catch(()=>{});
  if(worker?.getState()==='RUNNING')worker.shutdown();await workerRun?.catch(()=>{});
  subscription?.unsubscribe();if(nc)await nc.close();if(server)await new Promise(r=>server.server.close(r));
  await Promise.all([control?.close(),native?.close(),app.end(),owner.end()]);await rm(root,{recursive:true,force:true});
 }
});
