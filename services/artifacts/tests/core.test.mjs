// ABOUTME: Проверяет доменные правила artifacts без PostgreSQL и транспорта.
// ABOUTME: Подмены портов проверяют сбои границ и сохраняют точные публичные DTO.
import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {createArtifactsCore} from "../dist/core.js";
import {validateResponse,subjects} from "../contracts/index.mjs";
const metadata={title:"Материал",filename:"../../source.bin",extension:"bin",mimeType:"application/octet-stream",source:"test"};
const clone=value=>value===undefined?undefined:structuredClone(value);
function fixture(overrides={}) {
  const artifacts=new Map(),references=new Map(),relations=new Map(),links=new Map(),bytes=new Map(),temps=new Map();
  const sk=s=>JSON.stringify([s.ownerId,s.projectId,s.threadId,s.operationId]);
  const session={
    artifact:async id=>clone(artifacts.get(id.toLowerCase())),prepared:async requestId=>clone([...artifacts.values()].find(r=>r.artifact.requestId===requestId)),uploading:async token=>clone([...artifacts.values()].find(r=>r.uploadToken===token)),
    saveArtifact:async r=>{artifacts.set(r.artifact.artifactId,clone(r));},
    unfinished:async (after,limit)=>[...artifacts.values()].filter(r=>["pending","failed","deleting"].includes(r.artifact.status)&&(!after||r.artifact.artifactId>after)).map(r=>r.artifact.artifactId).sort().slice(0,limit),
    relation:async (m,o)=>clone(relations.get(m+o)),saveRelation:async r=>{relations.set(r.modelArtifactId+r.originalArtifactId,clone(r));},removeRelation:async(m,o)=>{relations.delete(m+o);},relations:async(id,limit=relations.size)=>clone([...relations.values()].filter(r=>[r.modelArtifactId,r.originalArtifactId].includes(id)).slice(0,limit)),
    reference:async s=>clone(references.get(sk(s))),saveReference:async r=>{references.set(sk(r.scope),clone(r));},references:async(s,ids,limit=references.size)=>clone([...references.values()].filter(r=>r.scope.ownerId===s.ownerId&&r.scope.projectId===s.projectId&&r.scope.threadId===s.threadId&&ids.includes(r.itemId)).slice(0,limit)),
    list:async input=>{const items=clone([...artifacts.values()].map(r=>r.artifact).filter(a=>a.ownerId===input.filter.ownerId));return {total:items.length,items:items.slice(input.offset,input.offset+input.limit)};},
    link:async id=>clone(links.get(id)),requestedLink:async requestId=>clone([...links.values()].find(r=>r.requestId===requestId)),shared:async token=>clone([...links.values()].find(r=>r.token===token)),saveLink:async r=>{links.set(r.link.linkId,clone(r));},
    stats:async ownerId=>{const all=[...artifacts.values()].map(r=>r.artifact).filter(a=>a.ownerId===ownerId&&a.status==="ready");const originals=all.filter(a=>a.kind==="original"),copies=all.filter(a=>a.kind==="copy");return {originalCount:originals.length,copyCount:copies.length,totalCount:all.length,originalBytes:originals.reduce((n,a)=>n+a.sizeBytes,0),copyBytes:copies.reduce((n,a)=>n+a.sizeBytes,0),totalBytes:all.reduce((n,a)=>n+a.sizeBytes,0)};}
  };
  const store={withLocks:async(_keys,fn)=>fn(session,new AbortController().signal)};
  const files={
    write:async(id,source,maxBytes,signal)=>{let chunks=[],sizeBytes=0;for await(const chunk of source){signal?.throwIfAborted();sizeBytes+=chunk.length;if(sizeBytes>maxBytes)throw Object.assign(new Error("PAYLOAD_TOO_LARGE"),{code:"PAYLOAD_TOO_LARGE"});chunks.push(chunk);}const value=Buffer.concat(chunks);temps.set(id,value);return {tempName:id,sizeBytes,sha256:createHash("sha256").update(value).digest("hex")};},
    publish:async(id,p)=>{bytes.set(id,temps.get(p.tempName));temps.delete(p.tempName);},inspect:async id=>{const value=bytes.get(id);return value?{sizeBytes:value.length,sha256:createHash("sha256").update(value).digest("hex")}:undefined;},remove:async id=>{bytes.delete(id);},removeTemp:async name=>{temps.delete(name);},staleTemps:async function*(){}
  };
  let clock=Date.now();const config={uploadBaseURL:"http://fixture",internalBaseURL:"http://internal",externalBaseURL:"https://share.invalid",maxUploadBytes:1024,staleTempAgeMs:10000,...overrides};
  const core=createArtifactsCore({store,files,config,now:()=>clock});
  const prepare=async(kind="original",ownerId="owner")=>core.execute("prepare",{requestId:randomUUID(),ownerId,kind,metadata});
  const uploaded=async(kind="original",ownerId="owner")=>{const p=await prepare(kind,ownerId);return core.upload(p.uploadUrl.split("/").at(-1),(async function*(){yield Buffer.from("content");})());};
  return {core,prepare,uploaded,session,store,files,artifacts,bytes,temps,config,advance:n=>{clock+=n;}};
}
const code=(expected)=>error=>error.code===expected;
test("core guards immutable ownership, bounded input and timestamps before ports",async()=>{
  const f=fixture({maxPageSize:2,maxReferenceItems:2,maxReferenceAttachments:1});
  const p=await f.prepare();
  await assert.rejects(f.core.execute("update",{requestId:"u",artifactId:p.artifact.artifactId,metadata:{ownerId:"other"}}),code("INVALID_ARGUMENT"));
  await assert.rejects(f.core.execute("prepare",{requestId:"x",ownerId:"owner",kind:"original",metadata:{...metadata,materialCreatedAt:null}}),code("INVALID_ARGUMENT"));
  await assert.rejects(f.core.execute("prepare",{requestId:"x",ownerId:"owner",kind:"original",metadata:{...metadata,materialCreatedAt:"2026-02-30T00:00:00Z"}}),code("INVALID_ARGUMENT"));
  await assert.rejects(f.core.execute("list",{filter:{ownerId:"owner"},sort:"sizeBytes",order:"desc",limit:3,offset:0}),code("PAYLOAD_TOO_LARGE"));
  await assert.rejects(f.core.execute(subjects.get,{artifactId:p.artifact.artifactId}),code("INVALID_ARGUMENT"));
});
test("prepare repeat retains stable bearer and conflicts on changed data",async()=>{
  const f=fixture(),input={requestId:"stable",ownerId:"owner",kind:"original",metadata};
  const one=await f.core.execute("prepare",input),two=await f.core.execute("prepare",{...input,metadata:{...metadata}});
  assert.deepEqual(two,one);assert.equal(validateResponse(subjects.prepare,one),true);
  await assert.rejects(f.core.execute("prepare",{...input,metadata:{...metadata,title:"changed"}}),code("CONFLICT"));assert.equal(f.artifacts.size,1);
});
test("publication failure leaves durable intent; reconciliation finalizes full bytes",async()=>{
  const f=fixture(),p=await f.prepare(),token=p.uploadUrl.split("/").at(-1);
  const publish=f.files.publish;f.files.publish=async(id,publication)=>{await publish(id,publication);throw new Error("lost result");};
  await assert.rejects(f.core.upload(token,(async function*(){yield Buffer.from("recover");})()),code("STORAGE_UNAVAILABLE"));
  assert.equal((await f.core.execute("get",{artifactId:p.artifact.artifactId})).status,"pending");assert.equal(f.bytes.size,1);
  assert.deepEqual(await f.core.reconcile(),{ready:1,failed:0,deleted:0,temps:0});
  const artifact=await f.core.execute("get",{artifactId:p.artifact.artifactId});assert.equal(artifact.status,"ready");assert.equal(artifact.sizeBytes,7);assert.equal(validateResponse(subjects.get,artifact),true);
  await assert.rejects(f.core.upload(token,(async function*(){yield Buffer.from("replace");})()),code("CONFLICT"));
});
test("ENOSPC and producer failure do not make a ready artifact",async()=>{
  const f=fixture(),p=await f.prepare();f.files.write=async()=>{throw Object.assign(new Error("full"),{code:"ENOSPC"});};
  await assert.rejects(f.core.upload(p.uploadUrl.split("/").at(-1),(async function*(){})()),code("STORAGE_UNAVAILABLE"));
  const artifact=await f.core.execute("get",{artifactId:p.artifact.artifactId});assert.equal(artifact.status,"failed");assert.equal(artifact.sizeBytes,null);assert.equal(f.bytes.size,0);
});
test("delete preserves history, relations and references, closes grants at deleting",async()=>{
  const f=fixture(),original=await f.uploaded(),copy=await f.uploaded("copy");
  await f.core.execute("relationAdd",{requestId:"r",modelArtifactId:copy.artifactId,originalArtifactId:original.artifactId});
  const reserve={scope:{ownerId:"owner",projectId:"p",threadId:"t",operationId:"o"},commandHash:"a".repeat(64),clientUserMessageId:"m",attachments:[{originalArtifactId:original.artifactId,modelArtifactId:copy.artifactId}]};
  await f.core.execute("referenceReserve",reserve);
  const grant=await f.core.execute("linkCreate",{requestId:"l",artifactId:original.artifactId});
  f.files.remove=async()=>{throw new Error("unlink unavailable");};
  await assert.rejects(f.core.execute("delete",{requestId:"d",artifactId:original.artifactId}),code("STORAGE_UNAVAILABLE"));
  await assert.rejects(f.core.shared(grant.link.url.split("/").at(-1)),code("NOT_FOUND"));
  const stats=await f.core.execute("stats",{ownerId:"owner"});assert.equal(stats.originalCount,0);assert.equal(stats.copyCount,1);
  f.files.remove=async id=>{f.bytes.delete(id);};await f.core.reconcile();
  const deleted=await f.core.execute("delete",{requestId:"again",artifactId:original.artifactId});assert.equal(deleted.status,"deleted");assert.equal(deleted.sizeBytes,original.sizeBytes);assert.equal(deleted.sha256,original.sha256);assert.equal(validateResponse(subjects.delete,deleted),true);
  assert.equal((await f.core.execute("relationList",{artifactId:original.artifactId})).items.length,1);
  assert.equal((await f.core.execute("referenceReserve",reserve)).created,false);
});
test("reference exact retries, ownership, confirm binding and exact history page",async()=>{
  const f=fixture(),original=await f.uploaded(),model=await f.uploaded("copy"),foreign=await f.uploaded("original","other");
  const scope={ownerId:"owner",projectId:"p",threadId:"t",operationId:"o"},input={scope,clientUserMessageId:"native",commandHash:"b".repeat(64),attachments:[{originalArtifactId:original.artifactId,modelArtifactId:model.artifactId}]};
  assert.equal((await f.core.execute("referenceReserve",input)).created,true);assert.equal((await f.core.execute("referenceReserve",input)).created,false);
  await assert.rejects(f.core.execute("referenceReserve",{...input,commandHash:"c".repeat(64)}),code("CONFLICT"));
  await assert.rejects(f.core.execute("referenceReserve",{...input,scope:{...scope,operationId:"foreign"},attachments:[{originalArtifactId:foreign.artifactId,modelArtifactId:model.artifactId}]}),code("CONFLICT"));
  await f.core.execute("referenceUpdateState",{scope,state:"unknown"});
  const confirm={scope,clientUserMessageId:"native",turnId:"turn",itemId:"item"};await f.core.execute("referenceConfirm",confirm);await f.core.execute("referenceConfirm",confirm);
  await assert.rejects(f.core.execute("referenceConfirm",{...confirm,itemId:"different"}),code("CONFLICT"));await assert.rejects(f.core.execute("referenceUpdateState",{scope,state:"not-sent"}),code("CONFLICT"));
  const query={ownerId:"owner",projectId:"p",threadId:"t"};assert.equal((await f.core.execute("referenceList",{scope:query,nativeItemIds:["item"]})).items.length,1);assert.equal((await f.core.execute("referenceList",{scope:query,nativeItemIds:["other-item"]})).items.length,0);
});
test("sharing requires explicit base, expires and revokes without duplicating request",async()=>{
  const f=fixture(),artifact=await f.uploaded(),input={requestId:"share",artifactId:artifact.artifactId,expiresAt:new Date(Date.now()+5000).toISOString()};
  const one=await f.core.execute("linkCreate",input);assert.deepEqual(await f.core.execute("linkCreate",input),one);const token=one.link.url.split("/").at(-1);assert.equal((await f.core.shared(token)).artifactId,artifact.artifactId);
  f.advance(6000);await assert.rejects(f.core.shared(token),code("NOT_FOUND"));
  const two=await f.core.execute("linkCreate",{requestId:"share2",artifactId:artifact.artifactId});await f.core.execute("linkRevoke",{requestId:"rev",linkId:two.link.linkId});await assert.rejects(f.core.shared(two.link.url.split("/").at(-1)),code("NOT_FOUND"));
  const disabled=createArtifactsCore({store:f.store,files:f.files,config:{...f.config,externalBaseURL:undefined}});await assert.rejects(disabled.execute("linkCreate",{requestId:"disabled",artifactId:artifact.artifactId}),code("SHARING_NOT_CONFIGURED"));
});

test("client cancellation after publication preserves ready completion",async()=>{
  const f=fixture(),p=await f.prepare(),controller=new AbortController(),publish=f.files.publish;
  f.files.publish=async(...args)=>{await publish(...args);controller.abort();};
  const artifact=await f.core.upload(p.uploadUrl.split("/").at(-1),(async function*(){yield Buffer.from("preserved");})(),controller.signal);
  assert.equal(artifact.status,"ready");assert.equal(artifact.sizeBytes,9);assert.equal(f.bytes.size,1);
});

test("Unicode limits count code points, preserve exact values and reject one extra character",async()=>{
  const f=fixture(),requestId="😀".repeat(256),ownerId="😀".repeat(128);
  const input={requestId,ownerId,kind:"original",metadata:{...metadata,title:"😀".repeat(512),filename:"😀".repeat(1024),source:"😀".repeat(128)}};
  const result=await f.core.execute("prepare",input);assert.equal(validateResponse(subjects.prepare,result),true);assert.equal(result.artifact.title,input.metadata.title);assert.equal(result.artifact.ownerId,ownerId);
  for(const [field,max] of [["title",512],["filename",1024],["mimeType",255],["source",128]])await assert.rejects(f.core.execute("prepare",{...input,metadata:{...input.metadata,[field]:"😀".repeat(max+1)}}),code("INVALID_ARGUMENT"));
  await assert.rejects(f.core.execute("prepare",{...input,requestId:requestId+"😀"}),code("INVALID_ARGUMENT"));assert.equal(f.artifacts.size,1);
});

test("sparse large pages and input arrays fit bytes without hidden default count limits",async()=>{
  const f=fixture(),original=await f.uploaded(),model=await f.uploaded("copy");
  const listing=await f.core.execute("list",{filter:{ownerId:"owner"},sort:"createdAt",order:"asc",limit:1001,offset:0});assert.equal(listing.limit,1001);assert.equal(listing.items.length,2);
  const scope={ownerId:"owner",projectId:"p",threadId:"t",operationId:"large"};
  const attachments=Array.from({length:101},()=>({originalArtifactId:original.artifactId,modelArtifactId:model.artifactId}));
  const reserved=await f.core.execute("referenceReserve",{scope,clientUserMessageId:"m",commandHash:"a".repeat(64),attachments});assert.equal(reserved.reference.attachments.length,101);
  const page=await f.core.execute("referenceList",{scope:{ownerId:"owner",projectId:"p",threadId:"t"},nativeItemIds:Array.from({length:1001},(_,n)=>"item-"+n)});assert.deepEqual(page,{items:[]});
});

test("streamed list rejects by serialized UTF8 budget and closes producer promptly",async()=>{
  const f=fixture({maxResultBytes:4096}),artifact=await f.uploaded();let read=0,closed=false;
  f.session.list=async()=>({total:10000,items:(async function*(){try{while(read<10000){read++;yield {...artifact,title:"😀".repeat(100)};}}finally{closed=true;}})()});
  await assert.rejects(f.core.execute("list",{filter:{ownerId:"owner"},sort:"createdAt",order:"asc",limit:10000,offset:0}),code("PAYLOAD_TOO_LARGE"));assert.equal(closed,true);assert.ok(read<10,"stop reading when the byte budget fills");
  f.session.list=async()=>({total:0,items:[]});assert.equal((await f.core.execute("list",{filter:{ownerId:"owner"},sort:"createdAt",order:"asc",limit:10000,offset:0})).total,0);
});

test("relation and reference iterators respect byte budgets and explicit local count limits",async()=>{
  const f=fixture({maxResultBytes:4096,maxRelations:2}),artifact=await f.uploaded();let relationClosed=false,referenceClosed=false;
  const relation={modelArtifactId:artifact.artifactId,originalArtifactId:artifact.artifactId,createdAt:artifact.createdAt};
  f.session.relations=async()=>((async function*(){try{for(let n=0;n<5;n++)yield relation;}finally{relationClosed=true;}})());
  await assert.rejects(f.core.execute("relationList",{artifactId:artifact.artifactId}),code("PAYLOAD_TOO_LARGE"));assert.equal(relationClosed,true);
  f.session.references=async()=>((async function*(){try{for(let n=0;n<1000;n++)yield {details:"😀".repeat(500)};}finally{referenceClosed=true;}})());
  await assert.rejects(f.core.execute("referenceList",{scope:{ownerId:"owner",projectId:"p",threadId:"t"},nativeItemIds:["i"]}),code("PAYLOAD_TOO_LARGE"));assert.equal(referenceClosed,true);
});

test("byte budget includes the final response envelope",async()=>{
  const f=fixture({maxResultBytes:10});
  await assert.rejects(f.core.execute("list",{filter:{ownerId:"owner"},sort:"createdAt",order:"asc",limit:1,offset:0}),code("PAYLOAD_TOO_LARGE"));
});

test("recovery preserves mismatched published bytes and closes invalid durable intent",async()=>{
  const f=fixture(),prepared=await f.prepare(),id=prepared.artifact.artifactId,record=f.artifacts.get(id);
  record.publication={tempName:id,sizeBytes:6,sha256:createHash("sha256").update("wanted").digest("hex")};f.temps.set(id,Buffer.from("wanted"));f.bytes.set(id,Buffer.from("unknown"));
  assert.equal((await f.core.reconcile()).failed,1);assert.equal(f.temps.size,0);assert.deepEqual(f.bytes.get(id),Buffer.from("unknown"));assert.equal((await f.core.execute("get",{artifactId:id})).status,"failed");
});
