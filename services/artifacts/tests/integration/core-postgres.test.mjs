// ABOUTME: Проверяет реальные PostgreSQL и FS границы artifacts и аварийные перезапуски.
// ABOUTME: Создаёт и удаляет собственную БД/роли только на разрешённом loopback стенде.
import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import {Pool} from "pg";
import {randomUUID,createHash} from "node:crypto";
import {mkdtemp,rm,readFile,readdir,writeFile,utimes} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {createArtifactsCore} from "../../dist/core.js";
import {createPostgresStore} from "../../dist/postgres.js";
import {createFileStore} from "../../dist/files.js";
import {migrate} from "../../dist/migrate.js";
import {subjects,validateResponse} from "../../contracts/index.mjs";
import {fixturePool,closeFixturePool} from "./fixture-pool.mjs";
const fixture=process.env.ARTIFACTS_TEST_ADMIN_URL;if(!fixture)throw new Error("Explicit ARTIFACTS_TEST_ADMIN_URL required");
const adminURL=new URL(fixture);if(adminURL.hostname!=="127.0.0.1"||adminURL.port!=="25541"||adminURL.pathname!=="/brai_artifacts_test")throw new Error("Refusing non-fixture database");
const suffix=`${process.pid}_${Date.now()}`,database=`brai_artifacts_test_${suffix}`,ownerRole=`artifacts_owner_${suffix}`,appRole=`artifacts_app_${suffix}`;
const admin=new Pool({connectionString:fixture,connectionTimeoutMillis:1000}),ownerURL=new URL(fixture),appURL=new URL(fixture);
ownerURL.username=ownerRole;ownerURL.pathname="/"+database;appURL.username=appRole;appURL.pathname="/"+database;
let owner,app,root,files,core,store;const config={uploadBaseURL:"http://fixture",internalBaseURL:"http://internal",externalBaseURL:"https://share.invalid",maxUploadBytes:1048576,staleTempAgeMs:1000,reconcileBatchSize:2};
const metadata={title:"Материал",filename:"../../filename.bin",extension:"bin",mimeType:"application/octet-stream",source:"integration"};
const exec=promisify(execFile),workerPath=fileURLToPath(new URL("./core-worker.mjs",import.meta.url));
const workerEnv=(mode,payload)=>({...process.env,ARTIFACTS_TEST_WORKER_URL:appURL.href,ARTIFACTS_TEST_ROOT:root,ARTIFACTS_TEST_MODE:mode,ARTIFACTS_TEST_PAYLOAD:JSON.stringify(payload)});
async function worker(mode,payload){const {stdout}=await exec(process.execPath,[workerPath],{env:workerEnv(mode,payload),timeout:15000});return JSON.parse(stdout);}
const code=expected=>error=>error.code===expected;
const prepare=async(kind="original",ownerId="owner")=>core.execute("prepare",{requestId:randomUUID(),ownerId,kind,metadata});
const upload=async(kind="original",ownerId="owner",value="test bytes")=>{const p=await prepare(kind,ownerId);return core.upload(p.uploadUrl.split("/").at(-1),(async function*(){yield Buffer.from(value);})());};
before(async()=>{
  await admin.query(`CREATE ROLE "${ownerRole}" LOGIN`);await admin.query(`CREATE ROLE "${appRole}" LOGIN`);await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
  owner=fixturePool({connectionString:ownerURL.href,connectionTimeoutMillis:1000});app=fixturePool({connectionString:appURL.href,connectionTimeoutMillis:1000});
  root=await mkdtemp(join(tmpdir(),"artifacts-pg-"));files=await createFileStore(root);
  await migrate(owner,ownerRole,appRole);store=createPostgresStore(app);core=createArtifactsCore({store,files,config});
});
after(async()=>{
  const closed=await Promise.allSettled([closeFixturePool(app),closeFixturePool(owner)]);
  try{await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);}finally{await admin.query(`DROP ROLE IF EXISTS "${appRole}"`);await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`);await admin.end();if(root)await rm(root,{recursive:true,force:true});}
  for(const result of closed)if(result.status==="rejected")throw result.reason;
});
test("migrate repeats safely and refuses invalid/privileged identities before DDL",async()=>{
  const snapshot=async()=>JSON.stringify((await owner.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='artifacts' ORDER BY table_name,ordinal_position")).rows);
  const before=await snapshot();
  for(const roles of [["",appRole],[ownerRole,""],[ownerRole,ownerRole],["wrong",appRole],[ownerRole,"fixture_postgres"],[ownerRole,"missing_role"]])await assert.rejects(migrate(owner,...roles));
  await assert.rejects(migrate(app,ownerRole,appRole));assert.equal(await snapshot(),before);
  await migrate(owner,ownerRole,appRole);assert.equal(await snapshot(),before);
  await assert.rejects(app.query("CREATE TABLE artifacts.forbidden(id integer)"),e=>e.code==="42501");
  await assert.rejects(app.query("SELECT * FROM artifacts.migrations"),e=>e.code==="42501");
  await assert.rejects(app.query("DELETE FROM artifacts.artifacts"),e=>e.code==="42501");
  await assert.rejects(app.query("UPDATE artifacts.artifacts SET owner_id='changed'"),e=>e.code==="42501");
});
test("ready bytes, SHA, stable pages, metadata-only edits and separate stats",async()=>{
  const ownerId=randomUUID(),original=await upload("original",ownerId,"abcd"),copy=await upload("copy",ownerId,"12345678");
  assert.equal(validateResponse(subjects.get,original),true);assert.equal(original.sha256,createHash("sha256").update("abcd").digest("hex"));assert.deepEqual(await readFile(join(root,"files",original.artifactId)),Buffer.from("abcd"));
  const page=await core.execute("list",{filter:{ownerId,status:"ready"},sort:"sizeBytes",order:"desc",limit:1,offset:0});assert.equal(page.total,2);assert.equal(page.items[0].artifactId,copy.artifactId);
  const next=await core.execute("list",{filter:{ownerId},sort:"sizeBytes",order:"desc",limit:1,offset:1});assert.equal(next.items[0].artifactId,original.artifactId);
  assert.deepEqual(await core.execute("stats",{ownerId}),{originalCount:1,copyCount:1,totalCount:2,originalBytes:4,copyBytes:8,totalBytes:12});
  await core.execute("update",{requestId:"u",artifactId:original.artifactId,metadata:{title:"changed",filename:"/etc/passwd",materialCreatedAt:null}});assert.deepEqual(await readFile(join(root,"files",original.artifactId)),Buffer.from("abcd"));
  assert.equal((await owner.query("SELECT count(*) FROM artifacts.artifact_links")).rows[0].count,"0");
});
test("prepare durable dedup works across processes and changed input conflicts",async()=>{
  const input={requestId:randomUUID(),ownerId:"owner",kind:"original",metadata};const responses=await Promise.all(Array.from({length:5},()=>worker("prepare",input)));const ids=new Set(responses.map(r=>r.result.artifact.artifactId));assert.equal(ids.size,1);assert.equal(new Set(responses.map(r=>r.result.uploadUrl)).size,1);
  assert.equal((await worker("prepare",{...input,ownerId:"other"})).error,"CONFLICT");
});
test("concurrent upload cannot replace published ID",async()=>{
  const p=await prepare(),token=p.uploadUrl.split("/").at(-1);const outputs=await Promise.all([worker("upload",{token,value:"first"}),worker("upload",{token,value:"second"})]);assert.equal(outputs.filter(r=>r.result?.status==="ready").length,1);assert.equal(outputs.filter(r=>r.error==="CONFLICT").length,1);const artifact=await core.execute("get",{artifactId:p.artifact.artifactId});assert.equal(artifact.status,"ready");assert.equal((await files.inspect(artifact.artifactId)).sha256,artifact.sha256);
});
test("process crash after FS publication recovers; before publication fails explicitly",async()=>{
  for(const mode of ["crash-after-publish","crash-before-publish"]){
    const p=await prepare(),id=p.artifact.artifactId;await assert.rejects(exec(process.execPath,[workerPath],{env:workerEnv(mode,{token:p.uploadUrl.split("/").at(-1),value:"crash bytes"}),timeout:15000}),e=>e.code===47);
    const pending=await core.execute("get",{artifactId:id});assert.equal(pending.status,"pending");assert.equal(pending.sizeBytes,null);
    const recovered=createArtifactsCore({store:createPostgresStore(app),files:await createFileStore(root),config});await recovered.reconcile();
    const artifact=await recovered.execute("get",{artifactId:id});assert.equal(artifact.status,mode==="crash-after-publish"?"ready":"failed");
    if(artifact.status==="ready"){assert.equal(artifact.sizeBytes,11);assert.deepEqual(await readFile(join(root,"files",id)),Buffer.from("crash bytes"));}
  }
});
test("concurrent reservation has one creator, durable state and exact attachment ordering",async()=>{
  const original=await upload(),model=await upload("copy"),scope={ownerId:"owner",projectId:"project",threadId:"thread",operationId:randomUUID()},input={scope,clientUserMessageId:"native-id",commandHash:"d".repeat(64),attachments:[{originalArtifactId:original.artifactId,modelArtifactId:model.artifactId}]};
  const outputs=await Promise.all(Array.from({length:8},()=>worker("referenceReserve",input)));assert.equal(outputs.filter(r=>r.result?.created===true).length,1);assert.equal(outputs.filter(r=>r.result?.created===false).length,7);
  assert.equal((await worker("referenceReserve",{...input,attachments:[...input.attachments,...input.attachments]})).error,"CONFLICT");
  await worker("referenceUpdateState",{scope,state:"unknown"});const confirm={scope,clientUserMessageId:"native-id",turnId:"turn-id",itemId:"item-id"};await worker("referenceConfirm",confirm);assert.equal((await worker("referenceConfirm",{...confirm,itemId:"other"})).error,"CONFLICT");assert.equal((await worker("referenceUpdateState",{scope,state:"not-sent"})).error,"CONFLICT");
  const query={ownerId:"owner",projectId:"project",threadId:"thread"};assert.equal((await core.execute("referenceList",{scope:query,nativeItemIds:["item-id"]})).items.length,1);assert.equal((await core.execute("referenceList",{scope:query,nativeItemIds:["turn-id"]})).items.length,0);
  await core.execute("delete",{requestId:"delete",artifactId:original.artifactId});assert.equal((await worker("referenceReserve",input)).result.created,false);
  assert.equal((await worker("referenceReserve",{...input,scope:{...scope,operationId:randomUUID()}})).error,"CONFLICT");
});
test("delete concurrent with reservation serializes readiness and preserves relation",async()=>{
  const original=await upload(),model=await upload("copy");const relation={requestId:"r",modelArtifactId:model.artifactId,originalArtifactId:original.artifactId};await core.execute("relationAdd",relation);await core.execute("relationAdd",relation);
  const input={scope:{ownerId:"owner",projectId:"p",threadId:"t",operationId:randomUUID()},clientUserMessageId:"m",commandHash:"e".repeat(64),attachments:[{originalArtifactId:original.artifactId,modelArtifactId:model.artifactId}]};
  const outputs=await Promise.all([worker("delete",{requestId:"d",artifactId:original.artifactId}),worker("referenceReserve",input)]);assert.equal(outputs[0].result.status,"deleted");assert.ok(outputs[1].result?.created===true||outputs[1].error==="CONFLICT");assert.equal((await core.execute("relationList",{artifactId:original.artifactId})).items.length,1);assert.equal((await core.execute("get",{artifactId:model.artifactId})).status,"ready");assert.equal(await files.inspect(original.artifactId),undefined);
});
test("delete crash after unlink recovers and repeated deletes preserve size/hash",async()=>{
  const artifact=await upload();await assert.rejects(exec(process.execPath,[workerPath],{env:workerEnv("crash-after-unlink",{requestId:"d",artifactId:artifact.artifactId}),timeout:15000}),e=>e.code===48);
  assert.equal((await core.execute("get",{artifactId:artifact.artifactId})).status,"deleting");assert.equal(await files.inspect(artifact.artifactId),undefined);await core.reconcile();
  const outputs=await Promise.all(Array.from({length:3},()=>worker("delete",{requestId:"repeat",artifactId:artifact.artifactId})));for(const output of outputs){assert.equal(output.result.status,"deleted");assert.equal(output.result.sha256,artifact.sha256);assert.equal(output.result.sizeBytes,artifact.sizeBytes);}
});
test("stale temp cleanup preserves arbitrary ready bytes and untouched foreign files",async()=>{
  const ready=await upload(),id=randomUUID(),tempName=id+"."+randomUUID()+".part";await writeFile(join(root,"tmp",tempName),"partial");const old=new Date(Date.now()-100000);await utimes(join(root,"tmp",tempName),old,old);await writeFile(join(root,"tmp","unknown-user-file"),"keep");await writeFile(join(root,"files",randomUUID()),"unknown-ready-file");
  await core.reconcile();assert.equal((await readdir(join(root,"tmp"))).includes(tempName),false);assert.equal((await readdir(join(root,"tmp"))).includes("unknown-user-file"),true);assert.deepEqual(await readFile(join(root,"files",ready.artifactId)),Buffer.from("test bytes"));assert.equal((await readdir(join(root,"files"))).length>=2,true);
});
test("lock timeout evicts uncertain connection instead of leaking future advisory lock",async()=>{
  const blocker=await app.connect(),key="artifact:"+randomUUID();await blocker.query("SELECT pg_advisory_lock(hashtextextended($1,73490217))",[key]);
  const boundedPool=fixturePool({connectionString:appURL.href,connectionTimeoutMillis:500,max:1});const bounded=createPostgresStore(boundedPool,{queryTimeoutMs:30,lockTimeoutMs:2000});
  try{
    await assert.rejects(bounded.withLocks([key],async()=>"never"),code("STORAGE_UNAVAILABLE"));assert.equal(boundedPool.totalCount,0);
    await blocker.query("SELECT pg_advisory_unlock(hashtextextended($1,73490217))",[key]);
    assert.equal(await bounded.withLocks([key],async()=>"acquired"),"acquired");
  }finally{blocker.release();await closeFixturePool(boundedPool);}
});
test("unavailable PostgreSQL refuses operation with bounded connection timeout",async()=>{
  const unavailable=new URL(appURL.href);unavailable.port="25542";const pool=fixturePool({connectionString:unavailable.href,connectionTimeoutMillis:100});
  try{const isolated=createArtifactsCore({store:createPostgresStore(pool),files,config});await assert.rejects(isolated.execute("get",{artifactId:randomUUID()}),code("STORAGE_UNAVAILABLE"));}finally{await closeFixturePool(pool);}
});

test("PostgreSQL disconnect aborts stalled upload and leaves no ready or partial file",async()=>{
  const p=await prepare(),name=`artifacts_fault_${suffix}`,pool=fixturePool({connectionString:appURL.href,application_name:name,connectionTimeoutMillis:1000,max:1}),isolated=createArtifactsCore({store:createPostgresStore(pool),files,config});
  let stalled;const started=new Promise(resolve=>{stalled=resolve;});let count=0;
  const source={[Symbol.asyncIterator](){return {next(){if(count++===0)return Promise.resolve({done:false,value:Buffer.from("partial")});stalled();return new Promise(()=>{});},return(){return Promise.resolve({done:true});}};}};
  try{
    const operation=isolated.upload(p.uploadUrl.split("/").at(-1),source);await started;
    const pid=(await admin.query("SELECT pid FROM pg_stat_activity WHERE datname=$1 AND application_name=$2",[database,name])).rows[0].pid;
    await admin.query("SELECT pg_terminate_backend($1)",[pid]);await assert.rejects(operation,code("STORAGE_UNAVAILABLE"));
    const artifact=await core.execute("get",{artifactId:p.artifact.artifactId});assert.notEqual(artifact.status,"ready");assert.equal(artifact.sizeBytes,null);assert.equal(await files.inspect(artifact.artifactId),undefined);assert.equal((await readdir(join(root,"tmp"))).some(name=>name.startsWith(artifact.artifactId)),false);
  }finally{await closeFixturePool(pool);}
});

test("PostgreSQL classifies unsupported Unicode input without hiding other data errors",async()=>{
  for(const patch of [{ownerId:"owner\u0000"},{requestId:"key\u0000"},{metadata:{details:{nested:"\u0000"}}},{metadata:{details:{nested:"\ud800"}}},{metadata:{details:{["key\u0000"]:"value"}}}]){
    const input={requestId:randomUUID(),ownerId:"unicode-owner",kind:"original",...patch,metadata:{...metadata,...patch.metadata}};
    await assert.rejects(core.execute("prepare",input),error=>error.code==="INVALID_ARGUMENT"&&error.status===400&&["22P05","22021","22P02"].includes(error.cause?.code));
    assert.equal((await core.execute("list",{filter:{ownerId:"unicode-owner"},sort:"createdAt",order:"asc",limit:1001,offset:0})).total,0);
  }
  await assert.rejects(store.withLocks([],session=>session.artifact("not-a-uuid")),error=>error.code==="STORAGE_UNAVAILABLE"&&error.cause?.code==="22P02");
  const input={requestId:"😀".repeat(256),ownerId:"😀".repeat(128),kind:"original",metadata:{...metadata,title:"😀".repeat(512)}};
  const prepared=await core.execute("prepare",input);assert.equal(prepared.artifact.title,input.metadata.title);assert.equal(prepared.artifact.ownerId,input.ownerId);assert.equal((await core.execute("prepare",input)).artifact.artifactId,prepared.artifact.artifactId);
});

test("list cursors retain snapshot consistency and fetch multiple batches",async()=>{
  const ownerId=randomUUID();for(let n=0;n<35;n++)await prepare("original",ownerId);
  await store.withLocks([],async session=>{
    const listing=await session.list({filter:{ownerId},sort:"createdAt",order:"asc",limit:1001,offset:0});assert.equal(listing.total,35);
    const later=await prepare("original",ownerId),items=[];for await(const artifact of listing.items)items.push(artifact);
    assert.equal(items.length,35);assert.equal(items.some(a=>a.artifactId===later.artifact.artifactId),false);
  });
  const listing=await core.execute("list",{filter:{ownerId},sort:"createdAt",order:"asc",limit:1001,offset:0});assert.equal(listing.total,36);assert.equal(listing.items.length,36);assert.equal(validateResponse(subjects.list,listing),true);
});

test("byte overflow closes cursor/transaction and reuses the only pooled connection",async()=>{
  const ownerId=randomUUID();for(let n=0;n<35;n++)await core.execute("prepare",{requestId:randomUUID(),ownerId,kind:"original",metadata:{...metadata,details:{padding:"😀".repeat(512)}}});
  const pool=fixturePool({connectionString:appURL.href,max:1,connectionTimeoutMillis:1000}),client=await pool.connect(),originalQuery=client.query;
  let fetches=0,maxRows=0;client.query=function(...args){const text=typeof args[0]==="string"?args[0]:args[0].text,result=originalQuery.apply(this,args);if(!result?.then)return result;return result.then(value=>{if(text.startsWith("FETCH")){fetches++;maxRows=Math.max(maxRows,value.rows.length);}return value;});};const pid=client.processID;client.release();
  const bounded=createArtifactsCore({store:createPostgresStore(pool),files,config:{...config,maxResultBytes:4096}});
  try{
    await assert.rejects(bounded.execute("list",{filter:{ownerId},sort:"createdAt",order:"asc",limit:1001,offset:0}),code("PAYLOAD_TOO_LARGE"));assert.equal(fetches,1);assert.equal(maxRows,16);
    assert.equal((await pool.query("SELECT count(*) FROM pg_cursors")).rows[0].count,"0");assert.equal((await admin.query("SELECT state FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0].state,"idle");
    assert.equal((await bounded.execute("list",{filter:{ownerId:"empty-owner"},sort:"createdAt",order:"asc",limit:1001,offset:0})).total,0);assert.equal(pool.totalCount,1);
  }finally{client.query=originalQuery;await closeFixturePool(pool);}
});

test("reference cursors return more than former default limits when the response fits",async()=>{
  const ownerId=randomUUID(),scope={ownerId,projectId:"p",threadId:"t"},createdAt=new Date().toISOString();
  const refs=Array.from({length:1001},(_,n)=>({scope:{...scope,operationId:"op-"+n},clientUserMessageId:"m-"+n,commandHash:"a".repeat(64),attachments:[],state:"confirmed",turnId:"turn",itemId:"item-"+n,createdAt,updatedAt:createdAt}));
  await owner.query("INSERT INTO artifacts.artifact_references(owner_id,project_id,thread_id,operation_id,document) SELECT $1,$2,$3,value->'scope'->>'operationId',value FROM jsonb_array_elements($4::jsonb)",[ownerId,"p","t",JSON.stringify(refs)]);
  const input={scope,nativeItemIds:refs.map(ref=>ref.itemId)},page=await core.execute("referenceList",input);assert.equal(page.items.length,1001);assert.equal(validateResponse(subjects.referenceList,page),true);
  const bounded=createArtifactsCore({store,files,config:{...config,maxResultBytes:2048}});await assert.rejects(bounded.execute("referenceList",input),code("PAYLOAD_TOO_LARGE"));assert.equal((await core.execute("referenceGet",{scope:refs[0].scope})).reference.itemId,refs[0].itemId);
});

test("relation cursors cross batches and large attachment arrays retain exact order",async()=>{
  const ownerId=randomUUID(),original=await upload("original",ownerId),models=[];
  for(let n=0;n<20;n++){const model=await upload("copy",ownerId);models.push(model);await core.execute("relationAdd",{requestId:randomUUID(),modelArtifactId:model.artifactId,originalArtifactId:original.artifactId});}
  const page=await core.execute("relationList",{artifactId:original.artifactId});assert.equal(page.items.length,20);assert.equal(validateResponse(subjects.relationList,page),true);
  const bounded=createArtifactsCore({store,files,config:{...config,maxResultBytes:1024}});await assert.rejects(bounded.execute("relationList",{artifactId:original.artifactId}),code("PAYLOAD_TOO_LARGE"));
  const attachments=Array.from({length:101},(_,n)=>({originalArtifactId:original.artifactId,modelArtifactId:models[n%models.length].artifactId}));const scope={ownerId,projectId:"p",threadId:"t",operationId:"many-attachments"};
  const reference=await core.execute("referenceReserve",{scope,clientUserMessageId:"m",commandHash:"a".repeat(64),attachments});assert.deepEqual(reference.reference.attachments,attachments);assert.equal(validateResponse(subjects.referenceReserve,reference),true);
});

test("fixture lifecycle reports unexpected idle PostgreSQL failures",async()=>{
  const pool=fixturePool({connectionString:appURL.href,connectionTimeoutMillis:1000}),client=await pool.connect(),pid=client.processID;client.release();
  const failure=new Promise(resolve=>pool.once("error",resolve));await admin.query("SELECT pg_terminate_backend($1)",[pid]);assert.equal((await failure).code,"57P01");
  await assert.rejects(closeFixturePool(pool),/unexpected PostgreSQL idle errors/);
});
