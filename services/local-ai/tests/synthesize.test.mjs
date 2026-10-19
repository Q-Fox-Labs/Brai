// ABOUTME: Проверяет закрытый synthesize API, владение lifecycle и публикацию аудио.
// ABOUTME: Использует управляемые runtime и Artifacts без весов, сети и постоянных данных.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { subjects, validateRequest, validateResponse, validateSchema } from '../contracts/index.mjs';
import { supportedProfiles } from '../src/main.mjs';
import { createLifecycleManager, createProfileRuntimeFactory } from '../dist/lifecycle/index.js';
import { createArtifactsAdapter } from '../dist/adapters/artifacts/index.js';
import { createModelInstaller, createHuggingFaceCatalog } from '../dist/install/huggingface.js';

const profile = supportedProfiles({ runtime: { silero_pytorch: {}, gigaam_pytorch: {} } }).find(value => value.profileId === 'silero_pytorch');
const model = { modelId: profile.modelId, revision: profile.revision, profileId: profile.profileId };
const audio = Buffer.from('OggS-fixture');
const artifactId = randomUUID();
const request = (overrides = {}) => ({ requestId: randomUUID(), operationId: randomUUID(), ownerId: 'owner', model, deadlineAt: new Date(Date.now() + 5000).toISOString(), text: 'Привет', voice: 'eugene', ...overrides });
const context = (input, signal = new AbortController().signal) => ({ ownerId: input.ownerId, operationId: input.operationId, deadlineAt: input.deadlineAt, signal });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(5); } assert.fail('condition not reached'); }
function fixture({ synthesize = async () => ({ audio, mimeType: 'audio/ogg' }), publishAudio = async () => ({ artifactId }), holdExit = false, open } = {}) {
  const exit = deferred();
  let closed = false;
  let calls = 0;
  const runtime = { exited: exit.promise, synthesize: async (...args) => { calls++; return synthesize(...args); }, async close() { closed = true; if (!holdExit) exit.resolve(); await exit.promise; } };
  const installation = { ...model, directory: '/models', files: profile.record.files, installedAt: new Date().toISOString() };
  const store = { async transaction(run) { return run({ models: { get: async () => profile.record }, installations: { get: async () => installation }, settings: { get: async () => ({ idleUnloadSeconds: null }) } }); } };
  const facts = [];
  const lifecycle = createLifecycleManager({ store, runtimeFactory: { open: open ?? (async () => runtime) }, artifacts: { publishAudio },
    history: { publish: value => facts.push(value) }, limits: { maxLoadedModels: 2, maxQueuedOperations: 3, maxInputBytes: 10000, maxEmbeddingItems: 1, maxResultBytes: 1000, loadDeadlineMs: 1000 } });
  return { lifecycle, runtime, exit, facts, get closed() { return closed; }, get calls() { return calls; } };
}

test('synthesize schemas accept 900 codepoints and reject blank, NUL, unpaired surrogates, unknown voice and wire data', () => {
  assert.equal(validateSchema('ModelRecord', profile.record), true);
  for (const text of ['Привет', '😀'.repeat(900), 'a'.repeat(900)]) assert.equal(validateRequest(subjects.invokeSynthesize, request({ text })), true);
  for (const text of ['', ' \t\n', '\u0000', '\ud800', '\udc00', '😀'.repeat(901), 'a'.repeat(901)]) assert.equal(validateRequest(subjects.invokeSynthesize, request({ text })), false, JSON.stringify(text));
  for (const extra of [{ voice: 'other' }, { audio: 'bytes' }, { path: '/tmp/a' }, { url: 'https://example.invalid' }]) assert.equal(validateRequest(subjects.invokeSynthesize, request(extra)), false);
  const input = request();
  const response = { requestId: input.requestId, operationId: input.operationId, model, durationMs: 1, audioArtifactId: artifactId };
  assert.equal(validateResponse(subjects.invokeSynthesize, response), true);
  assert.equal(validateResponse(subjects.invokeSynthesize, { ...response, audio: 'bytes' }), false);
});

test('synthesize retains its serial slot through publication and never records speech content', async () => {
  const publication = deferred(); let publishing = false;
  const f = fixture({ publishAudio: async (output, ctx) => { assert.deepEqual(output.audio, audio); assert.equal(ctx.ownerId, 'owner'); publishing = true; await publication.promise; return { artifactId }; } });
  try {
    const first = request(); const pending = f.lifecycle.invoke({ ...first, operation: 'synthesize' }, context(first));
    await until(() => publishing);
    const second = request(); const next = f.lifecycle.invoke({ ...second, operation: 'synthesize' }, context(second));
    await until(() => f.lifecycle.status().queued === 1);
    assert.equal(f.calls, 1);
    publication.resolve();
    const [one, two] = await Promise.all([pending, next]);
    assert.equal(one.audioArtifactId, artifactId); assert.equal(two.audioArtifactId, artifactId);
    assert.equal(JSON.stringify(f.facts).includes('Привет'), false);
  } finally { publication.resolve(); await f.lifecycle.close(); }
});

test('synthesize cancels during publication and holds capacity until runtime physical exit', async () => {
  const publication = deferred(); let publishing = false;
  const f = fixture({ holdExit: true, publishAudio: async (_output, ctx) => { publishing = true; await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true })); await publication.promise; throw new Error('aborted upload'); } });
  const input = request();
  const pending = f.lifecycle.invoke({ ...input, operation: 'synthesize' }, context(input));
  const rejected = assert.rejects(pending, error => error.code === 'CANCELLED');
  await until(() => publishing);
  await f.lifecycle.cancel(input.ownerId, input.operationId);
  await rejected;
  assert.equal(f.closed, true); assert.equal(f.lifecycle.status().active, 1);
  publication.resolve(); await delay(10); assert.equal(f.lifecycle.status().active, 1);
  f.exit.resolve(); await until(() => f.lifecycle.status().active === 0);
  await f.lifecycle.close();
});

test('synthesize deadline stops inference and failed synthesis never publishes', async () => {
  let published = 0;
  const f = fixture({ synthesize: async (_input, ctx) => { await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true })); throw new Error('aborted'); }, publishAudio: async () => { published++; return { artifactId }; } });
  try {
    const input = request({ deadlineAt: new Date(Date.now() + 35).toISOString() });
    await assert.rejects(f.lifecycle.invoke({ ...input, operation: 'synthesize' }, context(input)), error => error.code === 'DEADLINE_EXCEEDED');
    await until(() => f.lifecycle.status().active === 0);
    assert.equal(published, 0); assert.equal(f.closed, true);
  } finally { await f.lifecycle.close(); }
});

test('invalid direct text and invalid published artifact IDs fail closed', async () => {
  const f = fixture({ publishAudio: async () => ({ artifactId: '/private/path' }) });
  try {
    for (const text of [null, 1, '\ud800', ' ']) {
      const input = request({ text });
      await assert.rejects(f.lifecycle.invoke({ ...input, operation: 'synthesize' }, context(input)), error => error.code === 'INVALID_ARGUMENT');
    }
    const input = request();
    await assert.rejects(f.lifecycle.invoke({ ...input, operation: 'synthesize' }, context(input)), error => error.code === 'DEPENDENCY_UNAVAILABLE');
  } finally { await f.lifecycle.close(); }
});

test('Artifacts publishing verifies owner, trusted upload origin and ready bytes; each attempt gets a new key', async () => {
  const originalFetch = globalThis.fetch;
  const hash = createHash('sha256').update(audio).digest('hex');
  let prepareKeys = []; let owner = 'owner'; let uploadUrl = 'http://artifacts.invalid/upload/opaque'; let responseHash = hash; let puts = 0;
  const nats = { async request(subject, bytes) {
    const input = JSON.parse(Buffer.from(bytes));
    if (subject.endsWith('.prepare')) {
      prepareKeys.push(input.requestId); assert.deepEqual(input.metadata, { title: 'Синтез речи', filename: 'speech.ogg', extension: 'ogg', mimeType: 'audio/ogg', source: 'local_ai' });
      return { data: Buffer.from(JSON.stringify({ artifact: { artifactId, ownerId: owner, requestId: input.requestId, status: 'pending', mimeType: 'audio/ogg' }, uploadUrl })) };
    }
    assert.equal(subject, 'brai.artifacts.v1.get');
    return { data: Buffer.from(JSON.stringify({ artifactId, ownerId: owner, status: 'ready', mimeType: 'audio/ogg', sizeBytes: audio.length, sha256: hash })) };
  } };
  globalThis.fetch = async (url, options) => { puts++; assert.equal(url.href, uploadUrl); assert.equal(options.redirect, 'manual'); assert.deepEqual(options.body, audio); return new Response(null, { status: 201, headers: { 'x-artifact-id': artifactId, 'x-artifact-state': 'ready', 'x-artifact-size': String(audio.length), 'x-artifact-sha256': responseHash } }); };
  try {
    const adapter = createArtifactsAdapter({ nats, internalBaseUrl: 'http://artifacts.invalid/', tempRoot: '/tmp', maxAudioBytes: 1, allowedMimeTypes: ['audio/ogg'] });
    const input = request(); const ctx = context(input);
    assert.deepEqual(await adapter.publishAudio({ audio, mimeType: 'audio/ogg' }, ctx), { artifactId });
    assert.deepEqual(await adapter.publishAudio({ audio, mimeType: 'audio/ogg' }, ctx), { artifactId });
    assert.notEqual(prepareKeys[0], prepareKeys[1]);
    owner = 'other'; await assert.rejects(adapter.publishAudio({ audio, mimeType: 'audio/ogg' }, ctx), error => error.code === 'DEPENDENCY_UNAVAILABLE'); assert.equal(puts, 2);
    owner = 'owner'; uploadUrl = 'http://foreign.invalid/upload/opaque'; await assert.rejects(adapter.publishAudio({ audio, mimeType: 'audio/ogg' }, ctx), error => error.code === 'DEPENDENCY_UNAVAILABLE'); assert.equal(puts, 2);
    uploadUrl = 'http://artifacts.invalid/upload/opaque'; responseHash = '0'.repeat(64); await assert.rejects(adapter.publishAudio({ audio, mimeType: 'audio/ogg' }, ctx), error => error.code === 'DEPENDENCY_UNAVAILABLE');
  } finally { globalThis.fetch = originalFetch; }
});

test('Artifacts publishes to the configured upload origin and rejects unsafe URLs before PUT', async () => {
  const originalFetch = globalThis.fetch;
  const hash = createHash('sha256').update(audio).digest('hex');
  const trusted = 'https://upload.invalid/upload/opaque-token';
  let uploadUrl = trusted; let puts = 0; let gets = 0; let responseStatus = 201;
  const nats = { async request(subject, bytes) {
    if (subject.endsWith('.prepare')) {
      const input = JSON.parse(Buffer.from(bytes));
      return { data: Buffer.from(JSON.stringify({ artifact: { artifactId, ownerId: 'owner', requestId: input.requestId, status: 'pending', mimeType: 'audio/ogg' }, uploadUrl })) };
    }
    assert.equal(subject, 'brai.artifacts.v1.get'); gets++;
    return { data: Buffer.from(JSON.stringify({ artifactId, ownerId: 'owner', status: 'ready', mimeType: 'audio/ogg', sizeBytes: audio.length, sha256: hash })) };
  } };
  globalThis.fetch = async (url, options) => {
    puts++;
    assert.equal(url.href, trusted, 'PUT uses the validated returned upload endpoint, not the files endpoint');
    assert.equal(options.method, 'PUT'); assert.equal(options.redirect, 'manual'); assert.deepEqual(options.body, audio);
    return new Response(null, { status: responseStatus, headers: { location: 'https://foreign.invalid/upload/other', 'x-artifact-id': artifactId, 'x-artifact-state': 'ready', 'x-artifact-size': String(audio.length), 'x-artifact-sha256': hash } });
  };
  try {
    const configuration = { nats, internalBaseUrl: 'http://files.invalid:9081/', uploadBaseUrl: 'https://upload.invalid/', tempRoot: '/tmp', maxAudioBytes: 1, allowedMimeTypes: ['audio/ogg'] };
    const adapter = createArtifactsAdapter(configuration);
    const ctx = context(request());
    assert.deepEqual(await adapter.publishAudio({ audio, mimeType: 'audio/ogg' }, ctx), { artifactId });
    assert.equal(puts, 1); assert.equal(gets, 1);
    for (uploadUrl of [
      'https://foreign.invalid/upload/opaque-token', 'http://files.invalid:9081/upload/opaque-token',
      'http://upload.invalid/upload/opaque-token', 'https://upload.invalid:444/upload/opaque-token',
      'https://user:secret@upload.invalid/upload/opaque-token', `${trusted}?secret=value`, `${trusted}#fragment`,
      `${trusted}?`, `${trusted}#`,
      'https://upload.invalid/upload/%6fpaque-token', 'https://upload.invalid/upload/a%2fb',
      'https://upload.invalid/upload/../upload/opaque-token', 'https://upload.invalid/files/opaque-token',
      `${trusted}/extra`, 'https://upload.invalid/upload/', 'https://upload.invalid\\upload\\opaque-token',
    ]) {
      await assert.rejects(adapter.publishAudio({ audio, mimeType: 'audio/ogg' }, ctx), error => error.code === 'DEPENDENCY_UNAVAILABLE');
      assert.equal(puts, 1, 'unsafe URL must not receive audio'); assert.equal(gets, 1);
    }
    uploadUrl = trusted; responseStatus = 307;
    await assert.rejects(adapter.publishAudio({ audio, mimeType: 'audio/ogg' }, ctx), error => error.code === 'DEPENDENCY_UNAVAILABLE');
    assert.equal(puts, 2, 'redirect is not followed'); assert.equal(gets, 1);
    for (const uploadBaseUrl of [null, '', 'invalid', 'ftp://upload.invalid/', 'https://user:secret@upload.invalid/', 'https://upload.invalid/path', 'https://upload.invalid/?q=1', 'https://upload.invalid/#fragment', 'https://upload.invalid/?', 'https://upload.invalid/#']) {
      assert.throws(() => createArtifactsAdapter({ ...configuration, uploadBaseUrl }), error => error.code === 'INVALID_ARGUMENT');
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('installer accepts only the exact pinned Silero source and preserves HTTP redirect rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-silero-install-'));
  const operations = new Map(); let downloadUrl; let redirect;
  const store = { async transaction(run) { return run({ models: { get: async () => profile.record }, installations: { get: async () => null }, installationOperations: { get: async id => operations.get(id) ?? null, put: async value => operations.set(value.operationId, value) } }); } };
  const installer = createModelInstaller({ profiles: [profile], store, rootDirectory: root, fetchImpl: async (url, options) => { downloadUrl = url.href; redirect = options.redirect; return new Response(null, { status: 302 }); } });
  try {
    const input = request();
    await installer.start({ ...model, requestId: input.requestId, ownerId: input.ownerId, deadlineAt: input.deadlineAt });
    await until(() => operations.get(input.requestId)?.status === 'failed');
    assert.equal(downloadUrl, profile.files[0].url); assert.equal(redirect, 'error');
    assert.throws(() => createModelInstaller({ profiles: [{ ...profile, files: [{ ...profile.files[0], url: 'https://attacker.invalid/weights' }] }], store, rootDirectory: root }), error => error.code === 'INVALID_ARGUMENT');
  } finally { await installer.close(); await rm(root, { recursive: true, force: true }); }
});

test('Silero child adapter owns its private directory, validates output path and closes before cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-ai-silero-runtime-'));
  const previous = process.env.TMPDIR; process.env.TMPDIR = root;
  const source = `const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');const dir=process.env.TMPDIR;readline.createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);let result;if(q.method==='health')result={ready:true,model_id:'${model.modelId}',revision:'${model.revision}'};else {fs.writeFileSync(path.join(dir,'audio.ogg'),'OggS-fixture');result={audio_path:q.params.text==='bad'?'/wrong/audio.ogg':path.join(dir,'audio.ogg'),mime_type:'audio/ogg'}}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n')})`;
  const config = { executable: process.execPath, cwd: root, args: ['-e', source.replaceAll('}', '} ')], startupTimeoutMs: 1000, requestTimeoutMs: 180000, stopGraceMs: 300, maxLineBytes: 65536, threads: 4, ffmpegExecutable: '/usr/bin/ffmpeg' };
  const factory = createProfileRuntimeFactory({ profiles: { silero_pytorch: config } });
  let runtime;
  try {
    runtime = await factory.open({ model, installation: { ...model, directory: root, files: profile.record.files, installedAt: new Date().toISOString() } }, context(request()));
    assert.deepEqual(await runtime.synthesize({ model, text: 'ok', voice: 'eugene' }, context(request())), { audio, mimeType: 'audio/ogg' });
    assert.equal((await readdir(root)).length, 1);
    await assert.rejects(runtime.synthesize({ model, text: 'bad', voice: 'eugene' }, context(request())), error => error.code === 'ENGINE_UNAVAILABLE');
    await runtime.close(); await runtime.exited;
    assert.deepEqual(await readdir(root), []);
  } finally {
    if (runtime) await runtime.close();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
