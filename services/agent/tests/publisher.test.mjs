// ABOUTME: Проверяет публикацию файлов, повторы, восстановление и пределы потоков publisher.
// ABOUTME: Использует временные каталоги и публичный fake artifacts API без БД и брокера.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, symlink, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPublisher, streamPublisherFile, publisherMaxBytes } from '../dist/publisher.js';
import { createPublisherPort, createPublisherMcpServer, validatePublisherConfig, publisherTools } from '../dist/publisher-mcp.js';
import { publisherFetch } from '../dist/publisher-http.js';
import { subjects, validateRequest, validateResponse } from '../../artifacts/contracts/index.mjs';
import { transcribeFile } from '../../hermes/transcribe.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]);
async function fixture(t) {
  const tempRoot = join(process.cwd(), 'tmp'); await mkdir(tempRoot, { recursive: true });
  const dir = await mkdtemp(join(tempRoot, 'publisher-')), input = join(dir, 'input'), output = join(dir, 'output'); await mkdir(input);
  const config = { ownerId: 'trusted-owner', resultRoot: output, allowedReadRoots: [input], artifacts: { baseUrl: 'http://artifacts.test', nats: { servers: ['nats://localhost:4222'] }, timeoutMs: 10000 } };
  const records = new Map(), prepared = new Map(), bytesById = new Map(), calls = []; let lostAck = false, corruptGet = false;
  const port = {
    async request(subject, value, signal) {
      signal.throwIfAborted(); calls.push({ subject, value }); assert.ok(validateRequest(subject, value));
      let result;
      if (subject === subjects.prepare) {
        const prior = prepared.get(value.requestId);
        if (prior) { if (prior.input !== JSON.stringify(value)) throw Object.assign(new Error('conflict'), { code: 'OPERATION_CONFLICT' }); result = { artifact: structuredClone(records.get(prior.id)), uploadUrl: (config.artifacts.uploadBaseUrl ?? config.artifacts.baseUrl) + '/upload/' + prior.id }; }
        else { const id = randomUUID(), now = new Date().toISOString(), artifact = { artifactId: id, ownerId: value.ownerId, requestId: value.requestId, kind: value.kind, status: 'pending', ...value.metadata, sizeBytes: null, sha256: null, createdAt: now, updatedAt: now }; records.set(id, artifact); prepared.set(value.requestId, { id, input: JSON.stringify(value) }); result = { artifact: structuredClone(artifact), uploadUrl: (config.artifacts.uploadBaseUrl ?? config.artifacts.baseUrl) + '/upload/' + id }; }
      } else if (subject === subjects.get) { const artifact = records.get(value.artifactId); if (!artifact) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' }); result = structuredClone(artifact); }
      else throw new Error('Unexpected metadata operation');
      assert.ok(validateResponse(subject, result)); return result;
    },
    async fetch(url, options) {
      const path = new URL(url).pathname, id = path.split('/').at(-1); calls.push({ http: options.method ?? 'GET', id });
      if (options.method === 'PUT') {
        const chunks = []; for await (const chunk of options.body) { options.signal.throwIfAborted(); chunks.push(Buffer.from(chunk)); }
        const bytes = Buffer.concat(chunks), artifact = records.get(id); bytesById.set(id, bytes);
        Object.assign(artifact, { status: 'ready', sizeBytes: bytes.length, sha256: sha(bytes), internalUrl: config.artifacts.baseUrl + '/files/' + id });
        if (lostAck) { lostAck = false; throw new Error('ACK lost after ready'); }
        return new Response(null, { status: 201, headers: { 'x-artifact-id': id, 'x-artifact-state': 'ready', 'x-artifact-size': String(bytes.length), 'x-artifact-sha256': sha(bytes), location: artifact.internalUrl } });
      }
      const bytes = corruptGet ? Buffer.from('bad bytes') : bytesById.get(id); return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    },
  };
  const publishers = [], publisher = await createPublisher(config, port, 'trusted-owner'); publishers.push(publisher);
  t.after(async () => { for (const publisher of publishers) await publisher.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, input, output, config, publisher, port, records, prepared, calls, bytesById, loseAck() { lostAck = true; }, corrupt() { corruptGet = true; }, async restart() { const publisher = await createPublisher(config, port, 'trusted-owner'); publishers.push(publisher); return publisher; } };
}

test('publishes verified immutable bytes; repeat and restart keep one artifact; changed bytes conflict', async t => {
  const f = await fixture(t), path = join(f.input, 'picture with spaces.png'); await writeFile(path, png);
  const result = await f.publisher.publishFile({ path, requestId: 'stable-key' });
  assert.equal(result.sha256, sha(png)); assert.equal(result.sizeBytes, png.length); assert.equal(result.mimeType, 'image/png'); assert.equal(result.markdown, `![picture with spaces.png](<${result.localPath}>)`); assert.deepEqual(await readFile(result.localPath), png);
  assert.deepEqual(await f.publisher.publishFile({ path, requestId: 'stable-key' }), result);
  assert.deepEqual(await (await f.restart()).publishFile({ path, requestId: 'stable-key' }), result);
  assert.equal(f.calls.filter(call => call.http === 'PUT').length, 1);
  await writeFile(path, 'changed'); await assert.rejects(f.publisher.publishFile({ path, requestId: 'stable-key' }), error => error.code === 'OPERATION_CONFLICT');
  const next = await f.publisher.publishFile({ path, requestId: 'new-key' }); assert.notEqual(next.artifactId, result.artifactId); assert.deepEqual(await readFile(result.localPath), png);
  assert.deepEqual((await readdir(f.output)).filter(name => name.startsWith('.pending-')), []);
});

test('audio signatures publish ready hashes and OGG reaches the real STT admission boundary', async t => {
  const f = await fixture(t);
  const ogg = packet => {
    const page = Buffer.alloc(28); page.write('OggS'); page[5] = 2; page[26] = 1; page[27] = packet.length;
    return Buffer.concat([page, packet]);
  };
  const cases = [
    ['opus.bin', ogg(Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)])), 'audio/ogg', true],
    ['vorbis.ogg', ogg(Buffer.from([1, 118, 111, 114, 98, 105, 115])), 'audio/ogg'],
    ['voice.bin', Buffer.from('RIFF0000WAVEfmt '), 'audio/wav'],
    ['lossless.bin', Buffer.from('fLaC0000'), 'audio/flac'],
    ['false.ogg', Buffer.from('not an OGG stream'), 'application/octet-stream', false],
    ['other.ogg', ogg(Buffer.from('not-audio')), 'application/octet-stream'],
    ['false.wav', Buffer.from('RIFF0000AVI '), 'application/octet-stream'],
  ];
  for (const [filename, bytes, mimeType, reachesSubmit] of cases) {
    const path = join(f.input, filename); await writeFile(path, bytes);
    const published = await f.publisher.publishFile({ path, requestId: filename });
    assert.equal(published.mimeType, mimeType); assert.equal(published.sha256, sha(bytes)); assert.equal(published.sizeBytes, bytes.length);
    assert.equal(f.records.get(published.artifactId).status, 'ready'); assert.ok(!published.markdown.startsWith('!'));
    if (reachesSubmit !== undefined) {
      let publications = 0, submissions = 0;
      const runtime = { async call(name) {
        if (name === 'publish_file') { publications++; return published; }
        assert.equal(name, 'transcription_request_submit'); submissions++;
        throw Object.assign(new Error('PROBE_SUBMIT_REACHED'), { code: 'PROBE_SUBMIT_REACHED' });
      } };
      const model = { modelId: 'gigaam-v3-e2e-ctc', revision: 'cec030b4c4f35d928e4a9044a3bdb29ebd499fac', profileId: 'gigaam_pytorch' };
      await assert.rejects(transcribeFile({ stt: { model } }, runtime, { input: path, output: join(f.input, filename + '.txt') }),
        error => error.code === (reachesSubmit ? 'PROBE_SUBMIT_REACHED' : 'INVALID_UPSTREAM_RESPONSE'));
      assert.equal(publications, 1); assert.equal(submissions, Number(reachesSubmit));
    }
  }
  assert.equal(f.calls.filter(call => call.http === 'PUT').length, cases.length);
});

test('lost PUT acknowledgement reads persisted ready before any byte retry', async t => {
  const f = await fixture(t), path = join(f.input, 'result.txt'); await writeFile(path, 'confirmed remotely'); f.loseAck();
  const result = await f.publisher.publishFile({ path, requestId: 'lost-ack' }); assert.equal(result.sha256, sha(Buffer.from('confirmed remotely'))); assert.ok(!result.markdown.startsWith('!'));
  const putIndex = f.calls.findIndex(call => call.http === 'PUT'); assert.equal(f.calls[putIndex - 1].subject, subjects.get); assert.equal(f.calls[putIndex + 1].subject, subjects.get);
  await (await f.restart()).publishFile({ path, requestId: 'lost-ack' }); assert.equal(f.calls.filter(call => call.http === 'PUT').length, 1);
});

test('empty files are valid and an already present changed local copy is not overwritten', async t => {
  const f = await fixture(t), path = join(f.input, 'empty.txt'); await writeFile(path, '');
  const result = await f.publisher.publishFile({ path, requestId: 'empty' }); assert.equal(result.sizeBytes, 0); assert.equal(result.sha256, sha(Buffer.alloc(0))); assert.equal((await f.publisher.fetchFile({ artifactId: result.artifactId })).sizeBytes, 0);
  await unlink(result.localPath); await writeFile(result.localPath, 'changed local bytes');
  await assert.rejects(f.publisher.publishFile({ path, requestId: 'empty' }), error => error.code === 'LOCAL_CONTENT_CONFLICT');
  await assert.rejects(f.publisher.fetchFile({ artifactId: result.artifactId }), error => error.code === 'HASH_MISMATCH'); assert.equal((await readFile(result.localPath)).toString(), 'changed local bytes');
});

test('fetch restores ready owned bytes, verifies hash and refuses foreign owner or unsafe URLs', async t => {
  const f = await fixture(t), path = join(f.input, 'result.txt'); await writeFile(path, 'restore me');
  const result = await f.publisher.publishFile({ path, requestId: 'fetch' }); await unlink(result.localPath);
  assert.deepEqual(await f.publisher.fetchFile({ artifactId: result.artifactId }), result);
  await unlink(result.localPath); f.corrupt(); await assert.rejects(f.publisher.fetchFile({ artifactId: result.artifactId }), error => error.code === 'HASH_MISMATCH');
  assert.deepEqual((await readdir(f.output)).filter(name => name.startsWith('.pending-')), []);
  const artifact = f.records.get(result.artifactId); artifact.internalUrl = 'http://foreign.test/files/' + result.artifactId;
  await assert.rejects(f.publisher.fetchFile({ artifactId: result.artifactId }), error => error.code === 'INVALID_ARTIFACT_URL'); artifact.ownerId = 'foreign';
  await assert.rejects(f.publisher.fetchFile({ artifactId: result.artifactId }), error => error.code === 'FORBIDDEN');
});

test('symlink outside read roots, oversized sparse file and destination symlinks are denied', async t => {
  const f = await fixture(t), outside = join(f.dir, 'private.txt'); await writeFile(outside, 'private'); await symlink(outside, join(f.input, 'escape.txt'));
  await assert.rejects(f.publisher.publishFile({ path: join(f.input, 'escape.txt'), requestId: 'escape' }), error => error.code === 'READ_ROOT_DENIED');
  const huge = join(f.input, 'huge.bin'), handle = await open(huge, 'w'); await handle.truncate(publisherMaxBytes + 1); await handle.close();
  await assert.rejects(f.publisher.publishFile({ path: huge, requestId: 'huge' }), error => error.code === 'FILE_TOO_LARGE'); assert.equal(f.records.size, 0);
  const path = join(f.input, 'ok.txt'); await writeFile(path, 'safe'); const result = await f.publisher.publishFile({ path, requestId: 'ok' }); await rm(join(f.output, result.artifactId), { recursive: true }); await symlink(f.input, join(f.output, result.artifactId));
  await assert.rejects(f.publisher.fetchFile({ artifactId: result.artifactId }), error => error.code === 'UNSAFE_RESULT_PATH');
});

test('HTML/SVG and forged image extension stay file links; MP4 signature becomes image syntax', async t => {
  const f = await fixture(t);
  for (const [filename, bytes, media] of [['active.svg', Buffer.from('<svg/>'), false], ['active.html', Buffer.from('<script/>'), false], ['forged.png', Buffer.from('not png'), false], ['clip.mp4', Buffer.from([0, 0, 0, 20, ...Buffer.from('ftypisom'), 0, 0, 0, 0]), true]]) {
    const path = join(f.input, filename); await writeFile(path, bytes); const result = await f.publisher.publishFile({ path, requestId: filename }); assert.equal(result.markdown.startsWith('!'), media);
  }
});

test('concurrency is two; cancellation cleans temporary snapshots and close aborts pending calls', async t => {
  const f = await fixture(t), path = join(f.input, 'cancel.txt'); await writeFile(path, 'cancel me');
  let entered = 0, resolveEntered; const bothEntered = new Promise(resolve => { resolveEntered = resolve; });
  const port = { ...f.port, request: async (_subject, _value, signal) => new Promise((_resolve, reject) => { if (++entered === 2) resolveEntered(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) };
  const publisher = await createPublisher(f.config, port, f.config.ownerId), controller = new AbortController(); t.after(() => publisher.close());
  const first = publisher.publishFile({ path, requestId: 'first' }, controller.signal); first.catch(() => {});
  const second = publisher.publishFile({ path, requestId: 'second' }); second.catch(() => {}); await bothEntered;
  await assert.rejects(publisher.publishFile({ path, requestId: 'third' }), error => error.code === 'OVERLOADED'); controller.abort(); await assert.rejects(first); await publisher.close(); await assert.rejects(second);
  assert.deepEqual((await readdir(f.output)).filter(name => name.startsWith('.pending-')), []);
});

test('stream accepts exact 2 GiB with bounded reusable chunks and rejects one extra byte', async t => {
  const chunk = Buffer.alloc(65536), controller = new AbortController();
  const start = process.memoryUsage(); let maxRss = start.rss, maxExternal = start.external;
  const sample = () => { const memory = process.memoryUsage(); maxRss = Math.max(maxRss, memory.rss); maxExternal = Math.max(maxExternal, memory.external); };
  async function* exact(extra) { for (let n = 0; n < publisherMaxBytes / chunk.length; n++) { if (n % 256 === 0) sample(); yield chunk; } if (extra) yield Buffer.alloc(1); }
  const result = await streamPublisherFile(exact(false), controller.signal); assert.equal(result.sizeBytes, 2147483648); assert.equal(result.prefix.length, 512); assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(streamPublisherFile(exact(true), controller.signal), error => error.code === 'FILE_TOO_LARGE');
  sample(); assert.ok(maxRss - start.rss < 128 * 1024 ** 2); assert.ok(maxExternal - start.external < 128 * 1024 ** 2); t.diagnostic(`2 GiB stream max RSS ${maxRss}, delta ${maxRss - start.rss}; external delta ${maxExternal - start.external}`);
});

test('trusted upload origin differs from internal origin; result filenames and roots match parser', async t => {
  const f = await fixture(t); f.config.artifacts.uploadBaseUrl = 'https://upload.test';
  const path = join(f.input, 'origin.txt'); await writeFile(path, 'separate origins');
  const publisher = await createPublisher(f.config, f.port, f.config.ownerId); t.after(() => publisher.close());
  assert.equal((await publisher.publishFile({ path, requestId: 'origins' })).mimeType, 'text/plain');
  for (const filename of ['question?.txt', 'hash#.txt', 'percent%20.txt']) { const path = join(f.input, filename); await writeFile(path, 'name'); await assert.rejects(publisher.publishFile({ path, requestId: filename }), error => error.code === 'INVALID_FILENAME'); }
  await symlink(f.output, join(f.dir, 'output-alias'));
  await assert.rejects(createPublisher({ ...f.config, resultRoot: join(f.dir, 'output-alias') }, f.port, f.config.ownerId), error => error.code === 'INVALID_PUBLISHER_CONFIG');
  assert.throws(() => validatePublisherConfig({ ...f.config, resultRoot: f.output + '#fragment' }, f.config.ownerId), error => error.code === 'INVALID_PUBLISHER_CONFIG');
});

test('configuration requires canonical trusted owner and tools never accept model-supplied owner', async t => {
  const f = await fixture(t); assert.deepEqual(validatePublisherConfig(f.config, 'trusted-owner'), f.config);
  for (const owner of [undefined, 'foreign']) assert.throws(() => validatePublisherConfig(f.config, owner), error => error.code === 'INVALID_PUBLISHER_CONFIG');
  for (const config of [{ ...f.config, ownerId: 'two owners' }, { ...f.config, uploadTimeoutMs: 1800001 }, { ...f.config, artifacts: { ...f.config.artifacts, timeoutMs: 10001 } }]) assert.throws(() => validatePublisherConfig(config, config.ownerId), error => error.code === 'INVALID_PUBLISHER_CONFIG');
  for (const tool of publisherTools) { assert.equal(tool.inputSchema.additionalProperties, false); assert.ok(!Object.hasOwn(tool.inputSchema.properties, 'ownerId')); }
  await assert.rejects(f.publisher.fetchFile({ artifactId: randomUUID(), ownerId: 'foreign' }), error => error.code === 'INVALID_ARGUMENT');
});

test('NATS adapter validates errors, contract payloads, invalid responses and cancellation', async () => {
  const request = { artifactId: randomUUID() }, controller = new AbortController();
  const errorHeaders = new Map([['Nats-Service-Error', 'CONFLICT'], ['Nats-Service-Error-Code', '409']]);
  await assert.rejects(createPublisherPort({ request: async () => ({ headers: errorHeaders, data: Buffer.alloc(0) }) }).request(subjects.get, request, controller.signal), error => error.code === 'OPERATION_CONFLICT');
  await assert.rejects(createPublisherPort({ request: async () => ({ data: Buffer.from('{}') }) }).request(subjects.get, request, controller.signal), error => error.code === 'INVALID_ARTIFACT_RESPONSE');
  const port = createPublisherPort({ request: async () => new Promise(() => {}) }); const pending = port.request(subjects.get, request, controller.signal); controller.abort(); await assert.rejects(pending);
});

test('real HTTP streams PUT/GET and lost ready ACK without resending bytes', async t => {
  const f = await fixture(t); let uploads = 0;
  const server = createServer(async (request, response) => {
    const id = request.url.split('/').at(-1);
    if (request.method === 'PUT') {
      uploads++; const chunks = []; for await (const chunk of request) chunks.push(chunk); const bytes = Buffer.concat(chunks), artifact = f.records.get(id);
      f.bytesById.set(id, bytes); Object.assign(artifact, { status: 'ready', sizeBytes: bytes.length, sha256: sha(bytes), internalUrl: f.config.artifacts.baseUrl + '/files/' + id });
      request.socket.destroy();
    } else { response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(f.bytesById.get(id)); }
  });
  try { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  catch (error) { server.close(); if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Sandbox blocks local HTTP listen'); return; } throw error; }
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  f.config.artifacts.baseUrl = `http://127.0.0.1:${server.address().port}`;
  const publisher = await createPublisher(f.config, { ...f.port, fetch: publisherFetch }, f.config.ownerId); t.after(() => publisher.close());
  const path = join(f.input, 'network.png'); await writeFile(path, png); const result = await publisher.publishFile({ path, requestId: 'http' }); assert.equal(uploads, 1);
  await unlink(result.localPath); assert.deepEqual(await publisher.fetchFile({ artifactId: result.artifactId }), result); await publisher.publishFile({ path, requestId: 'http' }); assert.equal(uploads, 1);
});

test('actual MCP SDK lists only fixed-owner tools and returns validated file output and safe errors', async t => {
  const f = await fixture(t), server = createPublisherMcpServer(f.publisher), client = new Client({ name: 'publisher-test', version: '1.0.0' }), [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport); t.after(async () => { await client.close(); await server.close(); });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['publish_file', 'fetch_file']);
  const path = join(f.input, 'mcp.png'); await writeFile(path, png);
  const published = await client.callTool({ name: 'publish_file', arguments: { path, requestId: 'mcp' } }); assert.equal(published.structuredContent.sha256, sha(png)); assert.equal(published.isError, undefined);
  const fetched = await client.callTool({ name: 'fetch_file', arguments: { artifactId: published.structuredContent.artifactId } }); assert.deepEqual(fetched.structuredContent, published.structuredContent);
  const invalid = await client.callTool({ name: 'fetch_file', arguments: { artifactId: randomUUID(), ownerId: 'foreign' } }); assert.equal(invalid.isError, true); assert.equal(invalid.content[0].text, 'INVALID_ARGUMENT');
});

test('native HTTP waits for upload completion headers and caller abort stops stalled response bytes', async t => {
  let abortClosed; const closed = new Promise(resolve => { abortClosed = resolve; });
  const server = createServer(async (request, response) => {
    if (request.method === 'PUT') { for await (const _chunk of request) {} response.writeHead(201); response.end(); }
    else { response.writeHead(200); response.write('partial'); request.once('close', abortClosed); }
  });
  try { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  catch (error) { server.close(); if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('Sandbox blocks local HTTP listen'); return; } throw error; }
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/stream`;
  const body = Readable.from((async function* () { for (let n = 0; n < 4; n++) { await new Promise(resolve => setTimeout(resolve, 60)); yield Buffer.alloc(65536); } })());
  const start = performance.now(), response = await publisherFetch(url, { method: 'PUT', body, signal: AbortSignal.timeout(2000) }); assert.equal(response.status, 201); assert.ok(performance.now() - start >= 200); await response.body.cancel();
  const controller = new AbortController(), stalled = await publisherFetch(url, { signal: controller.signal }); const consuming = stalled.arrayBuffer(); controller.abort(); await assert.rejects(consuming); await closed;
});
