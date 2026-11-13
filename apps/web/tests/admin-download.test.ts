// ABOUTME: Проверяет потоковое скачивание административного файла.
// ABOUTME: Использует синтетический источник и не обращается к реальному Artifacts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
const path = new URL("../server/admin-download.ts", import.meta.url), require = createRequire(path);
const output = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
class GatewayError extends Error { constructor(_status: number, code: string) { super(code); } }
const mod = { exports: {} as { adminDownload: (value: unknown, id: string, signal: AbortSignal, preview?: boolean, range?: string | null) => Promise<Response> } };
new Function("require", "module", "exports", output)((name: string) => name === "./gateway" ? { GatewayError } : require(name), mod, mod.exports);
const id = "11111111-1111-4111-8111-111111111111";
test("64 MiB download streams bounded chunks with exact target and digest", async () => {
 const previousFetch = globalThis.fetch, previousBase = process.env.WEB_ADMIN_ARTIFACTS_BASE_URL;
 const chunk = Buffer.alloc(1024 * 1024, 42), hash = createHash("sha256"); for (let i = 0; i < 64; i++) hash.update(chunk);
 const descriptor = { artifactId: id, filename: "../тест.txt", mimeType: "text/html", sizeBytes: 64 * chunk.length, sha256: hash.digest("hex") };
 let pulled = 0;
 try {
  process.env.WEB_ADMIN_ARTIFACTS_BASE_URL = "http://artifacts.test";
  globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => { assert.equal(String(url), `http://artifacts.test/files/${id}`); assert.equal(options?.redirect, "error"); assert.deepEqual(options?.headers, { "Accept-Encoding": "identity" }); return new Response(new ReadableStream({ pull(controller) { if (pulled++ < 64) controller.enqueue(chunk); else controller.close(); } })); }) as typeof fetch;
  const response = await mod.exports.adminDownload(descriptor, id, new AbortController().signal);
  assert.match(response.headers.get("content-disposition")!, /^attachment;/); assert.equal(response.headers.get("content-type"), "application/octet-stream");
  let received = 0; const reader = response.body!.getReader(); for (;;) { const part = await reader.read(); if (part.done) break; received += part.value.byteLength; }
  assert.equal(received, descriptor.sizeBytes); assert.equal(pulled, 65);
  await assert.rejects(mod.exports.adminDownload({ ...descriptor, artifactId: "other" }, id, new AbortController().signal));
  const maximum = await mod.exports.adminDownload({ ...descriptor, sizeBytes: 2 * 1024 ** 3 }, id, new AbortController().signal);
  await maximum.body!.cancel();
  await assert.rejects(mod.exports.adminDownload({ ...descriptor, sizeBytes: 2 * 1024 ** 3 + 1 }, id, new AbortController().signal));
 } finally { globalThis.fetch = previousFetch; if (previousBase === undefined) delete process.env.WEB_ADMIN_ARTIFACTS_BASE_URL; else process.env.WEB_ADMIN_ARTIFACTS_BASE_URL = previousBase; }
});
test("digest failures break the stream and cancellation reaches the source", async () => {
 const previousFetch = globalThis.fetch, previousBase = process.env.WEB_ADMIN_ARTIFACTS_BASE_URL;
 const descriptor = { artifactId: id, filename: "test.txt", mimeType: "text/plain", sizeBytes: 3, sha256: "0".repeat(64) };
 try {
  process.env.WEB_ADMIN_ARTIFACTS_BASE_URL = "http://artifacts.test";
  globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
  const bad = await mod.exports.adminDownload(descriptor, id, new AbortController().signal);
  await assert.rejects(bad.arrayBuffer());
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }))) as typeof fetch;
  const response = await mod.exports.adminDownload(descriptor, id, new AbortController().signal);
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
  assert.equal(cancelled, true);
 } finally { globalThis.fetch = previousFetch; if (previousBase === undefined) delete process.env.WEB_ADMIN_ARTIFACTS_BASE_URL; else process.env.WEB_ADMIN_ARTIFACTS_BASE_URL = previousBase; }
});

test("preview permits only passive media MIME and keeps active documents as downloads", async () => {
 const previousFetch = globalThis.fetch, previousBase = process.env.WEB_ADMIN_ARTIFACTS_BASE_URL;
 const bytes = new Uint8Array([1, 2, 3]), sha256 = createHash("sha256").update(bytes).digest("hex");
 try {
  process.env.WEB_ADMIN_ARTIFACTS_BASE_URL = "http://artifacts.test";
  globalThis.fetch = (async () => new Response(bytes)) as typeof fetch;
  for (const [mimeType, inline] of [["image/png", true], ["audio/mpeg", true], ["text/html", false], ["image/svg+xml", false]] as const) {
   const response = await mod.exports.adminDownload({artifactId:id,filename:"test",mimeType,sizeBytes:3,sha256}, id, new AbortController().signal, true);
   assert.equal(response.headers.get("content-type"), inline ? mimeType : "application/octet-stream");
   assert.match(response.headers.get("content-disposition")!, inline ? /^inline;/ : /^attachment;/);
   assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
 } finally { globalThis.fetch = previousFetch; if (previousBase === undefined) delete process.env.WEB_ADMIN_ARTIFACTS_BASE_URL; else process.env.WEB_ADMIN_ARTIFACTS_BASE_URL = previousBase; }
});

test("media byte ranges allow seeking, retain exact bytes and verify the whole source", async () => {
 const previousFetch=globalThis.fetch, previousBase=process.env.WEB_ADMIN_ARTIFACTS_BASE_URL;
 const bytes=Buffer.from("0123456789"), descriptor={artifactId:id,filename:"clip.mp4",mimeType:"video/mp4",sizeBytes:10,sha256:createHash("sha256").update(bytes).digest("hex")};
 let reads=0;
 try {
  process.env.WEB_ADMIN_ARTIFACTS_BASE_URL="http://artifacts.test";
  globalThis.fetch=(async()=>{reads++;return new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,3));c.enqueue(bytes.subarray(3,7));c.enqueue(bytes.subarray(7));c.close();}}));}) as typeof fetch;
  for(const [range,content,header] of [["bytes=2-5","2345","bytes 2-5/10"],["bytes=7-","789","bytes 7-9/10"],["bytes=-3","789","bytes 7-9/10"],["bytes=8-99","89","bytes 8-9/10"]]) {
   const response=await mod.exports.adminDownload(descriptor,id,new AbortController().signal,true,range);
   assert.equal(response.status,206);assert.equal(response.headers.get("content-range"),header);
   assert.equal(response.headers.get("content-length"),String(content.length));assert.equal(await response.text(),content);
  }
  for(const range of ["bytes=10-","bytes=6-2","bytes=-0","bytes=0-1,4-5","bytes=999999999999999999999-"]) {
   const before=reads,response=await mod.exports.adminDownload(descriptor,id,new AbortController().signal,true,range);
   assert.equal(response.status,416);assert.equal(response.headers.get("content-range"),"bytes */10");assert.equal(reads,before);
  }
  const download=await mod.exports.adminDownload(descriptor,id,new AbortController().signal,false,"bytes=2-5");
  assert.equal(download.status,200);assert.equal(await download.text(),"0123456789");
  const bad=await mod.exports.adminDownload({...descriptor,sha256:"0".repeat(64)},id,new AbortController().signal,true,"bytes=2-5");
  await assert.rejects(bad.text(),/ARTIFACT_INTEGRITY/);
 } finally {globalThis.fetch=previousFetch;if(previousBase===undefined)delete process.env.WEB_ADMIN_ARTIFACTS_BASE_URL;else process.env.WEB_ADMIN_ARTIFACTS_BASE_URL=previousBase;}
});
