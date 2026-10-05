// ABOUTME: Запускает profile adapters против изолированных локальных HTTP и JSON-RPC child fixtures.
// ABOUTME: Проверяет реальные argv/stdin/stdout/HTTP границы без модельных весов и числовой приёмки.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProfileRuntimeFactory } from '../../dist/lifecycle/index.js';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function context(signal = new AbortController().signal) {
  return { ownerId: 'local_ai', operationId: 'fixture', deadlineAt: new Date(Date.now() + 5000).toISOString(), signal };
}
function common(executable, args) {
  return { executable, cwd: tmpdir(), args, startupTimeoutMs: 3000, requestTimeoutMs: 1500, stopGraceMs: 300, maxLineBytes: 100_000 };
}

 test('llama.cpp adapter starts pinned argv, applies query instruction once, maps ordered finite L2 vectors, and waits for exit', async () => {
  const port = await freePort();
  const root = await mkdtemp(join(tmpdir(), 'local-ai-llama-test-'));
  const source = `const http=require('node:http');const s=http.createServer((q,r)=>{if(q.method==='GET'&&q.url==='/health'){r.writeHead(200);r.end();return}let b='';q.on('data',x=>b+=x);q.on('end',()=>{const body=JSON.parse(b);if(q.url==='/tokenize'){r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify({tokens:body.content==='oversized'?Array(2049).fill(1):[1]}));return}const input=body.input;const data=input.map((text,index)=>({index,embedding:Array.from({length:1024},(_,i)=>i===(text.startsWith('Instruct: Given a query, retrieve relevant passages\\nQuery: ') ? 0 : 1)?1:0)}));r.writeHead(200,{'content-type':'application/json'});r.end(JSON.stringify({data}))})});s.listen(Number(process.argv[1]),'127.0.0.1');`;
  const factory = createProfileRuntimeFactory({ profiles: {
    llama_cpp: { ...common(process.execPath, ['-e', source, '{{port}}']), host: '127.0.0.1', port: () => port, dimensions: 1024, contextTokens: 2048, maxBatchTokens: 2048, queryInstruction: 'Given a query, retrieve relevant passages' },
    gigaam_pytorch: { ...common(process.execPath, ['-e', 'process.exit(2)']), vadModelPath: '/local/vad', vadRevision: 'vad-rev', threads: 1, longformMaximumSeconds: 26, audioDecodeTimeoutSeconds: 15 },
  } });
  const model = { model: { modelId: 'giga-embeddings-480m-q8', revision: 'rev', profileId: 'llama_cpp' }, installation: {
    modelId: 'giga-embeddings-480m-q8', revision: 'rev', profileId: 'llama_cpp', directory: root,
    files: [{ path: 'model.gguf', sizeBytes: 5, sha256: '0'.repeat(64) }], installedAt: new Date().toISOString(),
  } };
  const runtime = await factory.open(model, context());
  try {
    const output = await runtime.embed({ model: model.model, texts: ['needle'], purpose: 'query' }, context());
    assert.equal(output.vectors.length, 1);
    assert.equal(output.vectors[0].length, 1024);
    assert.equal(output.vectors[0][0], 1);
    await assert.rejects(runtime.embed({ model: model.model, texts: ['oversized'], purpose: 'document' }, context()), error => error.code === 'INPUT_TOO_LARGE');
  } finally {
    await runtime.close();
    await runtime.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test('GigaAM adapter uses newline JSON-RPC, matches IDs, and maps segment field names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-gigaam-test-'));
  const source = `const readline=require('node:readline');const r=readline.createInterface({input:process.stdin});r.on('line',l=>{const q=JSON.parse(l);let result=q.method==='health'?{ready:true,model_id:'gigaam-v3-e2e-ctc',revision:'rev-giga',vad_revision:'vad-rev'}:{text:'hello',segments:[{start_seconds:0.25,end_seconds:1.5,text:'hello'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n')});`;
  const factory = createProfileRuntimeFactory({ profiles: {
    llama_cpp: { ...common(process.execPath, ['-e', 'process.exit(2)']), host: '127.0.0.1', port: () => 1, dimensions: 1024, contextTokens: 2048, maxBatchTokens: 2048, queryInstruction: 'unused' },
    gigaam_pytorch: { ...common(process.execPath, ['-e', source]), vadModelPath: '/local/vad', vadRevision: 'vad-rev', threads: 2, longformMaximumSeconds: 40, audioDecodeTimeoutSeconds: 15 },
  } });
  const model = { model: { modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch' }, installation: {
    modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch', directory: root,
    files: [{ path: 'config.json', sizeBytes: 5, sha256: '0'.repeat(64) }], installedAt: new Date().toISOString(),
  } };
  const runtime = await factory.open(model, context());
  try {
    const output = await runtime.transcribe({ model: model.model, audioPath: '/tmp/audio-fixture' }, context());
    assert.deepEqual(output, { text: 'hello', segments: [{ startSeconds: 0.25, endSeconds: 1.5, text: 'hello' }] });
  } finally {
    await runtime.close();
    await runtime.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime close kills surviving descendants and waits for the whole process group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-gigaam-group-test-'));
  const source = `const {spawn}=require('node:child_process');const readline=require('node:readline');const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});const r=readline.createInterface({input:process.stdin});r.on('line',l=>{const q=JSON.parse(l);const result=q.method==='health'?{ready:true,model_id:'gigaam-v3-e2e-ctc',revision:'rev-giga',vad_revision:'vad-rev'}:{text:String(child.pid)};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n')});`;
  const factory = createProfileRuntimeFactory({ profiles: {
    llama_cpp: { ...common(process.execPath, ['-e', 'process.exit(2)']), host: '127.0.0.1', port: () => 1, dimensions: 1024, contextTokens: 2048, maxBatchTokens: 2048, queryInstruction: 'unused' },
    gigaam_pytorch: { ...common(process.execPath, ['-e', source]), stopGraceMs: 40, vadModelPath: '/local/vad', vadRevision: 'vad-rev', threads: 1, longformMaximumSeconds: 40, audioDecodeTimeoutSeconds: 15 },
  } });
  const model = { model: { modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch' }, installation: {
    modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch', directory: root,
    files: [{ path: 'config.json', sizeBytes: 5, sha256: '0'.repeat(64) }], installedAt: new Date().toISOString(),
  } };
  const runtime = await factory.open(model, context());
  const result = await runtime.transcribe({ model: model.model, audioPath: '/tmp/audio-fixture' }, context());
  const descendantPid = Number(result.text);
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  await runtime.close();
  await runtime.exited;
  assert.throws(() => process.kill(descendantPid, 0), error => error.code === 'ESRCH');
  await rm(root, { recursive: true, force: true });
});

test('exited eventually confirms real process-group cleanup after bounded close rejects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-gigaam-late-exit-test-'));
  const source = `const {spawn}=require('node:child_process');const readline=require('node:readline');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});const r=readline.createInterface({input:process.stdin});r.on('line',l=>{const q=JSON.parse(l);const result=q.method==='health'?{ready:true,model_id:'gigaam-v3-e2e-ctc',revision:'rev-giga',vad_revision:'vad-rev'}:{text:String(child.pid)};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n')});`;
  const factory = createProfileRuntimeFactory({ profiles: {
    llama_cpp: { ...common(process.execPath, ['-e', 'process.exit(2)']), host: '127.0.0.1', port: () => 1, dimensions: 1024, contextTokens: 2048, maxBatchTokens: 2048, queryInstruction: 'unused' },
    gigaam_pytorch: { ...common(process.execPath, ['-e', source]), stopGraceMs: 0, vadModelPath: '/local/vad', vadRevision: 'vad-rev', threads: 1, longformMaximumSeconds: 40, audioDecodeTimeoutSeconds: 15 },
  } });
  const model = { model: { modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch' }, installation: {
    modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch', directory: root,
    files: [{ path: 'config.json', sizeBytes: 5, sha256: '0'.repeat(64) }], installedAt: new Date().toISOString(),
  } };
  const runtime = await factory.open(model, context());
  const result = await runtime.transcribe({ model: model.model, audioPath: '/tmp/audio-fixture' }, context());
  const descendantPid = Number(result.text);
  let exited = false;
  void runtime.exited.then(() => { exited = true; });
  await assert.rejects(runtime.close(), error => error.code === 'ENGINE_UNAVAILABLE');
  assert.equal(exited, false, 'a bounded close failure must not claim resource release');
  await Promise.race([
    runtime.exited,
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('process group did not exit')), 2000); timer.unref(); }),
  ]);
  assert.equal(exited, true);
  assert.throws(() => process.kill(descendantPid, 0), error => error.code === 'ESRCH');
  await rm(root, { recursive: true, force: true });
});
