// ABOUTME: Проверяет отказ неверного external scope до чтения config и обращения к сервисам.
// ABOUTME: Тестирует только операторский test helper; Root и продуктовый runtime не используются.
import test from 'node:test';
import assert from 'node:assert/strict';
import {verificationFlowConfig,verificationFlowPolicyInput} from './integration/verification-flow-config.mjs';
import {verificationPolicy} from '../dist/verification.js';
const run='ab83a8cd-8108-4573-9ac9-66c46f09ecb6';
const external={BUG_HUNT_FLOW_EXTERNAL_WORKER:'1',BUG_HUNT_FLOW_RUN_UUID:run,BUG_HUNT_RUNNER_SOCKET:'/private/fixture-runner.sock'};
test('external worker scope derives solely from one explicit canonical UUIDv4',()=>{
 const value=verificationFlowConfig(external,()=>{throw Error('external must not randomize scope');});
 assert.deepEqual(value,{externalWorker:true,runnerSocket:external.BUG_HUNT_RUNNER_SOCKET,run,installationId:'flow-'+run,ownerId:'synthetic-'+run,taskQueue:'bug-hunt-fixture-'+run});
});
test('local mode keeps fresh random isolated scope and optional external runner compatibility',()=>{
 const a=verificationFlowConfig({}),b=verificationFlowConfig({});assert.equal(a.externalWorker,false);assert.notEqual(a.run,b.run);assert.equal(a.runnerSocket,undefined);assert.equal(a.ownerId,'synthetic-'+a.run);assert.equal(a.installationId,'flow-'+a.run);assert.equal(a.taskQueue,'bug-hunt-fixture-'+a.run);
 assert.deepEqual(verificationFlowConfig({BUG_HUNT_RUNNER_SOCKET:'/private/runner.sock'},()=>run),{externalWorker:false,runnerSocket:'/private/runner.sock',run,installationId:'flow-'+run,ownerId:'synthetic-'+run,taskQueue:'bug-hunt-fixture-'+run});
});
test('external mode rejects missing, malformed or non-v4 scope and requires its Root UDS',()=>{
 for(const value of [undefined,'','owner','../scope','00000000-0000-0000-0000-000000000000',run.toUpperCase(),run.replace('-4573-','-5573-')])assert.throws(()=>verificationFlowConfig({...external,BUG_HUNT_FLOW_RUN_UUID:value}),/BUG_HUNT_FLOW_RUN_UUID_INVALID/);
 for(const value of [undefined,'','relative.sock','ws+unix:///private/socket:', '/private/runner\0.sock'])assert.throws(()=>verificationFlowConfig({...external,BUG_HUNT_RUNNER_SOCKET:value}),/BUG_HUNT_RUNNER_SOCKET_(?:INVALID|REQUIRED)/);
 for(const value of ['','0','true','2'])assert.throws(()=>verificationFlowConfig({...external,BUG_HUNT_FLOW_EXTERNAL_WORKER:value}),/BUG_HUNT_FLOW_EXTERNAL_WORKER_INVALID/);
 assert.throws(()=>verificationFlowConfig({BUG_HUNT_FLOW_RUN_UUID:run}),/BUG_HUNT_FLOW_RUN_UUID_REQUIRES_EXTERNAL_WORKER/);
 for(const key of ['BUG_HUNT_FLOW_OWNER_ID','BUG_HUNT_FLOW_INSTALLATION_ID','BUG_HUNT_FLOW_TASK_QUEUE'])assert.throws(()=>verificationFlowConfig({...external,[key]:'arbitrary'}),/BUG_HUNT_FLOW_SCOPE_MUST_DERIVE_FROM_UUID/);
});
test('external admission policy matches Root consumer binding and retains all other flow defaults',()=>{
 const root=verificationFlowConfig(external),policy=verificationPolicy(verificationFlowPolicyInput(root)),localConfig=verificationFlowConfig({},()=>run),local=verificationPolicy(verificationFlowPolicyInput(localConfig));
 const previous=verificationPolicy({enabled:true,revision:'flow-real-recipes',externalAllowedOwners:[root.ownerId],executor:'codex_app_server',budgets:{dailyCalls:40,ownerDailyCalls:40,dailyTokens:500000}});
 assert.deepEqual(local,previous);assert.deepEqual(policy,{...previous,profiles:{...previous.profiles,codex_app_server:{endpointRef:'bug-hunt-private',revision:'owner-v1'}}});
});
