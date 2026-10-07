// ABOUTME: Запускает profile adapters против изолированных локальных HTTP и JSON-RPC child fixtures.
// ABOUTME: Проверяет реальные argv/stdin/stdout/HTTP границы без модельных весов и числовой приёмки.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLifecycleManager, createProfileRuntimeFactory } from '../../dist/lifecycle/index.js';

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
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
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
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await rm(root, { recursive: true, force: true });
  }
});

test('native diagnostics preserve a safe runner stage and exclude sentinel payload and stderr', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-diagnostics-'));
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const sentinel = 'PRIVATE_SENTINEL_AUDIO_TEXT_VECTOR_SECRET';
  const source = `const readline=require('node:readline');process.stderr.write('${sentinel}');const r=readline.createInterface({input:process.stdin});r.on('line',l=>{const q=JSON.parse(l);const reply=q.method==='health'?{result:{ready:true,model_id:'gigaam-v3-e2e-ctc',revision:'rev-giga',vad_revision:'vad-rev'}}:{error:{code:-32001,message:'${sentinel}',data:{diagnostic:{stage:'audio_decode',errorClass:'${sentinel}',frames:[{component:'${sentinel}',line:1}],text:'${sentinel}'}}}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,...reply})+'\\n')});`;
  const factory = createProfileRuntimeFactory({ profiles: {
    llama_cpp: { ...common(process.execPath, ['-e', 'process.exit(2)']), host: '127.0.0.1', port: () => 1, dimensions: 1024, contextTokens: 2048, maxBatchTokens: 2048, queryInstruction: 'unused' },
    gigaam_pytorch: { ...common(process.execPath, ['-e', source.replaceAll('}', '} ')]), vadModelPath: '/local/vad', vadRevision: 'vad-rev', threads: 1, longformMaximumSeconds: 40, audioDecodeTimeoutSeconds: 15 },
  } });
  const model = { model: { modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch' }, installation: {
    modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch', directory: root,
    files: [{ path: 'config.json', sizeBytes: 5, sha256: '0'.repeat(64) }], installedAt: new Date().toISOString(),
  } };
  const output = [];
  const write = process.stderr.write;
  process.stderr.write = value => { output.push(String(value)); return true; };
  let runtime;
  try {
    runtime = await factory.open(model, context());
    await assert.rejects(runtime.transcribe({ model: model.model, audioPath: sentinel }, context()), error => error.code === 'INVALID_ARGUMENT' && !error.message.includes(sentinel));
    await runtime.close(); await runtime.exited;
    assert.equal(output.join('').includes(sentinel), false);
    const rows = output.flatMap(line => line.trim().split('\n').filter(Boolean).map(value => JSON.parse(value)));
    assert.ok(rows.some(row => row.operation === 'transcribe' && row.stage === 'audio_decode' && row.code === 'INVALID_ARGUMENT' && Number.isInteger(row.durationMs) && row.durationMs >= 0));
    assert.ok(rows.some(row => row.stage === 'group_exit' && row.code === 'EXIT_CONFIRMED'));
    assert.ok(rows.every(row => Object.keys(row).every(key => ['operation', 'stage', 'executor', 'code', 'durationMs', 'exitCode', 'signal'].includes(key))));
  } finally {
    process.stderr.write = write;
    if (runtime) await runtime.close();
    if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
    await rm(root, { recursive: true, force: true });
  }
});

test('GigaAM retains its private TMPDIR through a surviving child and removes it before close completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-giga-private-tmp-'));
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const source = `const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');const readline=require('node:readline');const tmp=process.env.TMPDIR;if(!tmp)process.exit(5);fs.writeFileSync(path.join(tmp,'fixture-env-check'),JSON.stringify([process.env.TMPDIR,process.env.TMP,process.env.TEMP]));fs.writeFileSync(path.join(tmp,'fixture-marker'),'active');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.send('ready')"],{stdio:['ignore','ignore','ignore','ipc']});const childReady=new Promise(resolve=>child.once('message',resolve));const r=readline.createInterface({input:process.stdin});r.on('line',l=>{const q=JSON.parse(l);const result=q.method==='health'?{ready:true,model_id:'gigaam-v3-e2e-ctc',revision:'rev-giga',vad_revision:'vad-rev'}:{text:q.params.audio_path==='report'?String(child.pid):'parent-exit'};const reply=()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');if(q.method==='health')childReady.then(reply);else reply();if(q.params?.audio_path==='exit-parent')setImmediate(()=>process.exit(0))});`;
  const factory = createProfileRuntimeFactory({ profiles: {
    llama_cpp: { ...common(process.execPath, ['-e', 'process.exit(2)']), host: '127.0.0.1', port: () => 1, dimensions: 1024, contextTokens: 2048, maxBatchTokens: 2048, queryInstruction: 'unused' },
    gigaam_pytorch: { ...common(process.execPath, ['-e', source]), stopGraceMs: 250, env: { TMPDIR: '/unused/profile-tmp', TMP: '/unused/profile-tmp', TEMP: '/unused/profile-tmp' }, vadModelPath: '/local/vad', vadRevision: 'vad-rev', threads: 1, longformMaximumSeconds: 40, audioDecodeTimeoutSeconds: 15 },
  } });
  const model = { model: { modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch' }, installation: {
    modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch', directory: root,
    files: [{ path: 'config.json', sizeBytes: 5, sha256: '0'.repeat(64) }], installedAt: new Date().toISOString(),
  } };
  try {
    const runtime = await factory.open(model, context());
    const result = await runtime.transcribe({ model: model.model, audioPath: 'report' }, context());
    const descendantPid = Number(result.text);
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    const [privateName] = await readdir(root);
    assert.match(privateName, /^brai-local-ai-giga-/);
    const privatePath = join(root, privateName);
    assert.equal((await stat(privatePath)).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await readFile(join(privatePath, 'fixture-env-check'), 'utf8')), [privatePath, privatePath, privatePath]);
    assert.equal(await readFile(join(privatePath, 'fixture-marker'), 'utf8'), 'active');
    assert.doesNotThrow(() => process.kill(descendantPid, 0));

    let exited = false;
    void runtime.exited.then(() => { exited = true; });
    const closing = runtime.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(exited, false, 'scratch remains owned while the descendant process group is alive');
    assert.equal(await readFile(join(privatePath, 'fixture-marker'), 'utf8'), 'active');

    await closing;
    assert.equal(exited, true, 'runtime close confirms physical group exit and separately completes scratch cleanup');
    assert.deepEqual(await readdir(root), []);
    assert.throws(() => process.kill(descendantPid, 0), error => error.code === 'ESRCH');
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await rm(root, { recursive: true, force: true });
  }
});

test('GigaAM cleanup runs after an unexpected confirmed exit and a spawn failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-giga-start-failure-'));
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const makeFactory = (executable, args) => createProfileRuntimeFactory({ profiles: {
    llama_cpp: { ...common(process.execPath, ['-e', 'process.exit(2)']), host: '127.0.0.1', port: () => 1, dimensions: 1024, contextTokens: 2048, maxBatchTokens: 2048, queryInstruction: 'unused' },
    gigaam_pytorch: { ...common(executable, args), startupTimeoutMs: 1000, env: { TMPDIR: '/unused', TMP: '/unused', TEMP: '/unused' }, vadModelPath: '/local/vad', vadRevision: 'vad-rev', threads: 1, longformMaximumSeconds: 40, audioDecodeTimeoutSeconds: 15 },
  } });
  const model = { model: { modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch' }, installation: {
    modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch', directory: root,
    files: [{ path: 'config.json', sizeBytes: 5, sha256: '0'.repeat(64) }], installedAt: new Date().toISOString(),
  } };
  const exitAfterTranscribeSource = `const readline=require('node:readline');const r=readline.createInterface({input:process.stdin});r.on('line',l=>{const q=JSON.parse(l);const result=q.method==='health'?{ready:true,model_id:'gigaam-v3-e2e-ctc',revision:'rev-giga',vad_revision:'vad-rev'}:{text:'complete'};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');if(q.method==='transcribe')setImmediate(()=>process.exit(0))});`;
  try {
    const unexpected = await makeFactory(process.execPath, ['-e', exitAfterTranscribeSource]).open(model, context());
    await unexpected.transcribe({ model: model.model, audioPath: 'fixture' }, context());
    await unexpected.exited;
    await unexpected.close();
    assert.deepEqual(await readdir(root), [], 'unexpected confirmed child exit cleans only its private generation directory');

    const missingExecutable = join(root, 'missing-runtime');
    await assert.rejects(makeFactory(missingExecutable, []).open(model, context()), error => error.code === 'MODEL_LOAD_FAILED');
    assert.deepEqual(await readdir(root), [], 'a failed spawn does not leave an allocated private generation directory');
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await rm(root, { recursive: true, force: true });
  }
});

test('GigaAM confirms physical exit independently of bounded cleanup and never removes a replacement directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-giga-temp-identity-'));
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const source = `const fs=require('node:fs');const path=require('node:path');const readline=require('node:readline');fs.writeFileSync(path.join(process.env.TMPDIR,'fixture-marker'),'active');const r=readline.createInterface({input:process.stdin});r.on('line',l=>{const q=JSON.parse(l);const result=q.method==='health'?{ready:true,model_id:'gigaam-v3-e2e-ctc',revision:'rev-giga',vad_revision:'vad-rev'}:{text:'ready'};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n')});`;
  const factory = createProfileRuntimeFactory({ profiles: {
    llama_cpp: { ...common(process.execPath, ['-e', 'process.exit(2)']), host: '127.0.0.1', port: () => 1, dimensions: 1024, contextTokens: 2048, maxBatchTokens: 2048, queryInstruction: 'unused' },
    gigaam_pytorch: { ...common(process.execPath, ['-e', source]), stopGraceMs: 100, env: { TMPDIR: '/unused', TMP: '/unused', TEMP: '/unused' }, vadModelPath: '/local/vad', vadRevision: 'vad-rev', threads: 1, longformMaximumSeconds: 40, audioDecodeTimeoutSeconds: 15 },
  } });
  const model = { model: { modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch' }, installation: {
    modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch', directory: root,
    files: [{ path: 'config.json', sizeBytes: 5, sha256: '0'.repeat(64) }], installedAt: new Date().toISOString(),
  } };
  try {
    const runtime = await factory.open(model, context());
    const [name] = await readdir(root);
    const originalPath = join(root, name);
    const displacedPath = join(root, 'displaced-generation');
    const replacementPath = join(root, 'replacement-generation');
    await rename(originalPath, displacedPath);
    await mkdir(originalPath, { mode: 0o700 });
    await writeFile(join(originalPath, 'foreign-marker'), 'keep');

    await assert.rejects(runtime.close(), error => error.code === 'DEPENDENCY_UNAVAILABLE' && error.message === 'TMPDIR_CLEANUP_UNCONFIRMED');
    let exited = false;
    void runtime.exited.then(() => { exited = true; });
    await runtime.exited;
    assert.equal(exited, true, 'cleanup failure must not turn physical exit into an infinite wait');
    assert.equal(await readFile(join(originalPath, 'foreign-marker'), 'utf8'), 'keep');

    await rename(originalPath, replacementPath);
    await rename(displacedPath, originalPath);
    await runtime.exited;
    assert.equal(exited, true);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual((await readdir(root)).sort(), [name, 'replacement-generation'].sort(), 'cleanup is bounded and never retries silently');
    assert.equal(await readFile(join(replacementPath, 'foreign-marker'), 'utf8'), 'keep');
    await rm(replacementPath, { recursive: true, force: true });
  } finally {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime close kills surviving descendants and waits for the whole process group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-gigaam-group-test-'));
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
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
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await rm(root, { recursive: true, force: true });
});

test('exited eventually confirms real process-group cleanup after bounded close rejects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-gigaam-late-exit-test-'));
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
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
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  await rm(root, { recursive: true, force: true });
});

test('llama startup cancellation retains loading allocation until a failed bounded stop reaches physical exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-llama-startup-exit-'));
  const marker = join(root, 'pid');
  const selector = { modelId: 'giga-embeddings-480m-q8', revision: 'rev', profileId: 'llama_cpp' };
  const source = `require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
  const factory = createProfileRuntimeFactory({ fetch: async () => new Response('', { status: 503 }), profiles: {
    llama_cpp: { ...common(process.execPath, ['-e', source, marker]), stopGraceMs: 20, host: '127.0.0.1', port: () => 1, dimensions: 1024, contextTokens: 2048, maxBatchTokens: 2048, queryInstruction: 'unused' },
    gigaam_pytorch: { ...common(process.execPath, ['-e', 'process.exit(2)']), vadModelPath: '/local/vad', vadRevision: 'vad-rev', threads: 1, longformMaximumSeconds: 40, audioDecodeTimeoutSeconds: 15 },
  } });
  const installation = { ...selector, directory: root, files: [{ path: 'model.gguf', sizeBytes: 5, sha256: '0'.repeat(64) }], installedAt: new Date().toISOString() };
  const store = { async transaction(run) { return run({
    models: { get: async () => ({ ...selector, supported: true }) },
    installations: { get: async () => installation },
    settings: { get: async () => ({ idleUnloadSeconds: null }) },
  }); } };
  const lifecycle = createLifecycleManager({ store, runtimeFactory: factory, artifacts: {}, limits: {
    maxLoadedModels: 1, maxQueuedOperations: 2, maxInputBytes: 10000, maxEmbeddingItems: 2, maxResultBytes: 10000, loadDeadlineMs: 3000,
  } });
  const originalKill = process.kill;
  const controller = new AbortController();
  let pid;
  let suppressedStops = 0;
  let closing;
  const waitFor = async check => {
    const until = Date.now() + 2000;
    while (!await check()) {
      assert.ok(Date.now() < until, 'native startup fixture did not reach the expected ownership boundary');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    const load = lifecycle.load(selector, context(controller.signal));
    const rejected = assert.rejects(load, error => error.code === 'CANCELLED');
    await waitFor(async () => { try { pid = Number(await readFile(marker, 'utf8')); return Number.isSafeInteger(pid); } catch { return false; } });
    // AIDEV-NOTE: Блокируем только stop этого реального child, чтобы воспроизвести неподтверждённый выход.
    process.kill = (target, signal) => {
      if (target === -pid && ['SIGTERM', 'SIGKILL'].includes(signal)) { suppressedStops++; return true; }
      return originalKill(target, signal);
    };
    controller.abort();
    await rejected;
    await waitFor(() => suppressedStops >= 2);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.doesNotThrow(() => originalKill(pid, 0));
    assert.equal(lifecycle.status().loading, 1, 'failed stop cannot release the loading allocation');
    await assert.rejects(lifecycle.acquireModelIdleLock(selector.modelId), error => error.code === 'MODEL_IN_USE');
    let closed = false;
    closing = lifecycle.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closed, false, 'service shutdown waits for the still-owned native generation');
    process.kill = originalKill;
    originalKill(-pid, 'SIGKILL');
    await closing;
    assert.equal(lifecycle.status().loading, 0);
    assert.throws(() => originalKill(pid, 0), error => error.code === 'ESRCH');
  } finally {
    process.kill = originalKill;
    if (pid) { try { originalKill(-pid, 'SIGKILL'); } catch {} }
    await (closing ?? lifecycle.close());
    await rm(root, { recursive: true, force: true });
  }
});

test('nonresponding native health is bounded by startup and retains allocation until physical exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-health-startup-'));
  const marker = join(root, 'health-pid');
  const ready = join(root, 'ready');
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const selector = { modelId: 'gigaam-v3-e2e-ctc', revision: 'rev-giga', profileId: 'gigaam_pytorch' };
  const source = `const fs=require('node:fs');const readline=require('node:readline');process.on('SIGTERM',()=>{});readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.method==='health'){fs.writeFileSync(process.argv[1],String(process.pid));if(fs.existsSync(process.argv[2]))process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result:{ready:true,model_id:'gigaam-v3-e2e-ctc',revision:'rev-giga',vad_revision:'vad-rev'}})+'\\n')}});`;
  const factory = createProfileRuntimeFactory({ profiles: {
    llama_cpp: { ...common(process.execPath, ['-e', 'process.exit(2)']), host: '127.0.0.1', port: () => 1, dimensions: 1024, contextTokens: 2048, maxBatchTokens: 2048, queryInstruction: 'unused' },
    gigaam_pytorch: { ...common(process.execPath, ['-e', source.replaceAll('}', '} '), marker, ready]), startupTimeoutMs: 700, requestTimeoutMs: 5000, stopGraceMs: 20, vadModelPath: '/local/vad', vadRevision: 'vad-rev', threads: 1, longformMaximumSeconds: 40, audioDecodeTimeoutSeconds: 15 },
  } });
  const installation = { ...selector, directory: root, files: [{ path: 'config.json', sizeBytes: 5, sha256: '0'.repeat(64) }], installedAt: new Date().toISOString() };
  const store = { async transaction(run) { return run({
    models: { get: async () => ({ ...selector, supported: true }) },
    installations: { get: async () => installation },
    settings: { get: async () => ({ idleUnloadSeconds: null }) },
  }); } };
  const lifecycle = createLifecycleManager({ store, runtimeFactory: factory, artifacts: {}, limits: {
    maxLoadedModels: 1, maxQueuedOperations: 2, maxInputBytes: 10000, maxEmbeddingItems: 2, maxResultBytes: 10000, loadDeadlineMs: 5000,
  } });
  const originalKill = process.kill;
  let pid;
  let suppressedStops = 0;
  let settled = false;
  let rejected;
  const waitFor = async check => {
    const until = Date.now() + 2000;
    while (!await check()) {
      assert.ok(Date.now() < until, 'startup bound must stop a real pending health RPC before its request deadline');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    rejected = assert.rejects(lifecycle.load(selector, context()).finally(() => { settled = true; }), error => error.code === 'MODEL_LOAD_FAILED');
    await waitFor(async () => { try { pid = Number(await readFile(marker, 'utf8')); return Number.isSafeInteger(pid) && pid > 1; } catch { return false; } });
    // AIDEV-NOTE: Блокируем только сигналы fixture, чтобы startup failure не подменял physical exit proof.
    process.kill = (target, signal) => {
      if (target === -pid && ['SIGTERM', 'SIGKILL'].includes(signal)) { suppressedStops++; return true; }
      return originalKill(target, signal);
    };
    await waitFor(() => suppressedStops >= 2);
    assert.equal(settled, false);
    assert.equal(lifecycle.status().loading, 1);
    assert.doesNotThrow(() => originalKill(-pid, 0));
    assert.ok((await readdir(root)).some(name => name.startsWith('brai-local-ai-giga-')));
    await assert.rejects(lifecycle.acquireModelIdleLock(selector.modelId), error => error.code === 'MODEL_IN_USE');
    process.kill = originalKill;
    originalKill(-pid, 'SIGKILL');
    await rejected;
    assert.equal(lifecycle.status().loading, 0);
    assert.throws(() => originalKill(-pid, 0), error => error.code === 'ESRCH');
    assert.equal((await readdir(root)).some(name => name.startsWith('brai-local-ai-giga-')), false);
    await writeFile(ready, 'ready');
    await lifecycle.load(selector, context());
    await lifecycle.unload(selector, context());
    assert.equal(lifecycle.status().loaded, 0);
  } finally {
    process.kill = originalKill;
    if (pid) { try { originalKill(-pid, 'SIGKILL'); } catch {} }
    await lifecycle.close();
    if (rejected) await rejected;
    if (originalTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmpdir;
    await rm(root, { recursive: true, force: true });
  }
});
