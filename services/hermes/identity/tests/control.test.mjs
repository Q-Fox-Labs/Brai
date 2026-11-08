// ABOUTME: Проверяет контроль доступа к данным и секретность доставки входа.
// ABOUTME: Порты заменены фикстурами; реальный транспорт проверяется отдельно.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Control } from '../control.mjs';

const profile = { userId: 'u1', profileId: 'p1', telegramId: '42', memoryEpoch: 'epoch-1', status: 'active' };
const registry = async () => ({ version: 1, profiles: { '1001': profile } });
const headers = { cookie: 'session=token', origin: 'https://brai.example' };
function setup(overrides = {}) {
  const calls = [];
  const authCall = async (op, value) => {
    calls.push(op);
    if (op === 'session') return { status: 200, body: { user: { id: 'admin', role: 'admin', status: 'active' }, session: {} } };
    if (op === 'admin-audit') return { status: 200 };
    if (op === 'telegram-resolve' || op === 'identity-get') return { user: { id: 'u1', profileId: 'p1', telegramId: '42', status: 'active' } };
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

test('fresh role reaches each private runtime and history after canonical Telegram unlink', async () => {
  const roles = [];
  let role = 'admin';
  const owner = { userId: 'u1', profileId: 'p1', telegramId: '42', status: 'active' };
  const registry = async () => ({ version: 1, profiles: { '1001': owner } });
  const authCall = async (method, args) => {
    assert.equal(method, 'identity-get');
    assert.deepEqual(args, { userId: 'u1' });
    return { user: { id: 'u1', profileId: 'p1', telegramId: '42', status: 'active', role },
             telegramIds: ['84'] };
  };
  const catalog = [{ name: 'timer_snapshot_get' }, { name: 'history_categories_list' },
                   { name: 'transcription_settings_set' }];
  const control = new Control({ origin: 'https://example.test', cursorKey: 'x'.repeat(32),
    registry, authCall,
    perUserRuntime: async profile => {
      roles.push(profile.role);
      return { listTools: async () => catalog, callTool: async () => ({ ok: true }),
               filesConfiguration: async () => ({ ownerId: profile.userId }) };
    },
    historyCall: async (profile, name) => {
      assert.equal(profile.role, role);
      assert.equal(profile.telegramId, '42');
      return { name };
    } });
  const { privateCall } = await import('../control.mjs');
  const runtime = { control, registry, authCall };
  await control.invokeTool(1001, 'timer_snapshot_get', {});
  await control.invokeTool(1001, 'history_categories_list', {});
  assert.equal((await privateCall(runtime, 'tools.list', { uid: 1001 })).tools.length, 3);
  await privateCall(runtime, 'files.configuration', { uid: 1001 });
  role = 'user';
  const listed = await privateCall(runtime, 'tools.list', { uid: 1001 });
  assert.equal(listed.tools.some(tool => tool.name === 'transcription_settings_set'), false);
  await assert.rejects(control.invokeTool(1001, 'transcription_settings_set', {}), /FORBIDDEN/);
  assert.deepEqual(roles, ['admin', 'admin', 'admin', 'admin', 'user', 'user']);
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

test('linked account receives its own login code after Auth confirms canonical owner', async () => {
  const { control, calls } = setup();
  assert.deepEqual(await control.sendLogin({ uid: 1001, telegramId: '84', privateChat: true, requestId: 'alias' }), { status: 'sent' });
  assert.equal(calls[2].telegramId, '84');
  const foreign = setup({ authCall: async () => ({ user: { id: 'other', profileId: 'other', telegramId: '84', status: 'active' } }) });
  assert.deepEqual(await foreign.control.sendLogin({ uid: 1001, telegramId: '84', privateChat: true, requestId: 'foreign' }), { status: 'denied' });
  assert.equal(foreign.calls.length, 0);
});

test('account link warning precedes issue and secret is delivered only to source account', async () => {
  const calls = [], delivered = [], secret = 'a'.repeat(43);
  const authCall = async (operation, input) => {
    calls.push(operation);
    if (operation === 'telegram-resolve') return { user: { id: 'u1', profileId: 'p1', telegramId: '42', status: 'active' } };
    if (operation === 'telegram-link-issue') return { code: secret, expiresAt: 'later' };
  };
  const { control } = setup({ authCall, telegramSend: async value => { delivered.push(value); return { ok: true }; } });
  const input = { uid: 1001, telegramId: '84', threadId: 7 };
  assert.deepEqual(await control.sendAccountLink({ ...input, phase: 'offer' }), { status: 'sent' });
  assert.deepEqual(calls, ['telegram-resolve']);
  assert.match(delivered[0].message, /всей вашей памяти/);
  assert.match(delivered[0].message, /другому человеку/);
  assert.match(delivered[0].message, /Подтверждаете/);
  const result = await control.sendAccountLink({ ...input, phase: 'command' });
  assert.deepEqual(result, { status: 'sent' });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(delivered[1].telegramId, '84');
  assert.equal(delivered[1].threadId, 7);
  assert.match(delivered[1].message, new RegExp('/start link_' + secret));
});

test('login preserves trusted DM topic and rejects invalid topics before issuing a code', async () => {
  for (const threadId of [0, -1, true, '73', null, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const { control, calls } = setup();
    assert.deepEqual(await control.sendLogin({ uid: 1001, telegramId: '42', privateChat: true, requestId: 'r', threadId }), { status: 'denied' });
    assert.equal(calls.length, 0);
  }
  const { control, calls } = setup();
  assert.deepEqual(await control.sendLogin({ uid: 1001, telegramId: '42', privateChat: true, requestId: 'r', threadId: 73 }), { status: 'sent' });
  assert.equal(calls[2].threadId, 73);
  assert.equal(calls[2].telegramId, '42');
  const failed = setup({ telegramSend: async () => ({ ok: false }) });
  assert.deepEqual(await failed.control.sendLogin({ uid: 1001, telegramId: '42', privateChat: true, requestId: 'r', threadId: 73 }), { status: 'failed' });
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
        return name === 'session' ? { status: 200, body: { user: { id: 'admin', role: 'admin', status: 'active' }, session: {} } } : { status: 200 };
      },
      [port]: async ({ profile: selected, id }) => { calls.push(['read', selected]); return operation === 'admin-memory-get' ? { id, profileId: selected.profileId } : { ok: true }; },
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
      ? { status: 200, body: { user: { id: 'admin', role: 'admin', status: 'active' }, session: {} } }
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

test('unlink warning pins first account, removes it only on confirmed call and blocks admin last channel', async () => {
  const delivered = [], calls = [];
  let accounts = ['42','84'], role = 'user';
  const user = () => ({ id:'u1', profileId:'p1', telegramId:'42', status:'active', role });
  const authCall = async (op, input) => {
    calls.push([op,input]);
    if (op === 'telegram-resolve') return {user:accounts.includes(input.telegramId) ? user() : null};
    if (op === 'identity-get') return {user:user(),telegramIds:[...accounts]};
    if (op === 'telegram-unlink') { accounts = accounts.filter(id=>id!==input.targetTelegramId); return {unlinked:true}; }
  };
  const {control} = setup({authCall,telegramSend:async value=>{delivered.push(value);return {ok:true};}});
  const input = {uid:1001,telegramId:'84',target:'other'};
  assert.deepEqual(await control.sendAccountUnlink({...input,phase:'offer'}), {status:'sent',targetTelegramId:'42'});
  assert.match(delivered[0].message,/Подтверждаю отвязку Telegram-аккаунта 42/);
  assert.equal(calls.some(([op])=>op==='telegram-unlink'),false);
  assert.equal((await control.sendAccountUnlink({...input,phase:'confirm',targetTelegramId:'42'})).status,'sent');
  assert.deepEqual(accounts,['84']);
  assert.deepEqual(await control.invokeTool(1001,'timer_snapshot_get',{}).catch(error=>error.message),'SOURCE_UNAVAILABLE');
  role = 'admin';
  assert.deepEqual(await control.sendAccountUnlink({...input,target:'current',phase:'offer'}),{status:'denied',reason:'admin-last-channel'});
  role = 'user';
  assert.equal((await control.sendAccountUnlink({...input,target:'current',phase:'offer'})).status,'sent');
  assert.match(delivered.at(-1).message,/последний подключённый канал/);
  assert.equal((await control.sendAccountUnlink({...input,target:'current',phase:'confirm',targetTelegramId:'84'})).status,'sent');
  assert.deepEqual(accounts,[]);
  assert.equal((await control.sendAccountUnlink({...input,target:'current',phase:'offer'})).status,'denied');
});

test('authorization uses stable owner even after the original Telegram account is disconnected', async () => {
  const {privateCall} = await import('../control.mjs');
  const calls = [];
  const runtime = {control:{},registry,authCall:async (op,input)=>{
    calls.push([op,input]);
    return op==='identity-get' ? {user:{id:'u1',profileId:'p1',telegramId:'42',status:'active',role:'user'},telegramIds:['84']} : {user:null};
  }};
  assert.equal((await privateCall(runtime,'authorize',{uid:1001})).active,true);
  assert.deepEqual(calls,[['identity-get',{userId:'u1'}]]);
  const direct = await privateCall(runtime,'identity.unlink',{telegramId:'84'}).catch(error=>error.message);
  assert.equal(direct,'METHOD_NOT_FOUND');
});
