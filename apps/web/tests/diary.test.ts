// ABOUTME: Проверяет сохранность, повторы и изоляцию Дневника на границах ядра и HTTP.
// ABOUTME: Все тексты и файлы синтетические; настоящие данные пользователя не читаются.
import assert from "node:assert/strict";
import { randomUUID,createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import type { Artifact } from "../../../services/artifacts/contracts/index.mjs";
import type { DiaryPorts } from "../server/diary-core";
const require=createRequire(import.meta.url);
function load(file:string,modules:Record<string,unknown>){
 const source=readFileSync(new URL(file,import.meta.url),"utf8");
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};new Function("require","module","exports",output)((id:string)=>id in modules?modules[id]:require(id),module,module.exports);return module.exports;
}
const core=load("../server/diary-core.ts",{}) as typeof import("../server/diary-core");
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function fixture(){
 const records=new Map<string,Artifact>(),contents=new Map<string,Uint8Array>(),keys=new Map<string,string>();
 let failAfterPut=false;
 const ports:DiaryPorts={
  async call<T>(operation:"prepare"|"get"|"list",input:unknown):Promise<T>{
   const x=input as {ownerId:string;requestId:string;artifactId:string;kind:Artifact["kind"];metadata:Pick<Artifact,"title"|"filename"|"extension"|"mimeType"|"source"|"details">;filter:{ownerId:string;source:string;status:string};offset:number;limit:number};
   if(operation==="prepare"){
    const key=x.ownerId+":"+x.requestId,previous=keys.get(key);
    if(previous){const record=records.get(previous)!;const fields=["title","filename","extension","mimeType","source","details"] as const;if(fields.some(k=>JSON.stringify(record[k as keyof Artifact])!==JSON.stringify(x.metadata[k])))throw new core.DiaryError(409,"CONFLICT");return {artifact:{...record},uploadUrl:"https://upload.test/upload/"+record.artifactId} as T;}
    const id=randomUUID(),record={artifactId:id,ownerId:x.ownerId,requestId:x.requestId,kind:x.kind,status:"pending",...x.metadata,sizeBytes:null,sha256:null,createdAt:"2026-11-04T12:00:00.000Z",updatedAt:"2026-11-04T12:00:00.000Z"} as Artifact;
    records.set(id,record);keys.set(key,id);return {artifact:{...record},uploadUrl:"https://upload.test/upload/"+id} as T;
   }
   if(operation==="get"){const item=records.get(x.artifactId);if(!item)throw new core.DiaryError(404,"NOT_FOUND");return {...item} as T;}
   const values=[...records.values()].filter(item=>item.ownerId===x.filter.ownerId&&item.source===x.filter.source&&item.status===x.filter.status);
   return {items:values.slice(x.offset,x.offset+x.limit),total:values.length,limit:x.limit,offset:x.offset,sort:"createdAt",order:"desc"} as T;
  },
  async put(prepared,bytes){
   const item=records.get(prepared.artifact.artifactId)!;contents.set(item.artifactId,Buffer.from(bytes));Object.assign(item,{status:"ready",sha256:hash(bytes),sizeBytes:bytes.length,internalUrl:"http://files.test/files/"+item.artifactId});
   if(failAfterPut){failAfterPut=false;throw new Error("connection lost after commit");}
  },
  async read(item){return contents.get(item.artifactId)!;},
 };
 return {ports,records,contents,diary:core.createDiary(ports),failNextReply(){failAfterPut=true;}};
}
const input=()=>({requestId:randomUUID(),title:"Синтетическая запись",date:null,text:"  Исходный текст.\n\nБез сокращения.\n "});
test("unknown create outcome retries the same original and preserves exact text across new core instance",async()=>{
 const f=fixture(),body=input();f.failNextReply();
 await assert.rejects(f.diary.create("a",body),/connection lost/);
 const saved=await core.createDiary(f.ports).create("a",body);
 assert.equal(f.records.size,1);
 const read=await f.diary.get("a",saved.id);
 assert.equal(read.text,body.text);assert.equal(read.date,null);
 await assert.rejects(f.diary.create("a",{...body,text:"Другой текст"}),e=>e instanceof core.DiaryError&&e.status===409);
 assert.equal((await f.diary.get("a",saved.id)).text,body.text);
});
test("entry and attached files cannot cross owners or entries",async()=>{
 const f=fixture(),a=await f.diary.create("a",input()),b=await f.diary.create("a",input());
 await assert.rejects(f.diary.get("b",a.id),e=>e instanceof core.DiaryError&&e.status===404);
 const prepared=await f.diary.prepareMaterial("a",a.id,{requestId:randomUUID(),filename:"original.bin",mimeType:"application/octet-stream",role:"original"});
 const bytes=Buffer.from([0,255,3,11,0]);await f.ports.put(prepared,bytes);
 assert.equal((await f.diary.get("a",a.id)).materials.length,1);
 await assert.rejects(f.diary.material("b",a.id,prepared.artifact.artifactId));
 await assert.rejects(f.diary.material("a",b.id,prepared.artifact.artifactId),e=>e instanceof core.DiaryError&&e.status===404);
 assert.deepEqual(f.contents.get(prepared.artifact.artifactId),bytes);
});
test("completed files remain visible after a different upload fails; independent transcript versions survive",async()=>{
 const f=fixture(),entry=await f.diary.create("a",input());
 for(const role of ["original","transcript","correction"]){
  const p=await f.diary.prepareMaterial("a",entry.id,{requestId:randomUUID(),filename:role+".txt",mimeType:"text/plain",role});
  await f.ports.put(p,Buffer.from(role));
 }
 await f.diary.prepareMaterial("a",entry.id,{requestId:randomUUID(),filename:"unfinished.wav",mimeType:"audio/wav",role:"original"});
 const read=await core.createDiary(f.ports).get("a",entry.id);
 assert.deepEqual(read.materials.map(x=>x.role),["original","transcript","correction"]);assert.equal(read.materialsTotal,3);
});
test("metadata validation rejects impossible dates, ownership injection and oversized text before storage",async()=>{
 const f=fixture();
 for(const body of [{...input(),ownerId:"other"},{...input(),date:"2026-02-30"},{...input(),date:"9999-99-99"},{...input(),text:"x".repeat(8*1024*1024+1)},{...input(),text:"\u0000"}])await assert.rejects(f.diary.create("a",body),e=>e instanceof core.DiaryError&&e.status===400);
 assert.equal(f.records.size,0);
});
test("manifest checksum failure is visible instead of serving changed text",async()=>{
 const f=fixture(),entry=await f.diary.create("a",input());f.contents.set(entry.id,Buffer.from("corrupt"));
 await assert.rejects(f.diary.get("a",entry.id),e=>e instanceof core.DiaryError&&e.code==="INTEGRITY");
});
test("pagination exposes all entries and materials without silent truncation",async()=>{
 const f=fixture();
 for(let i=0;i<53;i++)await f.diary.create("a",input());
 const first=await f.diary.list("a"),next=await f.diary.list("a",50);assert.equal(first.entries.length,50);assert.equal(first.total,53);assert.equal(next.entries.length,3);
});
test("HTTP denies bad Origin or stale account before contacting storage and restricts file query",async()=>{
 class GatewayError extends Error{status:number;code:string;constructor(status:number,code:string){super(code);this.status=status;this.code=code;}}
 class RequestBodyFailure extends Error{status=400;code="INVALID_ARGUMENT";}
 let calls=0,origin=true;
 const http=load("../server/diary-http.ts",{
  "./auth":{requireSession:async()=>({user:{id:"a"}}),checkOrigin:()=>{if(!origin)throw new GatewayError(403,"ORIGIN");}},
  "./gateway":{GatewayError,natsConnection:async()=>{calls++;throw new Error("storage must not be called");}},
  "./request-body":{RequestBodyFailure,readBoundedJson:async(request:Request)=>request.json()},
  "./diary-core":core,
 }) as typeof import("../server/diary-http");
 const headers={"x-brai-user":"other","origin":"https://example.test","content-type":"application/json"};
 assert.equal((await http.diaryCollection(new Request("https://example.test/api/diary",{headers}))).status,401);
 origin=false;headers["x-brai-user"]="a";
 assert.equal((await http.diaryCollection(new Request("https://example.test/api/diary",{method:"POST",headers,body:JSON.stringify(input())}))).status,403);
 assert.equal((await http.diaryFile(new Request("https://example.test/api/diary/file?entry="+randomUUID()+"&material="+randomUUID()+"&account=b"))).status,401);
 assert.equal((await http.diaryRead(new Request("https://example.test/api/diary/entry?id="+randomUUID()+"&id="+randomUUID(),{headers}))).status,400);
 assert.equal(calls,0);
});

test("real HTTP boundary uses canonical upload origin, checks streamed originals and permits exact ready retries",async()=>{
 const f=fixture(),originalFetch=globalThis.fetch,previous={read:process.env.DIARY_ARTIFACTS_INTERNAL_ORIGIN,upload:process.env.DIARY_ARTIFACTS_UPLOAD_BASE_URL};
 process.env.DIARY_ARTIFACTS_INTERNAL_ORIGIN="http://files.test";process.env.DIARY_ARTIFACTS_UPLOAD_BASE_URL="https://upload.test";
 class GatewayError extends Error{status=503;code="UNAVAILABLE";}
 class RequestBodyFailure extends Error{status=400;code="INVALID_ARGUMENT";}
 const http=load("../server/diary-http.ts",{
  "./auth":{requireSession:async()=>({user:{id:"a"}}),checkOrigin:()=>{}},
  "./gateway":{GatewayError,natsConnection:async()=>({async request(subject:string,bytes:Uint8Array){const value=await f.ports.call(subject.split(".").at(-1) as "prepare"|"get"|"list",JSON.parse(Buffer.from(bytes).toString()));return {data:Buffer.from(JSON.stringify(value))};}})},
  "./request-body":{RequestBodyFailure,readBoundedJson:async(request:Request)=>request.json()},"./diary-core":core,
 }) as typeof import("../server/diary-http");
 let putCount=0;
 globalThis.fetch=async(value,options)=>{
  const url=new URL(String(value));
  if(options?.method==="PUT"){
   assert.equal(url.origin,"https://upload.test","read-only file server must never receive PUT");
   const id=url.pathname.split("/").at(-1)!;putCount++;
   const bytes=Buffer.from(await new Response(options.body).arrayBuffer());
   await f.ports.put({artifact:f.records.get(id)!,uploadUrl:url.href},bytes);
   return new Response(null,{status:201});
  }
  assert.equal(url.origin,"http://files.test");
  return new Response(Buffer.from(f.contents.get(url.pathname.split("/").at(-1)!)!));
 };
 const headers={"x-brai-user":"a","content-type":"application/json"};
 try{
  const response=await http.diaryCollection(new Request("http://web.test/api/diary",{method:"POST",headers,body:JSON.stringify(input())}));
  assert.equal(response.status,201);const entry=(await response.json()).entry;
  const prepared=await http.diaryPrepare(new Request("http://web.test/api/diary/materials?entry="+entry.id,{method:"POST",headers,body:JSON.stringify({requestId:randomUUID(),filename:"original.bin",mimeType:"application/octet-stream",role:"original"})}));
  assert.equal(prepared.status,200);const material=(await prepared.json()).material;
  const bytes=Buffer.from([0,255,4,7,0]),url="http://web.test/api/diary/upload?entry="+entry.id+"&material="+material.id;
  const upload=(data:Uint8Array)=>http.diaryUpload(new Request(url,{method:"PUT",headers:{"x-brai-user":"a","x-content-size":String(data.length)},body:Buffer.from(data)}));
  assert.equal((await upload(bytes)).status,201);
  assert.equal((await upload(bytes)).status,201);
  assert.equal((await upload(Buffer.from("other"))).status,409);
  assert.equal(putCount,2,"entry manifest plus one immutable file PUT");
  assert.deepEqual(f.contents.get(material.id),bytes);
  const read=await http.diaryRead(new Request("http://web.test/api/diary/entry?id="+entry.id,{headers}));
  assert.equal(read.status,200);assert.equal((await read.json()).entry.materials.length,1);
 }finally{
  globalThis.fetch=originalFetch;
  for(const[key,value]of [["DIARY_ARTIFACTS_INTERNAL_ORIGIN",previous.read],["DIARY_ARTIFACTS_UPLOAD_BASE_URL",previous.upload]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}
 }
});
