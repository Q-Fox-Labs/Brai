// ABOUTME: Проверяет доступ администратора и owner-bound контракт постоянной паузы.
// ABOUTME: Trusted ingress port заменён контролируемой фикстурой; внешних отправок нет.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Control } from '../control.mjs';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';

const headers = { cookie: 'session=test', origin: 'https://example.test' };
const request = { headers, userId: 'owner', source: 'telegram', chatId: '["123",""]' };
function fixture({ session, audit, registry, port } = {}) {
  const calls = [];
  const control = new Control({ origin: headers.origin, cursorKey: 'x'.repeat(32),
    registry: registry ?? (async () => ({ version: 1, profiles: { 1001: { userId: 'owner', profileId: 'profile', status: 'active' } } })),
    authCall: async (method, value) => {
      calls.push([method, value]);
      return method === 'session' ? session ?? { status: 200, body: { session: {}, user: { id: 'admin', role: 'admin', status: 'active' } } }
        : audit ?? { status: 200 };
    },
    chatControl: async value => {
      calls.push(['mutate', value]);
      return port ? port(value) : { paused: value.operation === 'admin-chats-pause', state: value.operation === 'admin-chats-pause' ? 'stopping' : 'resumed' };
    },
    chatRead: async () => ({ source: 'telegram', messages: [], nextCursor: null }),
  });
  return { control, calls };
}

test('pause and resume require fresh session and audit before canonical owner mutation', async () => {
  const f = fixture();
  for (const operation of ['admin-chats-pause', 'admin-chats-resume']) {
    const reply = await f.control.invoke(operation, request);
    assert.equal(reply.status, 200);
    assert.deepEqual(f.calls.slice(-3).map(value => value[0]), ['session', 'admin-audit', 'mutate']);
    assert.equal(f.calls.at(-2)[1].body.action, operation === 'admin-chats-pause' ? 'chats.pause' : 'chats.resume');
    assert.equal(f.calls.at(-1)[1].profile.userId, 'owner');
    assert.equal(f.calls.at(-1)[1].profile.workerUid, 1001);
  }
});

test('origin, role, blocked admin, audit failure, foreign owner, quarantine and invalid routes cannot mutate', async () => {
  const scenarios = [
    [{}, { ...request, headers: { ...headers, origin: 'https://foreign.test' } }],
    [{ session: { status: 403 } }, request],
    [{ session: { status: 200, body: { session: {}, user: { role: 'user', status: 'active' } } } }, request],
    [{ session: { status: 200, body: { session: {}, user: { role: 'admin', status: 'blocked' } } } }, request],
    [{ audit: { status: 503 } }, request],
    [{}, { ...request, userId: 'foreign' }],
    [{}, { ...request, userId: '__quarantine__' }],
    [{}, { ...request, source: 'native' }],
    [{}, { ...request, chatId: '["123","1"]' }],
    [{}, { ...request, chatId: '["-123",""]' }],
    [{}, { ...request, chatId: '["123",null]' }],
    [{}, { ...request, profileId: 'forged' }],
    [{}, { ...request, cursor: 'forged' }],
  ];
  for (const [options, input] of scenarios) {
    const f = fixture(options);
    assert.notEqual((await f.control.invoke('admin-chats-pause', input)).status, 200);
    assert.equal(f.calls.some(([method]) => method === 'mutate'), false);
  }
});

test('unknown persistence result fails closed and next mutation requires a new audit', async () => {
  const f = fixture({ port: async () => { throw new Error('store unavailable'); } });
  assert.equal((await f.control.invoke('admin-chats-pause', request)).status, 503);
  assert.equal((await f.control.invoke('admin-chats-pause', request)).status, 503);
  assert.equal(f.calls.filter(([method]) => method === 'admin-audit').length, 2);
});

test('legacy read remains available while absent pause port rejects mutations', async () => {
  const f = fixture();
  f.control.chatControl = undefined;
  assert.equal((await f.control.invoke('admin-chats-pause', request)).status, 503);
  const read = await f.control.invoke('admin-chats-get', request);
  assert.equal(read.status, 200);
  assert.equal(read.body.control, undefined);
});

test('pause request and response conform to owner schemas', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/control.schema.json', import.meta.url)));
  const auth = JSON.parse(await readFile(new URL('../../../auth/schemas/messages.schema.json', import.meta.url)));
  const ajv = new Ajv({ strict: false }); ajv.addSchema(auth); ajv.addSchema(schema);
  const validateRequest = ajv.compile({ $ref: schema.$id + '#/definitions/ChatControlRequest' });
  const validateResponse = ajv.compile({ $ref: schema.$id + '#/definitions/ChatControlResponse' });
  assert.equal(validateRequest(request), true);
  assert.equal(validateRequest({ ...request, userId: '__quarantine__' }), false);
  assert.equal(validateResponse(await fixture().control.invoke('admin-chats-pause', request)), true);
  assert.equal(validateResponse({ status: 200, body: { paused: true, state: 'resumed' }, setCookies: [] }), false);
});
