// ABOUTME: Проверяет image команды, модели и отсутствие media в display.
// ABOUTME: Использует fake native порт и локальный WebSocket без аккаунта и inference.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import Ajv from 'ajv';
import nativeSchema from '../contracts/codex/schema.json' with { type: 'json' };
import publicSchema from '../schemas/messages.schema.json' with { type: 'json' };
import { limits, bytes, validateCommand, commandSchema } from '../contracts/index.mjs';
import { createApplication } from '../dist/application.js';
import { createCodex } from '../dist/codex.js';
import { display, compact } from '../dist/display.js';

const png = size => { const data = Buffer.alloc(size); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data); return `data:image/png;base64,${data.toString('base64')}`; };
const image = png(8);
const base = { action: 'start', projectId: 'p', threadId: 't', generation: 'g', operationId: 'o' };
const ajv = new Ajv({ strict: false, validateFormats: false });
ajv.addSchema(nativeSchema, 'native');
ajv.addSchema(publicSchema, 'public');
const native = type => ajv.compile({ $ref: `native#/definitions/${type}` });
const models = [{ model: 'vision' }, { model: 'text-only', inputModalities: ['text'] }, { model: 'explicit', inputModalities: ['text', 'image'] }].map(m => ({ ...m, displayName: m.model, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }] }));
function fixture() {
  const calls = [], events = [];
  let observer, operation = 0, hook;
  const port = {
    status: () => ({ generation: 'g', connection: 'connected', authorization: 'ready' }),
    subscribe: fn => { observer = fn; return () => {}; },
    call: async (method, params) => {
      if (method === 'account/rateLimits/read') return { rateLimits: null };
      calls.push({ method, params });
      await hook?.(method, params);
      if (method === 'model/list') return { data: models };
      if (method === 'thread/start') return { thread: { id: 't', model: params.model ?? 'vision', status: { type: 'idle' }, updatedAt: 1 }, model: params.model ?? 'vision' };
      if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress' } };
      if (method === 'turn/steer') return { turnId: 'turn' };
      throw new Error(method);
    },
  };
  const app = createApplication(port, { projects: [{ projectId: 'p', name: 'P', cwd: '/tmp/p' }], allowedModels: models.map(m => m.model), newThread: { model: 'vision' } }, e => events.push(e));
  const command = (action, extra = {}) => { const value = { ...base, action, operationId: `o${++operation}`, ...extra }; if (action === 'create') delete value.threadId; return value; };
  return { app, calls, events, command, setHook: fn => { hook = fn; }, observe: (method, params) => observer({ type: 'notification', method, params: { threadId: 't', ...params } }) };
}

test('validator and both JSON schemas agree on image/text structure and canonical base64', () => {
  assert.deepEqual(publicSchema.definitions.Command.oneOf, commandSchema.oneOf);
  const validators = [ajv.compile(commandSchema), ajv.compile({ $ref: 'public#/definitions/Command' })];
  const cases = [
    [{ text: 'hello' }, true], [{ images: [image] }, true], [{ text: '', images: [image] }, true],
    [{ text: '  ', images: [image, image] }, true], [{}, false], [{ text: '' }, false], [{ text: '\n \t\uFEFF' }, false],
    [{ text: 'a'.repeat(65537) }, false], [{ images: [] }, false], [{ images: Array(9).fill(image) }, false],
    [{ images: [42] }, false], [{ images: ['https://example.com/image.png'] }, false], [{ images: ['/tmp/image.png'] }, false],
    [{ images: ['data:image/svg+xml;base64,AAAA'] }, false], [{ images: ['data:image/png;base64,'] }, false],
    [{ images: ['data:image/png;base64,YQ'] }, false], [{ images: ['data:image/png;base64,YR=='] }, false],
    [{ images: ['data:image/png;base64,YWF='] }, false], [{ images: ['data:image/png;base64,YQ==\n'] }, false],
    [{ images: ['data:image/png;base64,YQ=='] }, true], [{ images: ['data:image/png;base64,YWE='] }, true],
    [{ images: [image], model: 'vision', cwd: '/other' }, false],
  ];
  for (const action of ['start', 'steer']) for (const [extra, expected] of cases) {
    const value = { ...base, action, ...(action === 'steer' ? { expectedTurnId: 'turn' } : {}), ...extra };
    assert.equal(validateCommand(value), expected);
    for (const validate of validators) assert.equal(validate(value), expected, JSON.stringify(validate.errors));
  }
  assert.equal(validateCommand({ ...base, text: 'x', images: undefined }), true);
  assert.equal(validateCommand({ ...base, action: 'interrupt', turnId: 'turn', images: [image] }), false);
});

test('catalog publishes native modalities and Brai count without invented model limits', async () => {
  const f = fixture(), catalog = await f.app.request({ action: 'models' });
  assert.deepEqual(catalog.data.map(m => [m.inputModalities, m.imageLimit]), [[['text', 'image'], 8], [['text'], 0], [['text', 'image'], 8]]);
  assert.ok(ajv.compile({ $ref: 'public#/definitions/Models' })(catalog));
});

test('image-only start/steer use native URL union; repeats retain one effect and distinguish images', async () => {
  const f = fixture(); await f.app.request(f.command('create'));
  const command = f.command('start', { images: [image] });
  await Promise.all([f.app.request(command), f.app.request({ ...command })]);
  const started = f.calls.filter(c => c.method === 'turn/start');
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].params.input, [{ type: 'image', url: image }]);
  assert.ok(native('TurnStartParams')(started[0].params));
  await assert.rejects(f.app.request({ ...command, images: [png(9)] }), e => e.code === 'OPERATION_CONFLICT');
  await f.app.request(f.command('steer', { expectedTurnId: 'turn', text: '', images: [image] }));
  assert.ok(native('TurnSteerParams')(f.calls.at(-1).params));
  assert.deepEqual(f.calls.at(-1).params.input, [{ type: 'image', url: image }]);
  f.observe('item/completed', { turnId: 'turn', item: { id: 'u', type: 'userMessage', content: [{ type: 'image', url: image }] } });
  assert.equal(f.events.at(-1).event.snapshot.items[0].imageCount, 1);
  assert.equal(JSON.stringify(f.events).includes(image), false);
});

test('decoded aggregate budget and MIME signatures fail before any native mutation', async () => {
  const f = fixture();
  for (const images of [[png(limits.imageBytes + 1)], [png(400000), png(300000)], ['data:image/png;base64,YQ=='], [image.replace('png', 'jpeg')], [image.replace('png', 'webp')]]) {
    await assert.rejects(f.app.request(f.command('start', { images })), e => e.code === 'INVALID_ARGUMENT' && e.outcome === 'not-sent');
    assert.equal(f.calls.length, 0);
  }
  await f.app.request(f.command('create'));
  await f.app.request(f.command('start', { images: [png(limits.imageBytes)] }));
  assert.equal(f.calls.at(-1).method, 'turn/start');
  assert.ok(bytes(f.calls.at(-1).params) < limits.input);
});

test('eight images fit the aggregate boundary; JPEG/WebP signatures and serialized bytes are enforced', async () => {
  const jpeg = 'data:image/jpeg;base64,' + Buffer.from([255, 216, 255, 224]).toString('base64');
  const webp = 'data:image/webp;base64,' + Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]).toString('base64');
  for (const images of [[jpeg, webp], Array(8).fill(png(limits.imageBytes / 8))]) {
    const f = fixture(); await f.app.request(f.command('create'));
    await f.app.request(f.command('start', { images }));
    assert.equal(f.calls.at(-1).params.input.length, images.length);
  }
  const f = fixture();
  const highBitWebp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]); highBitWebp[0] += 128;
  await assert.rejects(f.app.request(f.command('start', { images: ['data:image/webp;base64,' + highBitWebp.toString('base64')] })), e => e.code === 'INVALID_ARGUMENT');
  const overInput = { ...base, text: '\0'.repeat(65536), images: [png(limits.imageBytes)] };
  assert.ok(bytes(overInput) > limits.input); assert.ok(ajv.compile(commandSchema)(overInput));
  assert.equal(validateCommand(overInput), false);
  await assert.rejects(f.app.request(overInput), e => e.code === 'INVALID_ARGUMENT');
  assert.equal(f.calls.length, 0);
});

test('text-only models reject images for selected start and active steer without fallback', async () => {
  const f = fixture(); await f.app.request(f.command('create'));
  await assert.rejects(f.app.request(f.command('start', { model: 'text-only', images: [image] })), e => e.code === 'UNSUPPORTED' && e.outcome === 'not-sent');
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
  await f.app.request(f.command('start', { model: 'text-only', text: 'hello' }));
  await assert.rejects(f.app.request(f.command('steer', { expectedTurnId: 'turn', images: [image] })), e => e.code === 'UNSUPPORTED');
  assert.equal(f.calls.some(c => c.method === 'turn/steer'), false);
});

test('late catalogue result rechecks the steer turn and never sends to a completed turn', async () => {
  const f = fixture(); await f.app.request(f.command('create'));
  await f.app.request(f.command('start', { text: 'hello' }));
  f.setHook(method => { if (method === 'model/list') f.observe('turn/completed', { turn: { id: 'turn', status: 'completed' } }); });
  await assert.rejects(f.app.request(f.command('steer', { expectedTurnId: 'turn', images: [image] })), e => e.code === 'OPERATION_CONFLICT');
  assert.equal(f.calls.some(c => c.method === 'turn/steer'), false);
});

test('steer observes the selected active model before start result updates thread metadata', async () => {
  const f = fixture(); await f.app.request(f.command('create'));
  f.setHook(async method => {
    if (method !== 'turn/start') return;
    f.observe('turn/started', { turn: { id: 'turn', status: 'inProgress' } });
    await assert.rejects(f.app.request(f.command('steer', { expectedTurnId: 'turn', images: [image] })), e => e.code === 'UNSUPPORTED');
  });
  await f.app.request(f.command('start', { model: 'text-only', text: 'hello' }));
  assert.equal(f.calls.some(c => c.method === 'turn/steer'), false);
});

test('native image and localImage history exposes only count and text', () => {
  const item = { id: 'u', type: 'userMessage', content: [{ type: 'image', url: image }, { type: 'localImage', path: '/private/image.png' }, { type: 'text', text: 'look' }] };
  for (const value of [display(item, 'turn'), display(item, 'turn', true), compact(display(item, 'turn'))]) {
    assert.equal(value.imageCount, 2); assert.equal(value.text, 'look');
    assert.equal(JSON.stringify(value).includes('data:'), false); assert.equal(JSON.stringify(value).includes('/private/'), false);
    assert.ok(ajv.compile({ $ref: 'public#/definitions/DisplayItem' })(value));
  }
});

test('real local WebSocket validates image commands and restores >2 MiB raw page as compact history', async t => {
  const dir = mkdtempSync('/tmp/brai-images-'), socketPath = join(dir, 'native.sock');
  const server = createServer(), wss = new WebSocketServer({ server });
  wss.on('error', () => {}); // Ошибка listen обработана ниже; WSS также пересылает её.
  const calls = [], turn = { id: 'turn', status: 'inProgress', items: [] };
  const thread = { id: 't', cliVersion: 'test', createdAt: 1, cwd: '/tmp/p', ephemeral: false, model: 'vision', modelProvider: 'openai', preview: '', projectId: null, sessionId: 's', source: 'appServer', status: { type: 'active', activeFlags: [] }, turns: [], updatedAt: 1 };
  const response = { thread, model: 'vision', modelProvider: 'openai', cwd: '/tmp/p', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: { type: 'workspaceWrite' } };
  const bigImage = png(limits.imageBytes);
  const history = Array.from({ length: 10 }, (_, i) => ({ turnId: 'turn', item: { id: `u${i}`, type: 'userMessage', content: [{ type: 'image', url: bigImage }] } }));
  assert.ok(bytes({ data: history }) > 2097152 && bytes({ data: history }) < 16777216);
  wss.on('connection', socket => socket.on('message', raw => {
    const packet = JSON.parse(raw.toString()); calls.push(packet);
    if (!Object.hasOwn(packet, 'id')) return;
    const result = {
      initialize: { codexHome: '/tmp/mock', platformFamily: 'unix', platformOs: 'linux', userAgent: 'test' },
      'account/read': { account: { type: 'apiKey' }, requiresOpenaiAuth: false },
      'account/rateLimits/read': { rateLimits: {} },
      'model/list': { data: models.map((m, i) => ({ ...m, id: m.model, description: '', hidden: false, isDefault: i === 0 })) },
      'thread/start': response, 'thread/read': { thread }, 'thread/resume': response,
      'turn/start': { turn }, 'turn/steer': { turnId: 'turn' },
      'thread/turns/list': { data: [turn] }, 'thread/items/list': { data: history, nextCursor: null },
    }[packet.method];
    assert.ok(result, packet.method);
    if (packet.method === 'account/rateLimits/read') {
      const validateResult = native('GetAccountRateLimitsResponse');
      assert.equal(validateResult(result), true, JSON.stringify(validateResult.errors));
    }
    socket.send(JSON.stringify({ id: packet.id, result }));
  }));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  } catch (error) {
    await new Promise(resolve => wss.close(resolve)); rmSync(dir, { recursive: true });
    if (error.code === 'EPERM') { t.skip('Среда запрещает локальные Unix sockets'); return; }
    throw error;
  }
  const codex = createCodex({ socketUrl: `ws+unix:${socketPath}:/` });
  const app = createApplication(codex, { projects: [{ projectId: 'p', name: 'P', cwd: '/tmp/p' }], allowedModels: models.map(m => m.model), newThread: { model: 'vision' } }, () => {});
  try {
    await codex.connect();
    const generation = codex.status().generation;
    await app.request({ action: 'create', projectId: 'p', generation, operationId: 'create' });
    await app.request({ ...base, generation, images: [bigImage], operationId: 'start' });
    await app.request({ ...base, action: 'steer', generation, expectedTurnId: 'turn', images: [image], operationId: 'steer' });
    const sentStarts = calls.filter(c => c.method === 'turn/start').length;
    await assert.rejects(codex.call('turn/start', { threadId: 't', input: [{ type: 'image', url: bigImage.repeat(3) }] }, { mutation: true }), e => e.code === 'CAPACITY_EXHAUSTED' && e.outcome === 'not-sent');
    assert.equal(calls.filter(c => c.method === 'turn/start').length, sentStarts);
    const restoring = createApplication(codex, { projects: [{ projectId: 'p', name: 'P', cwd: '/tmp/p' }], allowedModels: models.map(m => m.model) }, () => {});
    try {
      const snapshot = await restoring.request({ action: 'open', projectId: 'p', threadId: 't' });
      const page = await restoring.request({ action: 'items', projectId: 'p', threadId: 't' });
      assert.equal(snapshot.items.length, 10); assert.equal(snapshot.items[0].imageCount, 1);
      assert.equal(page.data[0].imageCount, 1); assert.equal(bytes(snapshot) < limits.state, true);
      assert.equal(JSON.stringify([snapshot, page]).includes('data:image/'), false);
      assert.ok(calls.filter(c => c.method === 'thread/items/list').every(c => c.params.limit === 10));
    } finally { restoring.close(); }
  } finally {
    app.close(); await codex.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true });
  }
});


test('image detail rejects remote URLs, local paths and oversized media', () => {
  const native = content => ({ id: 'u', type: 'userMessage', content });
  const valid = display(native([{ type: 'image', url: image }]), 'turn', false, true);
  assert.deepEqual(valid.images, [image]);
  assert.equal(compact(valid).images, undefined);
  for (const content of [
    [{ type: 'image', url: 'https://example.com/x.png' }],
    [{ type: 'localImage', path: '/private/image.png' }],
    [{ type: 'image', url: 'data:image/svg+xml;base64,AAAA' }],
    [{ type: 'image', url: png(limits.imageBytes + 1) }],
  ]) assert.equal(display(native(content), 'turn', false, true).images, undefined);
  assert.ok(bytes(display(native([{ type: 'image', url: png(limits.imageBytes) }]), 'turn', false, true)) < limits.frame);
});
