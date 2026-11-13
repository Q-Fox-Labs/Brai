// ABOUTME: Проходит настоящий snapshot → Codex investigator/reviewer → bwrap runner → validator → PostgreSQL.
// ABOUTME: Использует только собственные synthetic БД, Git fixtures, native threads и Unix socket; не включает общий worker.
import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {mkdtemp,mkdir,writeFile,rm,realpath} from "node:fs/promises";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {migrate} from "../../dist/migrate.js";
import {createStore} from "../../dist/storage.js";
import {createVerificationStore,verificationHash as hash} from "../../dist/verification-store.js";
import {verificationPolicy} from "../../dist/verification.js";
import {sourceReader} from "../../dist/verification-sources.js";
import {startRunnerServer,runnerClient,treeDigest,fileDigest} from "../../dist/verification-runner.js";
import {createVerificationEngine} from "../../dist/verification-engine.js";
import {connect} from "nats";
import {codexExecutor,providersExecutor,nativeRpc} from "../../dist/verification-models.js";
const executorKind=process.env.BUG_HUNT_FLOW_EXECUTOR??"codex_app_server";assert.ok(["codex_app_server","providers"].includes(executorKind));if(executorKind==="providers")assert.equal(process.env.BUG_HUNT_PREFLIGHT_TARGET,"dev");
if(executorKind==="providers"&&process.getuid?.()===0){const uid=Number(process.env.BUG_HUNT_TEST_UID),gid=Number(process.env.BUG_HUNT_TEST_GID);assert.ok(Number.isSafeInteger(uid)&&uid>=1000&&Number.isSafeInteger(gid)&&gid>=1000);process.setgroups([]);process.setgid(gid);process.setuid(uid);}
const exec=promisify(execFile),delay=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=JSON.parse(readFileSync(new URL("../../../../tmp/bug-hunt-test.json",import.meta.url),"utf8"));
for(const key of ["ownerURL","appURL"]){const u=new URL(fixture[key]);assert.equal(u.hostname,"127.0.0.1");assert.equal(u.pathname,"/brai_bug_hunt_test");}
test("three real controlled outcomes with immutable originals and a second Codex reviewer",{timeout:600000},async t=>{
 const tmpRoot=fileURLToPath(new URL("../../../../tmp/",import.meta.url));await mkdir(tmpRoot,{recursive:true});
 const root=await mkdtemp(join(tmpRoot,"verification-flow-")),source=join(root,"source"),repo=join(root,"source.git"),socket="/tmp/bhv3-"+randomUUID()+".sock";
 await mkdir(join(source,"fixtures"),{recursive:true});
 const implementation='export const evaluate = value => value > 0 ? "accepted" : "rejected";\n';
 const requirement="Contract: accept all nonnegative integers, including zero. Reject every negative integer.\n";
 const fixtureTexts={zero:JSON.stringify({module:"index.mjs",input:0}),negative:JSON.stringify({module:"index.mjs",input:-1})};
 await writeFile(join(source,"index.mjs"),implementation);await writeFile(join(source,"CONTRACT.md"),requirement);
 for(const [ref,body] of Object.entries(fixtureTexts))await writeFile(join(source,"fixtures",ref+".json"),body);
 await exec("/usr/bin/git",["init","--initial-branch=main",source]);
 await exec("/usr/bin/git",["-C",source,"add","index.mjs","CONTRACT.md","fixtures"]);
 await exec("/usr/bin/git",["-C",source,"-c","user.name=Synthetic Fixture","-c","user.email=fixture@example.invalid","commit","-m","fixture"]);
 const commit=(await exec("/usr/bin/git",["-C",source,"rev-parse","HEAD"])).stdout.trim();
 await exec("/usr/bin/git",["clone","--bare","--no-hardlinks",source,repo]);
 const owner=new Pool({connectionString:fixture.ownerURL,max:1}),app=new Pool({connectionString:fixture.appURL,max:6});
 const run=randomUUID(),installationId="flow-"+run,p={ownerId:"synthetic-"+run,actorId:"fixture",source:"codex",reviewer:false};
 const policy=verificationPolicy({enabled:true,revision:"flow-one",externalAllowedOwners:[p.ownerId],executor:executorKind,profiles:{providers:{connectionId:"acceptance",provider:"openrouter",model:"deepseek/deepseek-v3.2",revision:"synthetic-flow-qualified",inboxPrefix:"_INBOX.providers_client."}},budgets:{dailyCalls:40,ownerDailyCalls:40,dailyTokens:500000}});
 let server,providerNc;const nativeThreads=new Set();const checkpoints=[];
 try{
  await migrate(owner,"bug_hunt_owner","bug_hunt_app");
  const originals=createStore(app,{installationId,cursorKey:"synthetic-originals-cursor-key-at-least32",maxReports:100,reportsPerMinute:100,maxDatabaseBytes:1073741824});
  const store=createVerificationStore(app,{installationId,cursorKey:"synthetic-verification-cursor-key-atleast32",policy:()=>policy,maxDatabaseBytes:1073741824});
  const node=await realpath(process.execPath),nodeRoot=dirname(dirname(node)),harness=fileURLToPath(new URL("../../recipes/regression.mjs",import.meta.url));
  const deps=join(root,"deps");await mkdir(deps);const source_tree_sha256=await treeDigest(source);
  const runnerConfig={socket,stateRoot:join(root,"runs"),node,nodeRoot,dependenciesRoot:deps,dependencies_sha256:await treeDigest(deps),node_sha256:await fileDigest(node),recipes:[{id:"regression",version:"1",harness,harness_sha256:hash(readFileSync(harness,"utf8")),source_root:source,source_file:"index.mjs",source_commit:commit,source_sha256:hash(implementation),source_tree_sha256,fixture_refs:["zero","negative"],fixture_sha256:Object.fromEntries(Object.entries(fixtureTexts).map(([k,v])=>[k,hash(v)]))}]};
  server=await startRunnerServer(runnerConfig,event=>{if(event.exit_code!==0)console.log(JSON.stringify({synthetic_runner_diagnostic:event}));});
  const refutedClaim="Rejecting a negative integer is a defect";
  const recipes=Object.keys(fixtureTexts).map(ref=>({ref,recipe_id:"regression",recipe_version:"1",source_id:"fixture",source_commit:commit,source_sha256:hash(implementation),source_tree_sha256,source_path:"index.mjs",requirement_path:"CONTRACT.md",requirement_sha256:hash(requirement),expected:ref==="zero"?"accepted":"rejected",fixture_ref:ref,...(ref==="zero"?{confirms_claim:"Valid zero was rejected"}:{}),...(ref==="negative"?{refutes_claim:refutedClaim}:{})}));
  const profile={socketUrl:"ws+unix:///home/agent/.codex/app-server-control/app-server-control.sock:/",generation:"existing-server-0.166.0",serverVersion:"0.166.0",schema_sha256:"1740f9f8334ffec1782494cbf1a7e597b3815c1f8328273889efd2c3e32a763a",filesystem_isolation_verified:true,qualified_models:["gpt-6.1-sol"],tool_policy_version:"no-environment-scoped-tools-v2",cwd:root};
  if(executorKind==="providers")providerNc=await connect({servers:"nats://127.0.0.1:4223",user:process.env.NATS_USER,pass:process.env.NATS_PASSWORD,inboxPrefix:process.env.NATS_INBOX_PREFIX??"_INBOX.providers_caller",timeout:3000});
  const engine=createVerificationEngine({store,sources:sourceReader([{id:"fixture",repository:repo,components:["fixture"],paths:["index.mjs","CONTRACT.md"],externalAllowed:true}]),runner:runnerClient(socket),recipes,activeOwner:async()=>true,executor:(r,d)=>{
   const executor=executorKind==="providers"?providersExecutor(providerNc,p.ownerId,policy.profiles.providers,d):codexExecutor(profile,d);
   for(const method of ["startStep","inspectStep"]){const original=executor[method].bind(executor);executor[method]=async(...args)=>{const save=args.at(-1);args[args.length-1]=async cp=>{if(cp.native.threadId)nativeThreads.add(cp.native.threadId);checkpoints.push({state:cp.state,code:cp.code,phase:args[0].phase});await save(cp);};return original(...args);};}
   return executor;
  }});
  const cases=[
   {verdict:"confirmed",title:"Valid zero was rejected",operation:"Evaluate integer zero; use only zero spec",expected:"accepted",observed:"rejected",component_id:"fixture",commit_sha:commit},
   {verdict:"refuted",title:refutedClaim,operation:"Evaluate negative integer -1; use only negative spec. The claim is exactly: "+refutedClaim,expected:"accepted",observed:"rejected",component_id:"fixture",commit_sha:commit},
   {verdict:"insufficient_evidence",title:"Unknown version and missing evidence",operation:"Read unknown component",expected:"value",observed:"empty"}
  ];
  for(const scenario of cases)await t.test(scenario.verdict,async()=>{
   const {verdict,...observation}=scenario;
   const receipt=await originals.report(p,{request_id:randomUUID(),observation},async()=>{});
   const before=hash((await owner.query("SELECT observation FROM report WHERE id=$1",[receipt.report_id])).rows[0].observation);
   const admitted=await store.request(p,{request_id:randomUUID(),target:{kind:"case",id:receipt.case_id}});
   const id=admitted.investigation_ids[0];let step;
   for(let n=0;n<25;n++){step=await engine.advance(id);console.log(JSON.stringify({scenario:verdict,step}));if(step.terminal)break;await delay(100);}
   const result=await store.get(p,id);if(result.state!=="completed")console.log(JSON.stringify({scenario:verdict,model_results:(await owner.query("SELECT step_key,checkpoint->>\'state\' AS state,checkpoint->>\'code\' AS code,checkpoint->\'result\'->>\'verdict\' AS verdict,checkpoint->\'result\'->>\'accepted\' AS accepted FROM verification_effect WHERE investigation_id=$1 AND kind=\'model\' ORDER BY registered_at",[id])).rows}));assert.equal(result.state,"completed",JSON.stringify({state:result.state,code:result.code,checkpoints}));
   assert.equal(result.results[0].payload.verdict,verdict,JSON.stringify(result.results[0].payload));
   assert.equal(hash((await owner.query("SELECT observation FROM report WHERE id=$1",[receipt.report_id])).rows[0].observation),before);
   assert.equal(result.results[0].validator_receipt.verdict,verdict);
   if(verdict!=="insufficient_evidence"){const e=result.evidence.find(e=>e.kind==="runner");assert.ok(e);const proof=JSON.parse((await store.evidence(p,{investigation_id:id,evidence_id:e.id,limit:65536})).text);assert.equal(proof.cleanup,"done");assert.equal(proof.state,"completed");assert.equal(proof.source_commit,commit);}
   assert.equal((await store.get(p,id)).model.id,executorKind==="providers"?"deepseek/deepseek-v3.2":"gpt-6.1-sol");assert.equal((await store.get(p,id)).model.effort,executorKind==="providers"?null:"high");
   await assert.rejects(store.get({...p,ownerId:"foreign"},id),e=>e.code==="NOT_FOUND");
  });
  await writeFile(join(tmpRoot,"bug-hunt-verification-live.json"),JSON.stringify({run,installationId,userId:p.ownerId,sourceCommit:commit}),{mode:0o600});
  console.log(JSON.stringify({native_threads:nativeThreads.size,models:checkpoints.length,source_commit:commit,new_profiles_created:0}));
 }finally{
  const rpc=nativeRpc({socketUrl:"ws+unix:///home/agent/.codex/app-server-control/app-server-control.sock:/"});
  try{if(nativeThreads.size){await rpc.connect();await rpc.call("initialize",{clientInfo:{name:"brai_bug_hunt_fixture_cleanup",version:"3.0.0"}});rpc.send({method:"initialized",params:{}});for(const threadId of nativeThreads)await rpc.call("thread/archive",{threadId}).catch(()=>{});}}catch{}finally{rpc.close();}
  if(providerNc)await providerNc.close();
  if(server)await new Promise(r=>server.server.close(r));
  await Promise.all([app.end(),owner.end()]);await rm(root,{recursive:true,force:true});
 }
});
