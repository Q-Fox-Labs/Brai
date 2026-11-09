// ABOUTME: Проверяет полную сборку административной записи памяти из ограниченных частей.
// ABOUTME: Использует синтетические записи и не запускает реальные службы.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
const path = new URL("../app/admin/memory-detail.ts", import.meta.url), require = createRequire(path);
const compiled = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const mod = { exports: {} as { loadMemoryDetail: (userId: string, memoryId: string, fetchChunk: (cursor?: string) => Promise<unknown>) => Promise<Record<string, unknown>> } };
new Function("require", "module", "exports", compiled)(require, mod, mod.exports);

function parts() {
 const record = { id:"m", profileId:"p", memory:"Я".repeat(700000), metadata:{source:"fixture"} };
 const bytes = Buffer.from(JSON.stringify(record)), hash = createHash("sha256").update(bytes).digest("hex");
 const id = "9b8d327b-8c3e-47ca-89e1-fd8126757bd1", list = [];
 for (let offset=0; offset<bytes.length; offset+=450000) {
  const end=Math.min(offset+450000,bytes.length);
  list.push({userId:"u",memoryId:"m",snapshotId:id,offset,totalBytes:bytes.length,sha256:hash,
   chunkBase64:bytes.subarray(offset,end).toString("base64"),nextCursor:end<bytes.length ? "cursor-"+end : null});
 }
 return { record, list };
}

test("complete record is returned only after all chunks and hash verification", async () => {
 const {record,list}=parts(); let count=0;
 const actual=await mod.exports.loadMemoryDetail("u","m",async cursor => {
  assert.equal(cursor,count ? list[count-1].nextCursor : undefined);
  return list[count++];
 });
 assert.deepEqual(actual,record); assert.equal(count,list.length);
});

test("wrong target, offset, snapshot, cursor and checksum never return partial content", async () => {
 for (const change of [
  (p: ReturnType<typeof parts>["list"]) => {p[1].userId="v";},
  (p: ReturnType<typeof parts>["list"]) => {p[1].offset++;},
  (p: ReturnType<typeof parts>["list"]) => {p[1].snapshotId="8b8d327b-8c3e-47ca-89e1-fd8126757bd1";},
  (p: ReturnType<typeof parts>["list"]) => {p[1].nextCursor=p[0].nextCursor;},
  (p: ReturnType<typeof parts>["list"]) => {p.forEach(item=>item.sha256="0".repeat(64));},
 ]) {
  const {list}=parts(); change(list);let count=0;
  await assert.rejects(mod.exports.loadMemoryDetail("u","m",async()=>list[count++]));
 }
});

test("revocation or invalid JSON stops assembly without exposing a partial record", async () => {
 const {list}=parts(); let count=0;
 await assert.rejects(mod.exports.loadMemoryDetail("u","m",async()=>{if(count++)throw new Error("FORBIDDEN");return list[0];}),/FORBIDDEN/);
 const single={...list[0],totalBytes:1,chunkBase64:Buffer.from("{").toString("base64"),sha256:createHash("sha256").update("{").digest("hex"),nextCursor:null};
 await assert.rejects(mod.exports.loadMemoryDetail("u","m",async()=>single));
});

test("full chain assembles real Unix HTTP through NATS-sized Control replies", async () => {
 const { createServer } = await import("node:http");
 const { mkdtempSync, rmSync } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const { Control, createMemoryReader } = await import("../../../services/hermes/identity/control.mjs");
 const root=mkdtempSync(join(tmpdir(),"web-memory-chain-")), socket=join(root,"memory.sock");
 const original={id:"m",profileId:"p",memory:"Я".repeat(700000),metadata:{source:"fixture"}};
 const server=createServer((_req,res)=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(original));});
 await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(socket,resolve);});
 try {
  let audits=0;
  const c=new Control({origin:"https://example.test",cursorKey:"x".repeat(32),
   registry:async()=>({version:1,profiles:{"1001":{userId:"u",profileId:"p",memoryEpoch:"e",status:"active"}}}),
   authCall:async(name:string)=>name==="session"?{status:200,body:{user:{id:"actor",role:"admin",status:"active"},session:{}}}:(audits++,{status:200}),
   memoryRead:createMemoryReader(socket), chatRead:undefined, artifactsCall:undefined, telegramSend:undefined, telegramInfo:undefined,
   toolCatalog:undefined, perUserRuntime:undefined, historyCall:undefined,
   quarantineProfile:undefined, quarantineArtifactsOwnerId:undefined});
  const result=await mod.exports.loadMemoryDetail("u","m",async cursor=>{
   const response=await c.invoke("admin-memory-get",{headers:{cookie:"session=one",origin:"https://example.test"},userId:"u",memoryId:"m",...(cursor?{cursor}:{})});
   assert.equal(response.status,200);
   const wire=JSON.stringify(response);assert.ok(Buffer.byteLength(wire)<900000);
   return JSON.parse(wire).body;
  });
  assert.deepEqual(result,original);assert.ok(audits>=4);
 } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
});
