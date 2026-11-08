// ABOUTME: Проверяет доверенный протокол и выдачу файлов администраторам.
// ABOUTME: Не использует пользовательские профили или внешние сервисы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, renameSync, symlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Control, createArtifactReader, handlePrivateRpc, snapshotSessionDB } from '../control.mjs';

const bytes = Buffer.from('fixture');
const id = '9b8d327b-8c3e-47ca-89e1-fd8126757bd1';
const base = 'http://127.0.0.1:3004';
const artifact = { artifactId: id, ownerId: 'u1', status: 'ready', sizeBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'text/plain', filename: 'a.txt', internalUrl: base + '/files/' + id };
const profile = { userId: 'u1', profileId: 'p1', telegramId: '42', status: 'active' };
const headers = { cookie: 'a=b', origin: 'https://example.test' };

function control(reader, calls = []) {
  return new Control({ origin: headers.origin, cursorKey: 'x'.repeat(32),
    registry: async () => ({ version: 1, profiles: { '1001': profile } }),
    authCall: async (name) => { calls.push(name); return name === 'session'
      ? { status: 200, body: { user: { role: 'admin', status: 'active' }, session: {} } }
      : { status: 200 }; }, artifactsCall: reader });
}

test('download descriptor follows audit and owner check without exposing URL', async () => {
  const calls = [];
  const reader = createArtifactReader({ internalBaseURL: base,
    wire: async (subject, payload) => { calls.push('owner'); assert.equal(payload.artifactId, id); return artifact; } });
  const result = await control(reader, calls).invoke('admin-artifacts-download', { headers, userId: 'u1', artifactId: id });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { artifactId: id, filename: 'a.txt', mimeType: 'text/plain', sizeBytes: bytes.length, sha256: artifact.sha256 });
  assert.deepEqual(calls, ['session', 'admin-audit', 'owner']);
});

test('download rejects foreign owner, changed URL, malformed hash and oversized metadata', async () => {
  let upstream = { ...artifact, ownerId: 'other' };
  const reader = createArtifactReader({ internalBaseURL: base, wire: async () => upstream });
  const c = control(reader), input = { headers, userId: 'u1', artifactId: id };
  assert.equal((await c.invoke('admin-artifacts-download', input)).status, 503);
  upstream = { ...artifact, internalUrl: 'http://evil.invalid/files/' + id };
  assert.equal((await c.invoke('admin-artifacts-download', input)).status, 503);
  upstream = { ...artifact, sha256: 'bad' };
  assert.equal((await c.invoke('admin-artifacts-download', input)).status, 503);
  upstream = { ...artifact, sizeBytes: 2147483649 };
  assert.equal((await c.invoke('admin-artifacts-download', input)).status, 413);
  upstream = { ...artifact, sizeBytes: 64 * 1024 * 1024 };
  assert.equal((await c.invoke('admin-artifacts-download', input)).body.sizeBytes, 67108864);
  upstream = { ...artifact, sizeBytes: 2147483648 };
  assert.equal((await c.invoke('admin-artifacts-download', input)).body.sizeBytes, 2147483648);
});

test('JSON-RPC accepts batches, suppresses notifications and preserves error codes', async () => {
  const runtime = { control: {}, registry: async () => ({ version: 1, profiles: { '1001': profile } }),
    authCall: async () => ({ user: { id: 'u1', profileId: 'p1', telegramId: '42', status: 'active', role: 'user' } }) };
  const result = await handlePrivateRpc(runtime, [
    { jsonrpc: '2.0', id: 1, method: 'authorize', params: { uid: 1001 } },
    { jsonrpc: '2.0', method: 'authorize', params: { uid: 1001 } },
    { jsonrpc: '2.0', id: 'x', method: 'unknown' },
    { jsonrpc: '2.0', id: 2, method: 'authorize', params: [] },
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0].result.userId, 'u1');
  assert.equal(result[1].error.code, -32601);
  assert.equal(result[2].error.code, -32602);
  assert.equal(await handlePrivateRpc(runtime, { jsonrpc: '2.0', method: 'unknown' }), null);
  assert.equal((await handlePrivateRpc(runtime, [])).error.code, -32600);
});

test('revalidation signals blocked identity to broker', async () => {
  const changes = [];
  const runtime = { control: { onIdentityChanged: async event => changes.push(event) },
    registry: async () => ({ version: 1, profiles: { '1001': profile } }),
    authCall: async () => ({ user: { id: 'u1', profileId: 'p1', telegramId: '42', status: 'blocked', role: 'user' } }) };
  const result = await handlePrivateRpc(runtime, { jsonrpc: '2.0', id: 1, method: 'identity.revalidate', params: { uid: 1001 } });
  assert.deepEqual(result.result, { active: false });
  assert.deepEqual(changes, [{ userId: 'u1', profileId: 'p1', status: 'blocked', role: 'user' }]);
});

test('SQLite rejects path replacement and changed bytes during snapshot', () => {
  const home = mkdtempSync(join(tmpdir(), 'identity-race-')), path = join(home, 'state.db');
  try {
    const db = new DatabaseSync(path); db.exec('CREATE TABLE x (id INTEGER)'); db.close();
    const bound = { home, workerUid: process.getuid() };
    assert.throws(() => snapshotSessionDB(bound, () => true, { afterCopy() {
      renameSync(path, join(home, 'original')); symlinkSync('original', path);
    } }));
    rmSync(path); renameSync(join(home, 'original'), path);
    assert.throws(() => snapshotSessionDB(bound, () => true, { afterCopy() {
      appendFileSync(path, Buffer.from([0]));
    } }));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('stream frames replies and checks identity while another call waits', async () => {
  const { PassThrough } = await import('node:stream');
  const { servePrivateRpc } = await import('../control.mjs');
  const source = new PassThrough(), output = new PassThrough();
  let resolveSlow;
  const slow = new Promise(resolve => { resolveSlow = resolve; });
  const runtime = { control: {}, registry: async () => ({ version: 1, profiles: { '1001': profile } }),
    authCall: async (name, args) => args.telegramId === '99' ? slow : ({ user: { id: 'u1', profileId: 'p1', telegramId: '42', status: 'active', role: 'user' } }) };
  let received = '';
  output.on('data', chunk => { received += chunk.toString(); });
  const serving = servePrivateRpc(runtime, source, output);
  source.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'identity.resolve', params: { telegramId: '99' } }) + '\n');
  source.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'identity.revalidate', params: { uid: 1001 } }) + '\n');
  for (let i = 0; i < 100 && !received.includes('\n'); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(received.trim()).id, 2);
  resolveSlow({ user: null });
  source.end();
  await serving;
  assert.deepEqual(received.trim().split('\n').map(line => JSON.parse(line).id), [2, 1]);
});

test('importing control does not start the service', async () => {
  const { spawnSync } = await import('node:child_process');
  const moduleUrl = new URL('../control.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)}); process.stdout.write('ok')`, '--', '--stdio'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, 'ok');
});

test('revalidation reports a confirmed role change', async () => {
  const changes = []; let role = 'admin';
  const runtime = { control: { onIdentityChanged: async event => changes.push(event) },
    registry: async () => ({ version: 1, profiles: { '1001': profile } }),
    authCall: async () => ({ user: { id: 'u1', profileId: 'p1', telegramId: '42', status: 'active', role } }) };
  const req = { jsonrpc: '2.0', id: 1, method: 'identity.revalidate', params: { uid: 1001 } };
  assert.equal((await handlePrivateRpc(runtime, req)).result.role, 'admin');
  assert.deepEqual(changes, []);
  role = 'user';
  assert.equal((await handlePrivateRpc(runtime, req)).result.role, 'user');
  assert.deepEqual(changes, [{ userId: 'u1', profileId: 'p1', status: 'active', role: 'user' }]);
});

test('prepared restore exposes only its own bootstrap configuration', async () => {
  const bound = { userId: 'restore-user', profileId: 'restore-profile', telegramId: '123', status: 'provisioning' };
  let status = 'provisioning', bootstraps = 0;
  const runtime = {
    registry: async () => ({ version: 1, profiles: { '1001': bound } }),
    authCall: async () => ({ user: { id: bound.userId, profileId: bound.profileId, telegramId: bound.telegramId, status, role: 'user' } }),
    control: { bootstrapFilesConfiguration: async candidate => {
      assert.equal(candidate.userId, bound.userId);
      assert.equal(candidate.profileId, bound.profileId);
      assert.equal(candidate.status, 'provisioning');
      bootstraps++;
      return { ownerId: bound.userId };
    } },
  };
  const call = method => handlePrivateRpc(runtime, { jsonrpc: '2.0', id: 1, method, params: { uid: 1001 } });
  assert.deepEqual((await call('files.configuration')).result, { ownerId: bound.userId });
  assert.ok((await call('tools.list')).error);
  status = 'blocked'; bound.status = 'blocked';
  assert.ok((await call('files.configuration')).error);
  assert.equal(bootstraps, 1);
});
