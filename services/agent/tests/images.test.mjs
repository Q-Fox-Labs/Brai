// ABOUTME: Проверяет durable file references, native correlation и отсутствие media в публичных чтениях.
// ABOUTME: Native и artifacts заменены контрактными mock; inference и аккаунт не используются.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import Ajv from 'ajv';
import nativeSchema from '../contracts/codex/schema.json' with { type: 'json' };
import publicSchema from '../schemas/messages.schema.json' with { type: 'json' };
import artifactSchemas from '../../artifacts/schemas/messages.schema.json' with { type: 'json' };
import { subjects as artifactSubjects, validateRequest, validateResponse } from '../../artifacts/contracts/index.mjs';
import { validateCommand, commandSchema, limits } from '../contracts/index.mjs';
import { createApplication } from '../dist/application.js';
import { createAttachments, createArtifactsPort } from '../dist/attachments.js';
import { createCodex } from '../dist/codex.js';
import { display, messagePage } from '../dist/display.js';
const uuid = '11111111-1111-4111-8111-111111111111', copy = '22222222-2222-4222-8222-222222222222';
const pair = { originalArtifactId: uuid, modelArtifactId: uuid };
const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const image = `data:image/png;base64,${data.toString('base64')}`;
const base = { action: 'start', ownerId: 'owner', projectId: 'p', threadId: 't', generation: 'g', operationId: 'o', attachments: [pair] };
const ajv = new Ajv({ strict: false, validateFormats: false, schemas: [artifactSchemas] });
ajv.addSchema(nativeSchema, 'native'); ajv.addSchema(publicSchema, 'public');
ajv.addSchema(artifactSchemas, '../../artifacts/schemas/messages.schema.json');
const native = name => ajv.compile({ $ref: `native#/definitions/${name}` });
function fixture() {
  const calls = [], events = [], refs = new Map(), artifacts = new Map(); let history = [], observer, hook, generation = 'g', lostReserve = false, lostNative = false, persist = true, next = null;
  const artifact = id => ({ artifactId: id, ownerId: 'owner', requestId: id, kind: id === uuid ? 'original' : 'copy', status: 'ready', title: 'picture', filename: 'private.png', extension: 'png', mimeType: 'image/png', source: 'agent', details: { projectId: 'p', threadId: 't' }, sizeBytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), internalUrl: `http://artifacts/files/${id}`, createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' });
  artifacts.set(uuid, artifact(uuid)); artifacts.set(copy, artifact(copy));
  const key = scope => [scope.ownerId, scope.projectId, scope.threadId, scope.operationId].join('\0');
  const error = (code, outcome = 'query') => Object.assign(new Error(code), { code, outcome });
  const artifactPort = { fetch: async () => new Response(data, { headers: { 'content-type': 'application/octet-stream' } }), request: async (subject, value) => {
    assert.ok(validateRequest(subject, value), `${subject} request`); let out;
    if (subject === artifactSubjects.get) { const found = artifacts.get(value.artifactId); if (!found) throw error('NOT_FOUND'); out = structuredClone(found); }
    else if (subject === artifactSubjects.relationList) out = { items: [{ originalArtifactId: uuid, modelArtifactId: copy, createdAt: '2026-10-05T00:00:00Z' }] };
    else if (subject === artifactSubjects.referenceList) out = { items: [...refs.values()].filter(ref => ref.state === 'confirmed' && ref.scope.ownerId === value.scope.ownerId && ref.scope.projectId === value.scope.projectId && ref.scope.threadId === value.scope.threadId && value.nativeItemIds.includes(ref.itemId)) };
    else {
      const id = key(value.scope), old = refs.get(id);
      if (subject === artifactSubjects.referenceReserve) {
        if (old && (old.commandHash !== value.commandHash || old.clientUserMessageId !== value.clientUserMessageId || JSON.stringify(old.attachments) !== JSON.stringify(value.attachments))) throw error('OPERATION_CONFLICT');
        const ref = old ?? { ...structuredClone(value), state: 'pending', createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z' }; refs.set(id, ref); out = { created: !old, reference: ref }; if (lostReserve) { lostReserve = false; throw error('TIMEOUT'); }
      } else { if (!old) throw error('NOT_FOUND');
        if (subject === artifactSubjects.referenceConfirm) { assert.equal(value.clientUserMessageId, old.clientUserMessageId); if (old.state === 'confirmed' && (value.turnId !== old.turnId || value.itemId !== old.itemId)) throw error('OPERATION_CONFLICT'); Object.assign(old, { state: 'confirmed', turnId: value.turnId, itemId: value.itemId }); }
        if (subject === artifactSubjects.referenceUpdateState && old.state !== 'confirmed') old.state = value.state;
        out = { reference: old };
      }
    }
    assert.ok(validateResponse(subject, out), `${subject} response`); return structuredClone(out);
  } };
  const thread = { id: 't', cliVersion: 'test', createdAt: 1, cwd: '/tmp/p', ephemeral: false, model: 'vision', modelProvider: 'openai', preview: '', projectId: null, sessionId: 's', source: 'appServer', status: { type: 'active', activeFlags: [] }, turns: [], updatedAt: 1 };
  const response = { thread, model: 'vision', modelProvider: 'openai', cwd: '/tmp/p', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: { type: 'workspaceWrite' } };
  const turn = { id: 'turn', status: 'inProgress', items: [] };
  const port = { status: () => ({ generation, connection: 'connected', authorization: 'ready' }), subscribe: fn => { observer = fn; return () => {}; }, call: async (method, params) => {
    calls.push({ method, params }); await hook?.(method, params);
    if (method === 'turn/start' || method === 'turn/steer') { assert.ok(native(method === 'turn/start' ? 'TurnStartParams' : 'TurnSteerParams')(params)); if (persist) history.push({ turnId: 'turn', item: { id: `u${history.length}`, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input } }); if (lostNative) throw error('TIMEOUT', 'unknown'); return method === 'turn/start' ? { turn } : { turnId: 'turn' }; }
    if (method === 'thread/items/list') {
      const visible = history.filter(entry => !params.turnId || entry.turnId === params.turnId);
      let items = params.sortDirection === 'asc' ? visible.slice() : visible.slice().reverse();
      if (params.cursor?.type === 'item') items = items.slice(items.findIndex(entry => entry.item.id === params.cursor.itemId) + 1);
      const offset = typeof params.cursor === 'string' && params.cursor.startsWith('page:') ? Number(params.cursor.slice(5)) : 0;
      return { data: items.slice(offset, offset + params.limit), nextCursor: next ?? (offset + params.limit < items.length ? `page:${offset + params.limit}` : null) };
    }
    return { 'account/rateLimits/read': { rateLimits: null }, 'model/list': { data: [{ id: 'vision', model: 'vision', displayName: 'Vision', description: '', hidden: false, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }] }] }, 'thread/start': response, 'thread/resume': response, 'thread/read': { thread }, 'thread/goal/get': { goal: null }, 'thread/turns/list': { data: [turn] } }[method] ?? (() => { throw new Error(method); })();
  } };
  const config = { codex: { socketUrl: 'mock' }, projects: [{ projectId: 'p', name: 'P', cwd: '/tmp/p' }], newThread: { model: 'vision' }, allowedModels: ['vision'], artifacts: { baseUrl: 'http://artifacts' } };
  let app = createApplication(port, config, e => events.push(e), artifactPort);
  const read = (action, extra = {}) => app.request({ action, projectId: 'p', threadId: 't', ownerId: 'owner', ...extra });
  return { get app() { return app; }, port, config, artifactPort, calls, events, refs, artifacts, read, setHistory: value => { history = value; }, history: () => history, observe: (method, params) => observer({ type: 'notification', method, params: { threadId: 't', ...params } }), setHook: value => { hook = value; }, lostReserve: () => { lostReserve = true; }, lostNative: () => { lostNative = true; }, noPersist: () => { persist = false; }, incomplete: () => { next = 'same'; }, restart: () => { app.close(); generation = 'g2'; app = createApplication(port, config, e => events.push(e), artifactPort); return { ...base, generation }; }, create: () => app.request({ action: 'create', projectId: 'p', generation, operationId: 'create' }) };
}
test('acknowledged image input confirms its whole exact turn despite thousands of older items', async () => {
  const f = fixture(); await f.create();
  f.setHistory(Array.from({ length: 2500 }, (_, i) => ({ turnId: 'old-turn', item: { id: `old-${i}`, type: 'userMessage', clientId: `old-client-${i}`, content: [{ type: 'text', text: 'old' }] } })));
  const from = f.calls.length;
  const accepted = await f.app.request(base);
  assert.equal(accepted.outcome, 'accepted');
  assert.equal([...f.refs.values()][0].itemId, 'u2500');
  const correlation = f.calls.slice(from).filter(call => call.method === 'thread/items/list');
  assert.equal(correlation.length, 1);
  assert.equal(correlation[0].params.turnId, 'turn');
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  f.app.close();
});

test('ACK turn correlation completes pagination and rejects duplicates or an incomplete turn', async () => {
  for (const mode of ['unique', 'duplicate', 'incomplete']) {
    const f = fixture(); await f.create();
    f.setHistory(Array.from({ length: 24 }, (_, i) => ({ turnId: 'turn', item: { id: `earlier-${i}`, type: 'userMessage', clientId: mode === 'duplicate' && i === 0 ? 'brai:agent:v3:o' : `earlier-client-${i}`, content: [] } })));
    if (mode === 'incomplete') f.incomplete();
    if (mode === 'unique') {
      assert.equal((await f.app.request(base)).outcome, 'accepted');
      assert.equal(f.calls.filter(call => call.method === 'thread/items/list').length, 3);
    } else {
      await assert.rejects(f.app.request(base), error => error.outcome === 'unknown');
      assert.notEqual([...f.refs.values()][0].state, 'confirmed');
    }
    assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
    f.app.close();
  }
});

test('lost native ACK retains whole-thread uniqueness, including another turn, without resend', async () => {
  const f = fixture(); await f.create(); f.lostNative();
  await assert.rejects(f.app.request(base), error => error.outcome === 'unknown');
  f.setHistory([...f.history(), { turnId: 'another-turn', item: { ...f.history()[0].item, id: 'duplicate-in-another-turn' } }]);
  const replay = f.restart();
  await assert.rejects(f.app.request(replay), error => error.outcome === 'unknown');
  assert.notEqual([...f.refs.values()][0].state, 'confirmed');
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  f.app.close();
});

test('a complete acknowledged turn with more than 1000 items still confirms exact input', async () => {
  const f = fixture(); await f.create();
  f.setHistory(Array.from({ length: 1205 }, (_, i) => ({ turnId: 'turn', item: { id: `earlier-${i}`, type: 'userMessage', clientId: `earlier-client-${i}`, content: [] } })));
  assert.equal((await f.app.request(base)).outcome, 'accepted');
  const pages = f.calls.filter(call => call.method === 'thread/items/list');
  assert.equal(pages.length, 121);
  assert.ok(pages.every(call => call.params.turnId === 'turn'));
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  f.app.close();
});

test('lost ACK recovery enumerates long history and refuses a distant duplicate or absent exact key', async () => {
  for (const mode of ['unique', 'duplicate', 'absent']) {
    const f = fixture(); await f.create(); f.lostNative();
    await assert.rejects(f.app.request(base), error => error.outcome === 'unknown');
    const sent = f.history()[0];
    const old = Array.from({ length: 1205 }, (_, i) => ({ turnId: 'old-turn', item: { id: `old-${i}`, type: 'userMessage', clientId: mode === 'duplicate' && i === 0 ? sent.item.clientId : `old-client-${i}`, content: [] } }));
    f.setHistory([...old, mode === 'absent' ? { ...sent, item: { ...sent.item, clientId: 'different-key' } } : sent]);
    const attachments = createAttachments(f.port, f.config.artifacts, f.artifactPort), before = f.calls.length;
    const recovered = await attachments.recover([...f.refs.values()][0]);
    assert.equal(recovered.state, mode === 'unique' ? 'confirmed' : 'unknown');
    const pages = f.calls.slice(before).filter(call => call.method === 'thread/items/list');
    assert.equal(pages.length, 121);
    assert.ok(pages.every(call => !call.params.turnId));
    assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
    f.app.close();
  }
});

test('recovery cap and elapsed deadline leave unknown without confirmation or native resend', async () => {
  const f = fixture(); await f.create(); f.lostNative();
  await assert.rejects(f.app.request(base), error => error.outcome === 'unknown');
  f.setHistory([...Array.from({ length: 10005 }, (_, i) => ({ turnId: 'old-turn', item: { id: `old-${i}`, type: 'userMessage', clientId: `old-client-${i}`, content: [] } })), ...f.history()]);
  const attachments = createAttachments(f.port, f.config.artifacts, f.artifactPort), reference = [...f.refs.values()][0], before = f.calls.length;
  assert.equal((await attachments.recover(reference)).state, 'unknown');
  assert.equal(f.calls.slice(before).filter(call => call.method === 'thread/items/list').length, 1000);
  assert.notEqual(reference.state, 'confirmed');
  f.setHistory(f.history().slice(-1));
  f.setHook(async method => { if (method === 'thread/items/list') await new Promise(resolve => setTimeout(resolve, 30)); });
  await assert.rejects(attachments.recover(reference, performance.now() + 10), error => error.code === 'TIMEOUT');
  assert.notEqual(reference.state, 'confirmed');
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  f.app.close();
});

test('closed v3 DTO and owner schemas reject raw media, invalid UUIDs and excess attachments', () => {
  assert.deepEqual(publicSchema.definitions.Command.oneOf, commandSchema.oneOf);
  const schema = ajv.compile(commandSchema);
  for (const value of [base, { ...base, text: '' }, { ...base, action: 'steer', expectedTurnId: 'turn' }, { ...base, attachments: undefined, text: 'hello' }]) { assert.equal(validateCommand(value), true); assert.equal(schema(value), true, JSON.stringify(schema.errors)); }
  for (const extra of [{ images: [image] }, { attachments: [] }, { attachments: Array(9).fill(pair) }, { ownerId: undefined }, { attachments: [{ ...pair, url: image }] }, { attachments: [{ ...pair, modelArtifactId: 'bad' }] }, { attachments: [{ ...pair, modelArtifactId: '00000000-0000-0000-0000-000000000000' }] }, { agentMode: 'goal' }]) { const value = { ...base, ...extra }; assert.equal(validateCommand(value), false); assert.equal(schema(value), false); }
});
test('image-only start and steer are native-valid; reserve is durable and RPC projections use owner metadata', async () => {
  const f = fixture(); await f.create(); await Promise.all([f.app.request(base), f.app.request(base)]);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1); assert.deepEqual(f.calls.find(call => call.method === 'turn/start').params.input, [{ type: 'image', url: image }]);
  await f.app.request({ ...base, action: 'steer', expectedTurnId: 'turn', operationId: 'steer', attachments: [{ originalArtifactId: uuid, modelArtifactId: copy }] });
  const items = await f.read('items'); assert.equal(items.data[0].attachments[0].filename, 'private.png'); assert.match(items.data[0].attachments[0].url, /expectedUserId=owner/);
  assert.equal(JSON.stringify(items).includes(image), false); const other = await f.read('items', { ownerId: 'other' }); assert.equal(JSON.stringify(other).includes('private.png'), false);
  const detail = await f.read('item', { turnId: 'turn', itemId: 'u0' }); assert.equal(detail.item.attachments[0].status, 'ready');
  const activities = await f.read('activities', { turnId: 'turn', itemIds: ['u0'] }); assert.equal(activities.data[0].attachments[0].status, 'ready');
  f.observe('item/completed', { turnId: 'turn', item: f.history()[0].item }); assert.equal(JSON.stringify(f.events).includes('private.png'), false); assert.equal(JSON.stringify(f.events).includes(image), false);
  const reopened = f.restart(); const open = await f.read('open'); assert.equal(open.items[0].attachments[0].status, 'ready'); await f.app.request(reopened); assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  f.artifacts.get(uuid).source = 'edited'; f.artifacts.get(uuid).details = { projectId: 'edited', threadId: 'edited' }; f.artifacts.get(uuid).filename = 'renamed.png';
  const edited = (await f.read('items')).data[0].attachments[0]; assert.equal(edited.status, 'ready'); assert.equal(edited.filename, 'renamed.png'); assert.match(edited.url, /itemId=u0/); assert.match(edited.url, /turnId=turn/);
  f.artifacts.get(uuid).status = 'deleted'; f.artifacts.get(uuid).deletedAt = '2026-10-05T00:00:00Z'; delete f.artifacts.get(uuid).internalUrl;
  assert.equal((await f.read('items')).data[0].attachments[0].status, 'deleted'); await assert.rejects(f.app.request({ ...reopened, text: 'changed' }), e => e.code === 'OPERATION_CONFLICT' || e.outcome === 'unknown');
  const deletedReplay = f.restart(); await assert.rejects(f.app.request({ ...deletedReplay, text: 'changed' }), e => e.outcome === 'unknown');
  f.app.close();
});
test('owner/scope, missing/deleted, count, decoded budget, MIME signature and copied relation fail before native send', async () => {
  for (const mutate of [f => f.artifacts.get(uuid).ownerId = 'other', f => f.artifacts.get(uuid).details.threadId = 'other', f => f.artifacts.get(uuid).source = 'other', f => f.artifacts.delete(uuid), f => { f.artifacts.get(uuid).status = 'deleted'; delete f.artifacts.get(uuid).internalUrl; }, f => f.artifacts.get(uuid).sizeBytes = limits.imageBytes + 1, f => f.artifacts.get(uuid).mimeType = 'image/svg+xml', f => f.artifactPort.fetch = async () => new Response(Buffer.alloc(8), { headers: { 'content-type': 'image/png' } }), f => f.artifactPort.fetch = async () => new Response(Buffer.alloc(limits.imageBytes + 1), { headers: { 'content-type': 'image/png' } }), f => f.artifacts.get(uuid).internalUrl = 'http://other/files/' + uuid]) {
    const f = fixture(); await f.create(); mutate(f); await assert.rejects(f.app.request(base)); assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 0); f.app.close();
  }
});
test('lost reserve response and pending restart never resend; exact native history recovers unknown', async () => {
  const f = fixture(); await f.create(); f.lostReserve(); await assert.rejects(f.app.request(base), e => e.outcome === 'unknown'); const replay = f.restart(); await assert.rejects(f.app.request(replay), e => e.outcome === 'unknown'); assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 0);
  const reference = [...f.refs.values()][0]; f.setHistory([{ turnId: 'turn', item: { id: 'native', type: 'userMessage', clientId: reference.clientUserMessageId, content: [{ type: 'image', url: image }] } }]);
  assert.equal((await f.app.request(replay)).outcome, 'accepted'); assert.equal(reference.itemId, 'native'); f.app.close();
});
test('lost native result recovers after restart; no exact, duplicates and incomplete scan remain unknown', async () => {
  const f = fixture(); await f.create(); f.lostNative(); await assert.rejects(f.app.request(base), e => e.outcome === 'unknown'); const replay = f.restart(); assert.equal((await f.app.request(replay)).outcome, 'accepted'); assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1); f.app.close();
  for (const modify of [f => f.setHistory([]), f => f.setHistory([{ turnId: 'turn', item: { ...f.history()[0].item, clientId: 'wrong' } }]), f => f.setHistory([...f.history(), { turnId: 'turn', item: { ...f.history()[0].item, id: 'duplicate' } }]), f => f.incomplete()]) {
    const x = fixture(); await x.create(); x.lostNative(); await assert.rejects(x.app.request(base)); modify(x); await assert.rejects(x.app.request(x.restart()), e => e.outcome === 'unknown'); assert.equal(x.calls.filter(call => call.method === 'turn/start').length, 1); assert.equal([...x.refs.values()][0].state, 'unknown'); x.app.close();
  }
});

test('persisted native operation ID confirms input without exposing another owner attachments', async () => {
  const f = fixture(); await f.create(); f.lostNative();
  await assert.rejects(f.app.request(base), error => error.outcome === 'unknown');
  const reply = await f.read('items');
  assert.equal(reply.data[0].operationId, base.operationId);
  assert.ok(ajv.compile({ $ref: 'public#/definitions/DisplayItem' })(reply.data[0]));
  const foreign = await f.app.request({ action: 'items', ownerId: 'other', projectId: 'p', threadId: 't' });
  assert.equal(foreign.data[0].operationId, base.operationId);
  assert.equal(foreign.data[0].attachments, undefined);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
  f.app.close();
  const incomplete = fixture(); await incomplete.create(); incomplete.lostNative();
  await assert.rejects(incomplete.app.request(base)); incomplete.incomplete();
  const helper = createAttachments(incomplete.port, incomplete.config.artifacts, incomplete.artifactPort);
  assert.equal((await helper.decorate(base, [{ id: 'u0', turnId: 'turn', type: 'userMessage', text: '' }]))[0].operationId, undefined);
  incomplete.app.close();
});
test('legacy raw URLs, local paths and images stay absent in every display/page/read projection', async () => {
  const f = fixture(), item = { id: 'legacy', type: 'userMessage', content: [{ type: 'text', text: 'hello' }, { type: 'image', url: image }, { type: 'localImage', path: '/private/local.png' }] }; f.setHistory([{ turnId: 'turn', item }]);
  for (const result of [display(item, 'turn'), messagePage(item, 'turn'), await f.read('open'), await f.read('items'), await f.read('item', { turnId: 'turn', itemId: 'legacy' }), await f.read('activities', { turnId: 'turn', itemIds: ['legacy'] })]) { assert.equal(JSON.stringify(result).includes(image), false); assert.equal(JSON.stringify(result).includes('/private/local.png'), false); }
  assert.equal((await f.read('item', { turnId: 'turn', itemId: 'legacy' })).item.imageCount, 2); assert.equal(f.refs.size, 0);
  f.artifactPort.request = async () => { throw new Error('offline'); }; assert.equal((await f.read('items')).data[0].attachmentsState, 'unavailable'); f.app.close();
});
test('two independent agents concurrent reserve permit only one native start', async () => {
  const f = fixture(); await f.create(); const second = createApplication(f.port, f.config, () => {}, f.artifactPort);
  const results = await Promise.allSettled([f.app.request(base), second.request(base)]); assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1); assert.ok(results.some(result => result.status === 'fulfilled')); f.app.close(); second.close();
});
test('model modality, aggregate decoded cap and MIME signature reject before reserve/send', async () => {
  const f = fixture(); await f.create(); const originalCall = f.port.call;
  f.port.call = async (method, params) => { const value = await originalCall(method, params); if (method === 'model/list') value.data[0].inputModalities = ['text']; return value; };
  await assert.rejects(f.app.request(base), e => e.code === 'UNSUPPORTED' && e.outcome === 'not-sent'); assert.equal(f.refs.size, 0); f.app.close();
  for (const signatureValid of [true, false]) {
    const x = fixture(); await x.create(); const bytes = signatureValid ? Buffer.alloc(limits.imageBytes) : Buffer.alloc(8); if (signatureValid) data.copy(bytes);
    const artifact = x.artifacts.get(uuid); artifact.sizeBytes = bytes.length; artifact.sha256 = createHash('sha256').update(bytes).digest('hex'); x.artifactPort.fetch = async () => new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    await assert.rejects(x.app.request({ ...base, attachments: signatureValid ? [pair, pair] : [pair] }), e => e.outcome === 'not-sent'); assert.equal(x.refs.size, 0); assert.equal(x.calls.filter(call => call.method === 'turn/start').length, 0); x.app.close();
  }
});
test('unresolved new exact clientId is unavailable rather than legacy, and not-sent never resends', async () => {
  const f = fixture(); await f.create(); f.lostNative(); await assert.rejects(f.app.request(base)); f.incomplete(); const replay = f.restart();
  const item = (await f.read('open')).items[0]; assert.equal(item.attachmentsState, 'unavailable'); assert.equal(item.attachments, undefined); await assert.rejects(f.app.request(replay), e => e.outcome === 'unknown'); assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1); f.app.close();
  const x = fixture(); await x.create(); x.setHook(method => { if (method === 'turn/start') throw Object.assign(new Error('capacity'), { code: 'CAPACITY_EXHAUSTED', outcome: 'not-sent' }); });
  await assert.rejects(x.app.request(base), e => e.outcome === 'not-sent'); assert.equal([...x.refs.values()][0].state, 'not-sent'); const notSentReplay = x.restart(); await assert.rejects(x.app.request(notSentReplay), e => e.outcome === 'not-sent'); assert.equal(x.calls.filter(call => call.method === 'turn/start').length, 1); x.app.close();
});
test('slow multiattachment NATS reads share one model phase budget and never reserve/send late', async () => {
  const f = fixture(); f.config.artifacts.timeoutMs = 100; const command = f.restart(); await f.create();
  const timeouts = [], transport = createArtifactsPort({ request: async (subject, raw, options) => {
    const value = JSON.parse(Buffer.from(raw).toString()); const delay = subject === artifactSubjects.get ? 45 : 0;
    timeouts.push(options.timeout);
    await new Promise((resolve, reject) => setTimeout(() => options.timeout < delay ? reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })) : resolve(), Math.min(delay, options.timeout)));
    return { data: Buffer.from(JSON.stringify(await f.artifactPort.originalRequest(subject, value))) };
  } }, 100);
  f.artifactPort.originalRequest = f.artifactPort.request; f.artifactPort.request = transport.request;
  const start = performance.now(); await assert.rejects(f.app.request({ ...command, attachments: Array(8).fill(pair) }), e => e.outcome === 'not-sent');
  assert.ok(performance.now() - start < 220); assert.ok(timeouts.at(-1) < 45); assert.equal(f.refs.size, 0);
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 0); f.app.close();
});
test('stalled HTTP body uses remaining phase budget; late metadata/generation cannot send', async () => {
  const f = fixture(); f.config.artifacts.timeoutMs = 100; const command = f.restart(); await f.create(); const original = f.artifactPort.request;
  f.artifactPort.request = async (...args) => { if (args[0] === artifactSubjects.get) await new Promise(resolve => setTimeout(resolve, 40)); return original(...args); };
  f.artifactPort.fetch = async (_url, options) => new Response(new ReadableStream({ start(controller) { options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true }); } }), { headers: { 'content-type': 'application/octet-stream' } });
  const start = performance.now(); await assert.rejects(f.app.request({ ...command, attachments: Array(8).fill(pair) }), e => e.outcome === 'not-sent'); assert.ok(performance.now() - start < 220); assert.equal(f.refs.size, 0); assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 0); f.app.close();
  const x = fixture(); x.config.artifacts.timeoutMs = 30; const late = x.restart(); await x.create(); const get = x.artifactPort.request;
  x.artifactPort.request = async (...args) => { const result = await get(...args); if (args[0] === artifactSubjects.get) await new Promise(resolve => setTimeout(resolve, 60)); return result; };
  await assert.rejects(x.app.request(late), e => e.code === 'TIMEOUT' && e.outcome === 'not-sent'); assert.equal(x.refs.size, 0); assert.equal(x.calls.filter(call => call.method === 'turn/start').length, 0); x.app.close();
  const y = fixture(); await y.create(); const before = y.artifactPort.request;
  y.artifactPort.request = async (...args) => { const result = await before(...args); if (args[0] === artifactSubjects.get) y.restart(); return result; };
  const oldApp = y.app; await assert.rejects(oldApp.request(base), e => e.outcome === 'not-sent'); assert.equal(y.refs.size, 0); assert.equal(y.calls.filter(call => call.method === 'turn/start').length, 0); y.app.close();
});
test('decorator stops remaining metadata reads after its total deadline or first availability failure', async () => {
  for (const offline of [false, true]) {
    const f = fixture(); await f.create(); await f.app.request(base); const reference = [...f.refs.values()][0]; reference.attachments = Array(8).fill(pair);
    const original = f.artifactPort.request, timeouts = []; let gets = 0;
    const transport = createArtifactsPort({ request: async (subject, raw, options) => {
      timeouts.push(options.timeout); const delay = subject === artifactSubjects.get ? 45 : 20;
      if (subject === artifactSubjects.get) gets++;
      if (offline && subject === artifactSubjects.get) throw new Error('offline');
      await new Promise((resolve, reject) => setTimeout(() => options.timeout < delay ? reject(new Error('timeout')) : resolve(), Math.min(options.timeout, delay)));
      return { data: Buffer.from(JSON.stringify(await original(subject, JSON.parse(Buffer.from(raw).toString())))) };
    } }, 100);
    const helper = createAttachments(f.port, { baseUrl: 'http://artifacts', timeoutMs: 100 }, { ...f.artifactPort, request: transport.request });
    const start = performance.now(), items = await helper.decorate(base, [{ id: 'u0', turnId: 'turn', type: 'userMessage', text: '', imageCount: 8 }]);
    assert.ok(performance.now() - start < 220); assert.ok(gets <= 2); assert.equal(items[0].attachments.length, 8); assert.equal(items[0].attachments.at(-1).status, 'unavailable'); assert.equal(items[0].attachmentsState, 'unavailable'); if (!offline) assert.ok(timeouts.at(-1) < 45); f.app.close();
  }
});
test('real local WebSocket validates image-only native input without daemon or inference', async t => {
  const f = fixture(), dir = mkdtempSync('/tmp/brai-artifact-ws-'), socketPath = join(dir, 'native.sock'), server = createServer(), wss = new WebSocketServer({ server });
  wss.on('error', () => {});
  wss.on('connection', socket => socket.on('message', async raw => { const packet = JSON.parse(raw.toString()); if (!Object.hasOwn(packet, 'id')) return; let result;
    if (packet.method === 'initialize') result = { codexHome: '/tmp/mock', platformFamily: 'unix', platformOs: 'linux', userAgent: 'test' };
    else if (packet.method === 'account/read') result = { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
    else if (packet.method === 'account/rateLimits/read') result = { rateLimits: {} };
    else result = await f.port.call(packet.method, packet.params);
    socket.send(JSON.stringify({ id: packet.id, result }));
  }));
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }); }
  catch (error) { await new Promise(resolve => wss.close(resolve)); rmSync(dir, { recursive: true }); if (error.code === 'EPERM') { t.skip('Sandbox blocks Unix sockets'); return; } throw error; }
  const codex = createCodex({ socketUrl: `ws+unix:${socketPath}:/` }), app = createApplication(codex, f.config, () => {}, f.artifactPort);
  try { await codex.connect(); const generation = codex.status().generation; await app.request({ action: 'create', projectId: 'p', generation, operationId: 'create' }); await app.request({ ...base, generation }); await app.request({ ...base, generation, action: 'steer', expectedTurnId: 'turn', operationId: 'steer' }); assert.equal((await app.request({ action: 'items', ownerId: 'owner', projectId: 'p', threadId: 't' })).data.length, 2); }
  finally { app.close(); f.app.close(); await codex.close(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true }); }
});
