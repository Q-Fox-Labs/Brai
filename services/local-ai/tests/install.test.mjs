// ABOUTME: Проверяет public search и полный цикл установки закреплённого профиля.
// ABOUTME: Использует локальный HTTP Hub и временную папку, без PostgreSQL и внешних секретов.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createHuggingFaceCatalog,
  createModelInstaller,
  registerSupportedProfiles,
} from '../dist/install/huggingface.js';

const revision = 'a'.repeat(40);
const modelId = 'fixture-model';
const profileId = 'fixture_profile';
const repository = 'fixture/model';
const bytes = Buffer.from('verified weights');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const timestamp = () => new Date().toISOString();

function record(overrides = {}) {
  return {
    modelId, name: 'fixture', description: '', source: repository, license: 'apache-2.0',
    revision, profileId, supported: true, operations: ['embed'], languages: ['en'],
    inputKinds: ['text'], outputKinds: ['vector'], files: [{ path: 'weights.bin', sizeBytes: bytes.length, sha256 }],
    hardwareRequirements: { cpuArchitectures: [], minMemoryBytes: null, accelerator: null },
    limits: { maxInputBytes: null, maxAudioSeconds: null, maxItems: null, maxResultBytes: null, vectorDimensions: null },
    parameters: { embed: { purpose: ['query'] }, transcribe: null },
    ...overrides,
  };
}
const profile = {
  profileId, modelId, repository, revision,
  files: [{ path: 'weights.bin', bytes: bytes.length, sha256 }],
  record: record(),
};

function fakeStore() {
  const models = new Map();
  const installations = new Map();
  const operations = new Map();
  const events = [];
  const tx = {
    models: {
      async get(id) { return models.get(id) ?? null; },
      async put(value) { models.set(value.modelId, structuredClone(value)); },
      async list() { return [...models.values()]; },
      async remove(id) { models.delete(id); },
    },
    installations: {
      async get(id, rev) { return installations.get(id + ':' + rev) ?? null; },
      async put(value) { installations.set(value.modelId + ':' + value.revision, structuredClone(value)); },
      async list() { return [...installations.values()]; },
      async remove(id, rev) { installations.delete(id + ':' + rev); },
    },
    installationOperations: {
      async get(id, owner) { return operations.get(owner + ':' + id) ?? null; },
      async put(value) {
        const key = value.ownerId + ':' + value.operationId;
        const old = operations.get(key);
        if (old && (old.modelId !== value.modelId || old.revision !== value.revision || old.profileId !== value.profileId || old.createdAt !== value.createdAt)) {
          throw Object.assign(new Error('conflict'), { code: 'REVISION_CONFLICT' });
        }
        operations.set(key, structuredClone(value));
      },
    },
    settings: { async get() { return null; }, async put() {} },

  };
  return {
    events, models, installations, operations,
    async transaction(run) { return run(tx); },
    async recoverInterrupted() { return 0; },
  };
}

async function hubFixture(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = 'http://127.0.0.1:' + address.port;
  return {
    origin,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function mappedFetch(origin, observed = []) {
  return (input, init = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://huggingface.co', 'adapter must construct only fixed Hugging Face URLs');
    assert.equal(init.headers?.authorization, undefined, 'public search and installer never receive a Hub token');
    observed.push({ url, init });
    return fetch(origin + url.pathname + url.search, init);
  };
}

async function waitFor(installer, operationId, ownerId) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const operation = await installer.get(operationId, ownerId);
    if (['completed', 'failed', 'cancelled', 'unknown'].includes(operation.status)) return operation;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('installation did not reach a terminal state');
}

test('public Hugging Face search marks unknown and gated results unsupported and rejects arbitrary pagination URLs', async t => {
  const requests = [];
  const fixture = await hubFixture((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');
    if (request.url.includes('search=bad')) response.setHeader('link', '<https://evil.example/api/models?search=bad&limit=2&cursor=next>; rel="next"');
    response.end(JSON.stringify([
      { id: 'other/unknown', sha: revision, tags: ['license:mit', 'language:en'] },
      { id: 'other/gated', sha: revision, gated: 'manual', tags: ['license:apache-2.0'] },
      { id: 'private/model', sha: revision, private: true },
    ]));
  });
  t.after(() => fixture.close());
  const catalog = createHuggingFaceCatalog({ profiles: [profile], fetchImpl: mappedFetch(fixture.origin), maxPageSize: 2 });
  const result = await catalog.search({ query: 'giga', page: { limit: 2 } });
  assert.equal(requests.length, 1);
  const searchUrl = new URL(requests[0], 'http://fixture');
  assert.equal(searchUrl.pathname, '/api/models');
  assert.equal(searchUrl.searchParams.get('search'), 'giga');
  assert.equal(searchUrl.searchParams.get('limit'), '2');
  assert.deepEqual(searchUrl.searchParams.getAll('expand[]'), ['sha', 'tags', 'private', 'gated']);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items.map(item => item.supported), [false, false]);
  assert.ok(result.items.every(item => item.profileId === null && item.operations.length === 0));
  assert.equal(result.items[0].license, 'mit');
  assert.equal(result.nextCursor, null);
  await assert.rejects(catalog.search({ query: 'bad', page: { limit: 2 } }), error => error?.code === 'DEPENDENCY_UNAVAILABLE');
});

test('pinned installer verifies bytes and hash before atomic publication; retry returns the saved operation', async t => {
  let downloadRequests = 0;
  const fixture = await hubFixture((request, response) => {
    if (request.url.startsWith('/fixture/model/resolve/')) {
      downloadRequests += 1;
      response.setHeader('content-length', String(bytes.length));
      response.end(bytes);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  t.after(() => fixture.close());
  const root = await mkdtemp(path.join(os.tmpdir(), 'brai-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeStore();
  await registerSupportedProfiles(store, [profile]);
  const installer = createModelInstaller({ history: { publish: event => store.events.push(event) },
    store, profiles: [profile], rootDirectory: root, fetchImpl: mappedFetch(fixture.origin),
    limits: { maxDownloadBytes: 1024, maxFiles: 4, maxParallel: 1, maxOperationMs: 5000 },
  });
  const requestId = randomUUID();
  const request = { modelId, revision, profileId, requestId, ownerId: 'owner-1', deadlineAt: new Date(Date.now() + 5_000).toISOString() };
  const accepted = await installer.start(request);
  const completed = await waitFor(installer, requestId, request.ownerId);
  assert.equal(accepted.status, 'accepted');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.progressPercent, 100);
  assert.equal(downloadRequests, 1);
  assert.equal(await readFile(path.join(root, modelId, revision, profileId, 'weights.bin'), 'utf8'), bytes.toString());
  assert.equal(store.installations.size, 1);
  const repeated = await installer.start(request);
  assert.deepEqual(repeated, completed);
  assert.equal(downloadRequests, 1, 'a repeated request must not download or publish twice');
  await assert.rejects(installer.get(requestId, 'other-owner'), error => error?.code === 'MODEL_NOT_FOUND');
  assert.deepEqual(await readdir(path.join(root, modelId, revision)), [profileId]);
  assert.equal(store.events.at(-1).data.outcome, 'succeeded');
});

test('wrong content hash fails closed and leaves no ready metadata or staging directory', async t => {
  const fixture = await hubFixture((_request, response) => response.end(bytes));
  t.after(() => fixture.close());
  const root = await mkdtemp(path.join(os.tmpdir(), 'brai-install-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeStore();
  const wrongProfile = {
    ...profile,
    files: [{ path: 'weights.bin', bytes: bytes.length, sha256: '0'.repeat(64) }],
    record: record({ files: [{ path: 'weights.bin', sizeBytes: bytes.length, sha256: '0'.repeat(64) }] }),
  };
  await registerSupportedProfiles(store, [wrongProfile]);
  const installer = createModelInstaller({ history: { publish: event => store.events.push(event) }, store, profiles: [wrongProfile], rootDirectory: root, fetchImpl: mappedFetch(fixture.origin) });
  const requestId = randomUUID();
  await installer.start({ modelId, revision, profileId, requestId, ownerId: 'owner-1', deadlineAt: new Date(Date.now() + 5_000).toISOString() });
  const failed = await waitFor(installer, requestId, 'owner-1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'INSTALLATION_FAILED');
  assert.equal(store.installations.size, 0);
  assert.equal(store.events.at(-1).data.outcome, 'failed');
  await assert.rejects(readFile(path.join(root, modelId, revision, profileId, 'weights.bin')));
  await assert.rejects(readdir(path.join(root, modelId, revision, profileId)));
});

test('explicit release import accepts only a verified immutable directory at its canonical root', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brai-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeStore();
  await registerSupportedProfiles(store, [profile]);
  const installer = createModelInstaller({ history: { publish: event => store.events.push(event) }, store, profiles: [profile], rootDirectory: root });
  const parent = path.join(root, modelId, revision);
  const staging = path.join(parent, '.staging-' + randomUUID());
  const { mkdir: makeParent, writeFile: writeStaging } = await import('node:fs/promises');
  await makeParent(staging, { recursive: true });
  await writeStaging(path.join(staging, 'partial.bin'), Buffer.from('partial'));
  assert.equal(await installer.cleanupAbandonedStaging(), 1);
  await assert.rejects(readdir(staging));
  const directory = path.join(root, modelId, revision, profileId);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'weights.bin'), bytes);
  const imported = await installer.importVerified({ modelId, revision, profileId, directory });
  assert.equal(imported.directory, directory);
  assert.equal(store.installations.size, 1);
  assert.equal(store.events.length, 0, 'startup import is not a client operation');
  await assert.rejects(installer.cleanupPublished(imported), error => error?.code === 'MODEL_IN_USE');
  store.installations.delete(modelId + ':' + revision);
  await installer.cleanupPublished(imported);
  await assert.rejects(readFile(path.join(directory, 'weights.bin')));
  await assert.rejects(installer.importVerified({ modelId, revision, profileId, directory: root }), error => error?.code === 'INVALID_ARGUMENT');
});

test('cancel stops the transfer, removes its staging directory, and commits terminal state before close returns', async t => {
  let transferStarted = 0;
  const fixture = await hubFixture((request, response) => {
    if (request.url.startsWith('/fixture/model/resolve/')) {
      transferStarted += 1;
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.flushHeaders();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  t.after(() => fixture.close());
  const root = await mkdtemp(path.join(os.tmpdir(), 'brai-install-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeStore();
  await registerSupportedProfiles(store, [profile]);
  const installer = createModelInstaller({ history: { publish: event => store.events.push(event) }, store, profiles: [profile], rootDirectory: root, fetchImpl: mappedFetch(fixture.origin) });
  const requestId = randomUUID();
  const ownerId = 'owner-1';
  await installer.start({ modelId, revision, profileId, requestId, ownerId, deadlineAt: new Date(Date.now() + 5_000).toISOString() });
  const transferDeadline = Date.now() + 1_000;
  while (transferStarted === 0 && Date.now() < transferDeadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(transferStarted, 1);
  await installer.cancel(requestId, ownerId);
  const cancelled = await waitFor(installer, requestId, ownerId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.errorCode, 'CANCELLED');
  assert.equal(store.installations.size, 0);
  assert.equal(store.events.at(-1).data.outcome, 'cancelled');
  assert.deepEqual(await readdir(path.join(root, modelId, revision)), []);
  await installer.close();
  await assert.rejects(
    installer.start({ modelId, revision, profileId, requestId: randomUUID(), ownerId, deadlineAt: new Date(Date.now() + 5_000).toISOString() }),
    error => error?.code === 'BUSY',
  );
});
