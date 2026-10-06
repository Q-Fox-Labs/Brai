// ABOUTME: Проверяет живые NATS Services и HTTP adapters artifacts на изолированных PostgreSQL/NATS.
// ABOUTME: Принимает только закреплённые loopback fixtures и удаляет собственные ресурсы.
import test from "node:test";
import assert from "node:assert/strict";
import {Pool} from "pg";
import {connect} from "nats";
import {createHash,randomUUID} from "node:crypto";
import {mkdtemp,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {request as httpRequest} from "node:http";
import {createServer as createNetServer} from "node:net";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {loadArtifactsConfig} from "../../dist/config.js";
import {startArtifactsRuntime} from "../../dist/main.js";
import {migrate} from "../../dist/migrate.js";
import {subjects} from "../../contracts/index.mjs";
import {fixturePool,closeFixturePool} from "./fixture-pool.mjs";
const fixture=process.env.ARTIFACTS_TEST_ADMIN_URL;
const natsFixture=process.env.ARTIFACTS_TEST_NATS_URL;
if(!fixture||!natsFixture)throw new Error("Explicit ARTIFACTS_TEST_ADMIN_URL and ARTIFACTS_TEST_NATS_URL required");
const adminURL=new URL(fixture),natsURL=new URL(natsFixture);
if(adminURL.hostname!=="127.0.0.1"||adminURL.port!=="25541"||adminURL.pathname!=="/brai_artifacts_test"||adminURL.username!=="fixture_postgres"||natsURL.hostname!=="127.0.0.1"||natsURL.port!=="24241"||natsURL.protocol!=="nats:")throw new Error("Refusing non-fixture PostgreSQL or NATS");
const suffix=`${process.pid}_${Date.now()}`,database=`brai_artifacts_test_${suffix}`,ownerRole=`artifacts_owner_${suffix}`,appRole=`artifacts_app_${suffix}`;
const ownerURL=new URL(fixture),appURL=new URL(fixture);ownerURL.username=ownerRole;ownerURL.pathname=`/${database}`;appURL.username=appRole;appURL.pathname=`/${database}`;
const admin=new Pool({connectionString:fixture,connectionTimeoutMillis:1000});
let owner,app,nc,runtime,dataDir,port;const logLines=[],sensitiveValues=[];
const metadata=(filename,mimeType)=>({title:filename,filename,extension:filename.split(".").at(-1),mimeType,source:"transport-integration"});
const call=async(subject,payload)=>{const msg=await nc.request(subject,Buffer.from(JSON.stringify(payload)),{timeout:5000});const status=msg.headers?.get("Nats-Service-Error-Code");if(status)return {status:Number(status),code:msg.headers?.get("Nats-Service-Error")};return {status:200,value:JSON.parse(new TextDecoder().decode(msg.data))};};
const put=async(uploadURL,bytes)=>fetch(uploadURL,{method:"PUT",headers:{"content-length":String(bytes.byteLength)},body:bytes});
const getById=id=>call(subjects.get,{artifactId:id});
function rawPut(uploadURL,bytes,onResponse){return new Promise((resolve,reject)=>{const target=new URL(uploadURL);const req=httpRequest(target,{method:"PUT",headers:{"content-length":String(bytes.byteLength)}},res=>{onResponse?.(res);resolve(res);res.resume();});req.on("error",reject);req.end(bytes);});}
async function reserve(kind,ownerId,meta,requestId=randomUUID()){
 const result=await call(subjects.prepare,{requestId,ownerId,kind,metadata:meta});assert.equal(result.status,200);return {prepared:result.value,requestId};
}

test("actual NATS Services and streaming HTTP preserve lifecycle, limits, and explicit sharing",async t=>{
 const originalInfo=console.info;console.info=(...args)=>logLines.push(args.join(" "));t.after(()=>{console.info=originalInfo;});
 t.after(async()=>{await nc?.drain().catch(()=>{});await runtime?.stop().catch(()=>{});const closed=await Promise.allSettled([closeFixturePool(app),closeFixturePool(owner)]);await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(()=>{});await admin.query(`DROP ROLE IF EXISTS "${appRole}"`).catch(()=>{});await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`).catch(()=>{});if(dataDir)await rm(dataDir,{recursive:true,force:true});await admin.end();for(const result of closed)if(result.status==="rejected")throw result.reason;});
 try{
  await admin.query(`CREATE ROLE "${ownerRole}" LOGIN`);await admin.query(`CREATE ROLE "${appRole}" LOGIN`);await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
  owner=fixturePool({connectionString:ownerURL.href,connectionTimeoutMillis:1000});app=fixturePool({connectionString:appURL.href,connectionTimeoutMillis:1000});await migrate(owner,ownerRole,appRole);
  dataDir=await mkdtemp(join(tmpdir(),"artifacts-transport-"));
  const probe=await new Promise((resolve,reject)=>{const server=createNetServer();server.once("error",reject);server.listen(0,"127.0.0.1",()=>{const value=server.address().port;server.close(()=>resolve(value));});});port=probe;
  const env={...process.env,ARTIFACTS_DATABASE_URL:appURL.href,NATS_URL:natsFixture,ARTIFACTS_DATA_DIR:dataDir,ARTIFACTS_UPLOAD_BASE_URL:`http://127.0.0.1:${port}`,ARTIFACTS_INTERNAL_BASE_URL:"https://caddy.internal.example",ARTIFACTS_EXTERNAL_BASE_URL:`http://127.0.0.1:${port}`,ARTIFACTS_HTTP_HOST:"127.0.0.1",ARTIFACTS_HTTP_PORT:String(port),ARTIFACTS_MAX_UPLOAD_BYTES:"65536",ARTIFACTS_MAX_CONCURRENT_UPLOADS:"2",ARTIFACTS_MAX_CONCURRENT_NATS:"1",ARTIFACTS_MAX_NATS_REQUEST_BYTES:"1024",ARTIFACTS_MAX_NATS_RESPONSE_BYTES:"65536",ARTIFACTS_RECEIVE_TIMEOUT_MS:"2000",ARTIFACTS_RECONCILE_INTERVAL_MS:"60000"};
  runtime=await startArtifactsRuntime(loadArtifactsConfig(env));
  nc=await connect({servers:natsFixture,inboxPrefix:`_INBOX.test.artifacts.${suffix}`,timeout:3000,name:`artifacts-test-${suffix}`});

  for(const verb of ["PING","INFO","STATS"]){const response=await nc.request(`$SRV.${verb}.brai_artifacts`,new Uint8Array(),{timeout:3000});const records=JSON.parse(new TextDecoder().decode(response.data));const entries=Array.isArray(records)?records:[records];assert.ok(entries.some(item=>item.id===runtime.instanceId),`${verb} must report this runtime instance`);}
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(),{status:"ready"});
  assert.equal((await call(subjects.get,{})).status,400);
  assert.equal((await nc.request(subjects.get,new Uint8Array(),{timeout:3000})).headers.get("Nats-Service-Error-Code"),"400");
  assert.equal((await nc.request(subjects.get,Buffer.from("{"),{timeout:3000})).headers.get("Nats-Service-Error-Code"),"400");
  assert.equal((await nc.request(subjects.get,Buffer.alloc(2048,0x20),{timeout:3000})).headers.get("Nats-Service-Error-Code"),"413");
  const unicodeOwner="😀".repeat(70),unicode=await call(subjects.prepare,{requestId:randomUUID(),ownerId:unicodeOwner,kind:"original",metadata:metadata("unicode.bin","application/octet-stream")});assert.equal(unicode.status,200);assert.equal(unicode.value.artifact.ownerId,unicodeOwner);
  const invalidUnicode=await call(subjects.prepare,{requestId:randomUUID(),ownerId:"owner",kind:"original",metadata:{...metadata("nul.bin","application/octet-stream"),details:{nested:"\u0000"}}});assert.deepEqual(invalidUnicode,{status:400,code:"INVALID_ARGUMENT"});

  const fixtureFiles=[
   ["image.png","image/png",Buffer.from([137,80,78,71,13,10,26,10,0,255,23])],
   ["document.pdf","application/pdf",Buffer.from("%PDF-synthetic\nbody\x00")],
   ["audio.wav","audio/wav",Buffer.from("RIFF-synthetic-audio")],
   ["video.mp4","video/mp4",Buffer.from([0,0,0,24,102,116,121,112,109,112,52,50])],
  ];
  const ownerId=randomUUID(),uploaded=[];
  for(const [filename,mime,bytes] of fixtureFiles){const item=await reserve("original",ownerId,metadata(filename,mime));const response=await put(item.prepared.uploadUrl,bytes);assert.equal(response.status,201);assert.equal(response.headers.get("x-artifact-id"),item.prepared.artifact.artifactId);assert.equal(response.headers.get("x-artifact-state"),"ready");assert.equal(response.headers.get("x-artifact-size"),String(bytes.length));assert.equal(response.headers.get("x-artifact-sha256"),createHash("sha256").update(bytes).digest("hex"));assert.equal(response.headers.get("location"),`https://caddy.internal.example/files/${item.prepared.artifact.artifactId}`);assert.equal(await response.text(),"");uploaded.push({item,bytes});}
  const changed=await call(subjects.update,{requestId:randomUUID(),artifactId:uploaded[0].item.prepared.artifact.artifactId,metadata:{title:"edited in NATS"}});assert.equal(changed.status,200);assert.equal(changed.value.title,"edited in NATS");
  const listing=await call(subjects.list,{filter:{ownerId,status:"ready"},sort:"createdAt",order:"asc",limit:20,offset:0});assert.equal(listing.status,200);assert.equal(listing.value.total,4);assert.equal(listing.value.items.length,4);
  const sparseLargePage=await call(subjects.list,{filter:{ownerId,status:"ready"},sort:"createdAt",order:"asc",limit:1001,offset:0});assert.equal(sparseLargePage.status,200);assert.equal(sparseLargePage.value.limit,1001);assert.equal(sparseLargePage.value.items.length,4);
  for(const {item} of uploaded){const response=await getById(item.prepared.artifact.artifactId);assert.equal(response.status,200);assert.equal(response.value.status,"ready");}
  assert.equal((await app.query("SELECT count(*) FROM artifacts.artifact_links")).rows[0].count,"0","ordinary prepare/get/list must not create links");

  const simultaneous=await reserve("original",ownerId,metadata("concurrent.bin","application/octet-stream"));const candidates=[Buffer.from("immutable first bytes"),Buffer.from("immutable second bytes")];const concurrent=await Promise.all(candidates.map(bytes=>put(simultaneous.prepared.uploadUrl,bytes)));assert.deepEqual(concurrent.map(response=>response.status).sort(),[201,409]);const immutable=(await getById(simultaneous.prepared.artifact.artifactId)).value;assert.equal(immutable.status,"ready");assert.ok(candidates.some(bytes=>immutable.sha256===createHash("sha256").update(bytes).digest("hex")));assert.equal((await put(simultaneous.prepared.uploadUrl,Buffer.from("third replay"))).status,409);
  const original=uploaded[0].item.prepared.artifact.artifactId;
  const model=await reserve("copy",ownerId,metadata("model.png","image/png"));const modelBytes=Buffer.from("model-copy");assert.equal((await put(model.prepared.uploadUrl,modelBytes)).status,201);
  const relation={requestId:randomUUID(),modelArtifactId:model.prepared.artifact.artifactId,originalArtifactId:original};assert.equal((await call(subjects.relationAdd,relation)).status,200);assert.equal((await call(subjects.relationList,{artifactId:original})).value.items.length,1);assert.equal((await call(subjects.relationRemove,relation)).status,200);
  const scope={ownerId,projectId:"project",threadId:"thread",operationId:randomUUID()};const reference={scope,clientUserMessageId:"native-message-1",commandHash:createHash("sha256").update("synthetic command").digest("hex"),attachments:[{originalArtifactId:original,modelArtifactId:model.prepared.artifact.artifactId}]};
  const reserved=await call(subjects.referenceReserve,reference);assert.equal(reserved.status,200);assert.equal(reserved.value.created,true);assert.equal((await call(subjects.referenceReserve,reference)).value.created,false);assert.equal((await call(subjects.referenceGet,{scope})).status,200);assert.equal((await call(subjects.referenceUpdateState,{scope,state:"unknown"})).status,200);assert.equal((await call(subjects.referenceConfirm,{scope,clientUserMessageId:"native-message-1",turnId:"turn-1",itemId:"native-item-1"})).status,200);assert.equal((await call(subjects.referenceList,{scope:{ownerId,projectId:"project",threadId:"thread"},nativeItemIds:["native-item-1"]})).value.items.length,1);
  let activeGrant;
  for(let index=0;index<uploaded.length;index++){const {item,bytes}=uploaded[index];const grant=await call(subjects.linkCreate,{requestId:randomUUID(),artifactId:item.prepared.artifact.artifactId});assert.equal(grant.status,200);sensitiveValues.push(new URL(grant.value.link.url).pathname.split("/").at(-1));if(index===0)activeGrant=grant.value.link;const shared=await fetch(grant.value.link.url);assert.equal(shared.status,200);assert.equal(shared.headers.get("content-type"),"application/octet-stream");assert.match(shared.headers.get("content-disposition"),/^attachment;/);assert.deepEqual(Buffer.from(await shared.arrayBuffer()),bytes);assert.equal((await fetch(grant.value.link.url,{method:"HEAD"})).status,200);if(index>0){assert.equal((await call(subjects.linkRevoke,{requestId:randomUUID(),linkId:grant.value.link.linkId})).status,200);assert.equal((await fetch(grant.value.link.url)).status,404);}}
  assert.equal((await app.query("SELECT count(*) FROM artifacts.artifact_links")).rows[0].count,"4");
  const expiring=await call(subjects.linkCreate,{requestId:randomUUID(),artifactId:uploaded[1].item.prepared.artifact.artifactId,expiresAt:new Date(Date.now()+1000).toISOString()});assert.equal(expiring.status,200);sensitiveValues.push(new URL(expiring.value.link.url).pathname.split("/").at(-1));assert.equal((await fetch(expiring.value.link.url)).status,200);await new Promise(resolve=>setTimeout(resolve,1100));assert.equal((await fetch(expiring.value.link.url)).status,404);

  const blocked=await reserve("original",ownerId,metadata("blocked.bin","application/octet-stream"));const key=`prepare:${blocked.requestId}`,locker=await app.connect();await locker.query("SELECT pg_advisory_lock(hashtextextended($1,73490217))",[key]);
  try{const waiting=call(subjects.prepare,{requestId:blocked.requestId,ownerId,kind:"original",metadata:metadata("blocked.bin","application/octet-stream")});let reached=false;for(let n=0;n<100;n++){const waitingDB=(await admin.query("SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND wait_event='advisory'",[database])).rows[0].count;if(Number(waitingDB)>0){reached=true;break;}await new Promise(resolve=>setTimeout(resolve,25));}assert.equal(reached,true,"first request must be waiting on the held PG lock");const overloaded=await call(subjects.stats,{ownerId});assert.equal(overloaded.status,429);await locker.query("SELECT pg_advisory_unlock(hashtextextended($1,73490217))",[key]);const completed=await waiting;assert.equal(completed.status,200);}finally{await locker.query("SELECT pg_advisory_unlock(hashtextextended($1,73490217))",[key]).catch(()=>{});locker.release();}

  const tooLarge=await reserve("original",ownerId,metadata("large.bin","application/octet-stream"));assert.equal((await put(tooLarge.prepared.uploadUrl,Buffer.alloc(70000))).status,413);
  const interrupted=await reserve("original",ownerId,metadata("interrupted.bin","application/octet-stream"));const interrupted2=await reserve("original",ownerId,metadata("interrupted-2.bin","application/octet-stream"));const startStalled=item=>{const req=httpRequest(new URL(item.prepared.uploadUrl),{method:"PUT",headers:{"transfer-encoding":"chunked"}});req.on("error",()=>{});const response=new Promise(resolve=>req.once("response",res=>{res.resume();resolve(res.statusCode);}));req.write(Buffer.from("partial"));return {req,response};};const stalled=startStalled(interrupted);await new Promise(resolve=>setTimeout(resolve,100));const stalled2=startStalled(interrupted2);await new Promise(resolve=>setTimeout(resolve,100));const overflow=await put(interrupted.prepared.uploadUrl,Buffer.from("third request"));assert.equal(overflow.status,429);assert.deepEqual((await Promise.all([stalled.response,stalled2.response])).sort(),[503,503],"absolute upload deadline must return bounded failures and close unread bodies");assert.notEqual((await getById(interrupted.prepared.artifact.artifactId)).value.status,"ready");assert.notEqual((await getById(interrupted2.prepared.artifact.artifactId)).value.status,"ready");

  const uncertain=await reserve("original",ownerId,metadata("uncertain.bin","application/octet-stream"));const bytes=Buffer.from("published before client drops reply");let lost=false;await rawPut(uncertain.prepared.uploadUrl,bytes,res=>{lost=true;res.destroy();});assert.equal(lost,true);const state=await getById(uncertain.prepared.artifact.artifactId);assert.equal(state.value.status,"ready");const same=await reserve("original",ownerId,metadata("uncertain.bin","application/octet-stream"),uncertain.requestId);assert.equal(same.prepared.artifact.artifactId,uncertain.prepared.artifact.artifactId);assert.equal((await put(same.prepared.uploadUrl,Buffer.from("different replay"))).status,409);assert.equal((await call(subjects.get,{artifactId:uncertain.prepared.artifact.artifactId})).value.sha256,createHash("sha256").update(bytes).digest("hex"));

  const deleted=await call(subjects.delete,{requestId:randomUUID(),artifactId:original});assert.equal(deleted.status,200);assert.equal(deleted.value.status,"deleted");assert.equal((await call(subjects.get,{artifactId:original})).value.status,"deleted");assert.equal((await fetch(activeGrant.url)).status,404);
  assert.equal(sensitiveValues.every(secret=>!logLines.join("\n").includes(secret)),true,"upload and share tokens must stay out of logs");assert.equal(logLines.some(line=>line.includes("published before client drops reply")),false,"file contents must stay out of logs");
  await runtime.stop();await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  const noSharingEnv={...env,ARTIFACTS_MAX_NATS_REQUEST_BYTES:"131072"};delete noSharingEnv.ARTIFACTS_EXTERNAL_BASE_URL;runtime=await startArtifactsRuntime(loadArtifactsConfig(noSharingEnv));assert.equal((await call(subjects.linkCreate,{requestId:randomUUID(),artifactId:model.prepared.artifact.artifactId})).status,503);assert.equal((await fetch(`http://127.0.0.1:${port}/share/${"a".repeat(43)}`)).status,503);
  const manyIds=await call(subjects.referenceList,{scope:{ownerId,projectId:"project",threadId:"thread"},nativeItemIds:["native-item-1",...Array.from({length:1000},(_,n)=>"missing-"+n)]});assert.equal(manyIds.status,200);assert.equal(manyIds.value.items.length,1);
  const manyAttachments=Array.from({length:101},()=>({originalArtifactId:uncertain.prepared.artifact.artifactId,modelArtifactId:model.prepared.artifact.artifactId}));const largeReference=await call(subjects.referenceReserve,{scope:{...scope,operationId:randomUUID()},clientUserMessageId:"many",commandHash:"a".repeat(64),attachments:manyAttachments});assert.equal(largeReference.status,200);assert.deepEqual(largeReference.value.reference.attachments,manyAttachments);await runtime.stop();
  const child=spawn(process.execPath,[fileURLToPath(new URL("../../dist/main.js",import.meta.url))],{env:{...env,ARTIFACTS_REQUEST_TIMEOUT_MS:"1000",ARTIFACTS_RECEIVE_TIMEOUT_MS:"10000"},stdio:["ignore","pipe","pipe"]});let childOutput="",childErrors="";child.stderr.on("data",chunk=>childErrors+=chunk);
  const exited=new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>resolve({code,signal}));});
  const childReady=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Child runtime startup timed out")),5000);child.stdout.on("data",chunk=>{childOutput+=chunk;if(childOutput.includes('"event":"ready"')){clearTimeout(timer);resolve();}});child.once("exit",()=>{clearTimeout(timer);reject(new Error("Child exited before ready"));});});
  let childRequest;
  try{
   await childReady;const shutdownItem=await reserve("original",ownerId,metadata("shutdown.bin","application/octet-stream"));childRequest=httpRequest(new URL(shutdownItem.prepared.uploadUrl),{method:"PUT",headers:{"transfer-encoding":"chunked"}});childRequest.on("error",()=>{});childRequest.on("response",response=>response.resume());childRequest.write(Buffer.from("partial before shutdown"));
   let reached=false;for(let n=0;n<100;n++){if((await readdir(join(dataDir,"tmp"))).some(name=>name.startsWith(shutdownItem.prepared.artifact.artifactId+"."))){reached=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(reached,true,"child must have started its real file stream");
   const stopStarted=Date.now();child.kill("SIGTERM");let timer;const result=await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Child SIGTERM did not finish")),3500);})]).finally(()=>clearTimeout(timer));assert.deepEqual(result,{code:0,signal:null});assert.ok(Date.now()-stopStarted<3500);
   const document=(await app.query("SELECT document FROM artifacts.artifacts WHERE artifact_id=$1",[shutdownItem.prepared.artifact.artifactId])).rows[0].document;assert.notEqual(document.artifact.status,"ready");assert.equal(document.artifact.sizeBytes,null);assert.equal((await readdir(join(dataDir,"tmp"))).some(name=>name.startsWith(shutdownItem.prepared.artifact.artifactId+".")),false);assert.equal((await readdir(join(dataDir,"files"))).includes(shutdownItem.prepared.artifact.artifactId),false);assert.equal(childErrors.includes('"event":"startup-failed"'),false);assert.equal(childOutput.includes("partial before shutdown"),false);
  }finally{childRequest?.destroy();if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await exited;}
 }catch(error){if(!runtime){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(()=>{});await admin.query(`DROP ROLE IF EXISTS "${appRole}"`).catch(()=>{});await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`).catch(()=>{});await admin.end();}throw error;}
});
