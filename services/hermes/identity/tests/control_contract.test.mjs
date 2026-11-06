// ABOUTME: Сверяет машинные контракты identity control с реальными обработчиками.
// ABOUTME: Проверяет схемы, NATS subjects, ссылки и безопасные ошибки без внешних сервисов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import yaml from 'js-yaml';
import { Control, controlSubjects, respondControl, handlePrivateRpc } from '../control.mjs';

const root = new URL('../', import.meta.url);
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const schema = await json('schemas/control.schema.json');
const auth = await json('../../auth/schemas/messages.schema.json');
const rpc = await json('control.openrpc.json');
const asyncapi = await readFile(new URL('asyncapi.yaml', root), 'utf8');
const ajv = new Ajv({ strict: false });
ajv.addSchema(auth); ajv.addSchema(schema);

test('AsyncAPI parses and declares exact subjects and valid references', () => {
  const api = yaml.load(asyncapi);
  assert.equal(api.asyncapi, '3.0.0');
  const actual = Object.values(api.channels).map(channel => channel.address).filter(Boolean).sort();
  assert.deepEqual(actual, Object.values(controlSubjects).sort());
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) {
      const ref = node.$ref;
      let target;
      if (ref.startsWith('./schemas/control.schema.json#/definitions/')) target = schema.definitions[ref.split('/').at(-1)];
      else if (ref.startsWith('#/')) target = ref.slice(2).split('/').reduce((value, key) => value?.[key], api);
      assert.notEqual(target, undefined, ref);
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(api);
  assert.equal(Object.keys(api.operations).length, 7);
});

test('admin schemas accept actual success and reject wrong fields', async () => {
  const headers = { cookie: 'a=b', origin: 'https://example.test' };
  const profile = { userId: 'u', profileId: 'p', status: 'active' };
  const control = new Control({ origin: headers.origin, cursorKey: 'x'.repeat(32),
    registry: async () => ({ version: 1, profiles: { '1001': profile } }),
    authCall: async op => op === 'session' ? { status: 200, body: { user: { role: 'admin', status: 'active' }, session: {} } } : { status: 200 },
    memoryRead: async () => ({ items: [{ id:'i',kind:'memory',text:'text',cubeId:'c',createdAt:null,profileId:'p' }], nextCursor: null }),
    chatRead: async ({ operation }) => operation.endsWith('list') ? { items:[{id:'c',title:'chat',updatedAt:'2026-01-01T00:00:00Z'}],nextCursor:null } : { messages:[{id:'1',role:'user',text:'text',createdAt:'2026-01-01T00:00:00Z'}],nextCursor:null } });
  const cases = [
    ['admin-memory-list', 'MemoryList', {headers,userId:'u'}],
    ['admin-chats-list', 'ChatsList', {headers,userId:'u'}],
    ['admin-chats-get', 'ChatsGet', {headers,userId:'u',chatId:'c'}],
  ];
  for (const [operation, def, request] of cases) {
    const validateRequest = ajv.getSchema(schema.$id + '#/definitions/' + def + 'Request');
    const validateResponse = ajv.getSchema(schema.$id + '#/definitions/' + def + 'Response');
    assert.equal(validateRequest(request), true, JSON.stringify(validateRequest.errors));
    const reply = await control.invoke(operation, request);
    assert.equal(validateResponse(reply), true, JSON.stringify(validateResponse.errors));
    assert.equal(validateRequest({ ...request, ownerId:'spoof' }), false);
  }
});

test('service replies carry only permitted NATS errors', () => {
  const calls = [];
  const msg = { respond: data => calls.push(['ok', JSON.parse(data)]), respondError: (status, name) => calls.push([status, name]) };
  respondControl(msg, { status: 403, body: { error: 'FORBIDDEN' }, setCookies: [] });
  respondControl(msg, { status: 503, body: { error: 'SECRET_DETAIL' } });
  respondControl(msg, { status: 200, body: {}, setCookies: [] });
  assert.deepEqual(calls, [[403,'FORBIDDEN'], [503,'UNAVAILABLE'], ['ok',{status:200,body:{},setCookies:[]}]]);
});

test('OpenRPC inventory and references match private methods', async () => {
  assert.equal(rpc.openrpc, '1.3.2');
  assert.deepEqual(rpc.methods.map(item => item.name).sort(), [
    'identity.resolve','identity.invite-redeem','identity.profile-ready','authorize','identity.revalidate','login.send',
    'tools.list','tools.call','files.configuration','files.get','files.list','files.prepare','artifacts.publish','artifacts.fetch'
  ].sort());
  const visit = async (node, base, document) => {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) {
      const [file, pointer] = node.$ref.split('#');
      const target = file ? await json(new URL(file, base).href) : document;
      const value = (pointer ?? '').split('/').slice(1).reduce((part, key) => part?.[key.replaceAll('~1','/').replaceAll('~0','~')], target);
      assert.notEqual(value, undefined, node.$ref);
    }
    for (const value of Object.values(node)) await visit(value, base, document);
  };
  await visit(rpc, new URL('control.openrpc.json', root), rpc);
  const method = rpc.methods.find(item => item.name === 'identity.resolve');
  assert.equal(method.result.schema.$ref, '../../auth/schemas/messages.schema.json#/definitions/TelegramResolveResponse');
  const reply = await handlePrivateRpc({ control:{}, authCall:async()=>({user:null}), registry:async()=>({}) }, {jsonrpc:'2.0',id:'r',method:'identity.resolve',params:{telegramId:'42'}});
  assert.deepEqual(reply.result, { user:null });
});

test('artifact descriptor response validates the single shared schema', async () => {
  const request = { headers: { cookie: 'a=b', origin: 'https://example.test' }, userId: 'u',
    artifactId: '9b8d327b-8c3e-47ca-89e1-fd8126757bd1' };
  const c = new Control({ origin: request.headers.origin, cursorKey: 'x'.repeat(32),
    registry: async () => ({ version: 1, profiles: { '1001': { userId: 'u', status: 'active' } } }),
    authCall: async op => op === 'session' ? { status: 200, body: { user: { role: 'admin', status: 'active' }, session: {} } } : { status: 200 },
    artifactsCall: async ({ id }) => ({ artifactId:id, filename:'file', mimeType:'text/plain', sizeBytes:67108864, sha256:'a'.repeat(64) }) });
  const req = ajv.getSchema(schema.$id + '#/definitions/ArtifactsDownloadRequest');
  const res = ajv.getSchema(schema.$id + '#/definitions/ArtifactsDownloadResponse');
  assert.equal(req(request), true, JSON.stringify(req.errors));
  const result = await c.invoke('admin-artifacts-download', request);
  assert.equal(res(result), true, JSON.stringify(res.errors));
  result.body.internalUrl = 'http://private/files/x';
  assert.equal(res(result), false);
});

test('reserved archive target is valid only in existing administrative request schemas', () => {
  for (const [name, extra] of [
    ['MemoryList', {}], ['MemoryGet', { memoryId: 'm' }],
    ['ChatsList', {}], ['ChatsGet', { chatId: 'c' }],
    ['ArtifactsList', {}], ['ArtifactsGet', { artifactId: 'a' }], ['ArtifactsDownload', { artifactId: 'a' }],
  ]) {
    const validate = ajv.getSchema(schema.$id + '#/definitions/' + name + 'Request');
    assert.equal(validate({ headers: { cookie: 'a=b', origin: 'https://example.test' }, userId: '__quarantine__', ...extra }), true,
      JSON.stringify(validate.errors));
    assert.equal(validate({ headers: { cookie: 'a=b', origin: 'https://example.test' }, userId: '__quarantine__', ...extra, home: '/etc' }), false);
  }
});
