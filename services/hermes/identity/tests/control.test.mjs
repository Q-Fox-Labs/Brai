// ABOUTME: Проверяет контроль доступа к данным и секретность доставки входа.
// ABOUTME: Порты заменены фикстурами; реальный транспорт проверяется отдельно.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Control } from '../control.mjs';

const profile = { userId: 'u1', profileId: 'p1', telegramId: '42', status: 'active' };
const registry = async () => ({ version: 1, profiles: { '1001': profile } });
const headers = { cookie: 'session=token', origin: 'https://brai.example' };
function setup(overrides = {}) {
  const calls = [];
  const authCall = async (op, value) => {
    calls.push(op);
    if (op === 'session') return { status: 200, body: { user: { role: 'admin', status: 'active' }, session: {} } };
    if (op === 'admin-audit') return { status: 200 };
    if (op === 'telegram-resolve') return { user: { id: 'u1', profileId: 'p1', telegramId: '42', status: 'active' } };
    if (op === 'telegram-code-issue') return { code: '123456789ABC', origin: 'https://brai.example', expiresAt: 'later' };
  };
  const control = new Control({ origin: headers.origin, cursorKey: 'x'.repeat(32), registry, authCall,
    memoryRead: async () => { calls.push('read'); return { items: [], nextCursor: 'snapshot:1' }; },
    telegramSend: async value => { calls.push(value); return { ok: true }; }, ...overrides });
  return { control, calls };
}

test('audit precedes read and cursor is bound to target', async () => {
  const { control, calls } = setup();
  const result = await control.invoke('admin-memory-list', { headers, userId: 'u1' });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, ['session', 'admin-audit', 'read']);
  const bad = await control.invoke('admin-memory-list', { headers, userId: 'other', cursor: result.body.nextCursor });
  assert.notEqual(bad.status, 200);
});

test('denied session or audit does not read', async () => {
  let read = false;
  const { control } = setup({ authCall: async op => op === 'session' ? { status: 200, body: { user: { role: 'user', status: 'active' }, session: {} } } : { status: 200 }, memoryRead: async () => { read = true; } });
  assert.equal((await control.invoke('admin-memory-list', { headers, userId: 'u1' })).status, 403);
  assert.equal(read, false);
});

test('login sends only to bound private owner and returns no secret', async () => {
  const { control, calls } = setup();
  assert.deepEqual(await control.sendLogin({ uid: 1001, telegramId: '42', privateChat: false, requestId: 'r' }), { status: 'denied' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await control.sendLogin({ uid: 1001, telegramId: '42', privateChat: true, requestId: 'r' }), { status: 'sent' });
  assert.equal(calls[2].telegramId, '42');
  assert.match(calls[2].message, /123456789ABC/);
});

test('tools require current identity and reject owner overrides', async () => {
  const calls = [];
  const { control } = setup({ toolCatalog: new Map([['timer_snapshot_get', () => true]]),
    perUserRuntime: async profile => ({ listTools: async () => [{ name: 'timer_snapshot_get' }], callTool: async (name, args) => { calls.push([profile.userId, name, args]); return { ok: true }; } }) });
  await assert.rejects(control.invokeTool(1001, 'timer_snapshot_get', { ownerId: 'other' }), /INVALID_ARGUMENT/);
  assert.deepEqual(await control.invokeTool(1001, 'timer_snapshot_get', {}), { ok: true });
  assert.deepEqual(calls, [['u1', 'timer_snapshot_get', {}]]);
  await assert.rejects(control.invokeTool(1002, 'timer_snapshot_get', {}), /FORBIDDEN/);
});

test('SQLite snapshot reads target owner and rejects symlinks and foreign owners', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { createChatRead } = await import('../control.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-test-'));
  try {
    const db = new DatabaseSync(path.join(dir, 'state.db'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    db.exec("CREATE TABLE sessions(id TEXT,source TEXT,title TEXT,started_at REAL,last_activity_at REAL); CREATE TABLE messages(id INTEGER,session_id TEXT,role TEXT,content TEXT,timestamp REAL); INSERT INTO sessions VALUES('s','telegram','Чат',1,2); INSERT INTO messages VALUES(1,'s','user','Привет',3)");
    const read = createChatRead();
    const profile = { home: dir, workerUid: process.getuid(), userId: 'u1' };
    const list = await read({ operation: 'admin-chats-list', profile, limit: 1 });
    assert.equal(list.items[0].id, 's');
    const chat = await read({ operation: 'admin-chats-get', profile, id: 's', limit: 1 });
    assert.equal(chat.messages[0].text, 'Привет');
    await assert.rejects(read({ operation: 'admin-chats-list', profile: { ...profile, workerUid: profile.workerUid + 1 }, limit: 1 }));
    db.close();
    fs.renameSync(path.join(dir, 'state.db'), path.join(dir, 'original'));
    fs.symlinkSync('original', path.join(dir, 'state.db'));
    await assert.rejects(read({ operation: 'admin-chats-list', profile, limit: 1 }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('catalog hides privileged model operations and returns full descriptors', async () => {
  const { privateCall } = await import('../control.mjs');
  const catalog = [{ name: 'timer_snapshot_get', description: 'read', inputSchema: { type: 'object' } },
    { name: 'local_ai_models_remove', description: 'remove', inputSchema: { type: 'object' } }];
  const { control } = setup({ perUserRuntime: async () => ({ listTools: async () => catalog, callTool: async () => ({}) }) });
  const runtime = { control, registry, authCall: async () => ({ user: { id: 'u1', profileId: 'p1', telegramId: '42', status: 'active', role: 'user' } }) };
  const result = await privateCall(runtime, 'tools.list', { uid: 1001 });
  assert.deepEqual(result.tools, [catalog[0]]);
  await assert.rejects(privateCall(runtime, 'tools.list', { uid: 1002 }), /FORBIDDEN/);
});

test('active admin may read each registered target status only after audit', async () => {
  for (const status of ['active', 'blocked', 'disabled', 'provisioning']) {
    for (const [operation, port, action, extra] of [
      ['admin-memory-list', 'memoryRead', 'memory.list', {}],
      ['admin-chats-get', 'chatRead', 'chats.read', { chatId: 'chat' }],
      ['admin-artifacts-get', 'artifactsCall', 'artifacts.read', { artifactId: 'artifact' }],
    ]) {
      const calls = [];
      const target = { ...profile, status };
      const control = new Control({ origin: headers.origin, cursorKey: 'x'.repeat(32),
        registry: async () => ({ version: 1, profiles: { '1001': target } }),
        authCall: async (name, args) => {
          calls.push([name, args]);
          return name === 'session'
            ? { status: 200, body: { user: { id: 'admin', role: 'admin', status: 'active' }, session: {} } }
            : { status: 200 };
        },
        [port]: async ({ profile: selected }) => { calls.push(['read', selected]); return { value: 'owned' }; },
      });
      assert.equal((await control.invoke(operation, { headers, userId: 'u1', ...extra })).status, 200);
      assert.deepEqual(calls.map(item => item[0]), ['session', 'admin-audit', 'read']);
      assert.deepEqual(calls[1][1], { headers, body: { userId: 'u1', action } });
      assert.equal(calls[2][1].status, status);
    }
  }
});

test('blocked admin cannot read another profile or obtain owner tools and login', async () => {
  let reads = 0;
  const blocked = { ...profile, status: 'blocked' };
  const { control } = setup({
    registry: async () => ({ version: 1, profiles: { '1001': blocked } }),
    authCall: async name => name === 'session'
      ? { status: 200, body: { user: { role: 'admin', status: 'blocked' }, session: {} } }
      : { user: { id: 'u1', profileId: 'p1', telegramId: '42', status: 'blocked' } },
    memoryRead: async () => { reads++; return {}; },
  });
  assert.equal((await control.invoke('admin-memory-list', { headers, userId: 'u1' })).status, 403);
  assert.equal(reads, 0);
  await assert.rejects(control.invokeTool(1001, 'timer_snapshot_get', {}), /FORBIDDEN/);
  assert.deepEqual(await control.sendLogin({ uid: 1001, telegramId: '42', privateChat: true, requestId: 'r' }), { status: 'denied' });
});

test('archive admin reads use only configured quarantine owners and audit reserved target', async () => {
  const archive = { userId: 'quarantine-memory', profileId: 'quarantine-profile', homeScope: 'archive',
    memoryEpoch: 'e1', cubes: ['cube'], home: '/archive/old-home', workerUid: 995 };
  for (const [operation, port, action, extra, expectedOwner] of [
    ['admin-memory-list', 'memoryRead', 'memory.list', {}, 'quarantine-memory'],
    ['admin-memory-get', 'memoryRead', 'memory.read', { memoryId: 'm1' }, 'quarantine-memory'],
    ['admin-chats-list', 'chatRead', 'chats.list', {}, 'quarantine-memory'],
    ['admin-chats-get', 'chatRead', 'chats.read', { chatId: 'c1' }, 'quarantine-memory'],
    ['admin-artifacts-list', 'artifactsCall', 'artifacts.list', {}, 'legacy-artifacts'],
    ['admin-artifacts-get', 'artifactsCall', 'artifacts.read', { artifactId: 'a1' }, 'legacy-artifacts'],
    ['admin-artifacts-download', 'artifactsCall', 'artifacts.read', { artifactId: 'a1' }, 'legacy-artifacts'],
  ]) {
    const calls = [];
    const c = new Control({ origin: headers.origin, cursorKey: 'x'.repeat(32),
      registry: async () => ({ version: 1, profiles: {} }),
      quarantineProfile: archive, quarantineArtifactsOwnerId: 'legacy-artifacts',
      authCall: async (name, args) => {
        calls.push([name, args]);
        return name === 'session' ? { status: 200, body: { user: { role: 'admin', status: 'active' }, session: {} } } : { status: 200 };
      },
      [port]: async ({ profile: selected }) => { calls.push(['read', selected]); return { ok: true }; },
    });
    assert.equal((await c.invoke(operation, { headers, userId: '__quarantine__', ...extra })).status, 200);
    assert.deepEqual(calls.map(item => item[0]), ['session', 'admin-audit', 'read']);
    assert.deepEqual(calls[1][1].body, { userId: '__quarantine__', action });
    assert.equal(calls[2][1].userId, expectedOwner);
    assert.equal(calls[2][1].workerUid, 995);
    assert.equal(calls[2][1].home, '/archive/old-home');
    assert.equal((await c.invoke(operation, { headers, userId: '__quarantine__', ...extra, home: '/etc' })).status, 403);
  }
});

test('archive requires active admin, successful audit and complete protected configuration', async () => {
  const archive = { userId: 'q', profileId: 'qp', homeScope: 'q', memoryEpoch: 'e',
    cubes: ['c'], home: '/archive/home', workerUid: 995 };
  let reads = 0;
  const port = async () => { reads++; return {}; };
  const { control } = setup({ quarantineProfile: archive, memoryRead: port,
    authCall: async name => name === 'session'
      ? { status: 200, body: { user: { role: 'user', status: 'active' }, session: {} } }
      : { status: 200 } });
  assert.equal((await control.invoke('admin-memory-list', { headers, userId: '__quarantine__' })).status, 403);
  const deniedAudit = setup({ quarantineProfile: archive, memoryRead: port,
    authCall: async name => name === 'session'
      ? { status: 200, body: { user: { role: 'admin', status: 'active' }, session: {} } }
      : { status: 403 } }).control;
  assert.equal((await deniedAudit.invoke('admin-memory-list', { headers, userId: '__quarantine__' })).status, 403);
  const missingConfig = setup({ memoryRead: port }).control;
  assert.equal((await missingConfig.invoke('admin-memory-list', { headers, userId: '__quarantine__' })).status, 503);
  const malformedConfig = setup({ quarantineProfile: { ...archive, workerUid: 0 }, memoryRead: port }).control;
  assert.equal((await malformedConfig.invoke('admin-memory-list', { headers, userId: '__quarantine__' })).status, 503);
  assert.equal(reads, 0);
  await assert.rejects(missingConfig.invokeTool(995, 'timer_snapshot_get', {}), /FORBIDDEN/);
  assert.deepEqual(await missingConfig.sendLogin({ uid: 995, telegramId: '42', privateChat: true, requestId: 'r' }), { status: 'denied' });
});
