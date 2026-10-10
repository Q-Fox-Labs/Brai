// ABOUTME: Проверяет completed output binding, recovery и owner descriptors без файлов и inference.
// ABOUTME: Подменяет native/artifacts порты; схемы и поведение публичной границы остаются настоящими.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import Ajv from 'ajv';
import publicSchema from '../schemas/messages.schema.json' with { type: 'json' };
import artifactSchema from '../../artifacts/schemas/messages.schema.json' with { type: 'json' };
import { subjects, validateRequest, validateResponse } from '../../artifacts/contracts/index.mjs';
import { createApplication } from '../dist/application.js';
import { createResults, resultTargets } from '../dist/results.js';
const ownerId = 'configured-owner', root = '/safe/results';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const target = `${root}/${id}/result.png`, markdown = `![preview](<${target}>) [download](<${target}>)`;
const command = { action: 'open', ownerId, projectId: 'p', threadId: 't' };
const ajv = new Ajv({ strict: false, validateFormats: false, schemas: [artifactSchema] });
ajv.addSchema(artifactSchema, '../../artifacts/schemas/messages.schema.json'); ajv.addSchema(publicSchema, 'agent');
const validItem = ajv.compile({ $ref: 'agent#/definitions/DisplayItem' });
function fixture(text = markdown, completed = true, timeoutMs = 10000) {
  let generation = 'g', observer, unavailable = false;
  const history = [{ turnId: 'turn', item: { id: 'message', type: 'agentMessage', text, phase: 'final_answer' }, completedAtMs: completed ? 1 : null }];
  const calls = [], events = [], bindings = new Map();
  const artifact = artifactId => ({ artifactId, ownerId, requestId: artifactId, kind: 'original', status: 'ready', title: 'Result', filename: 'result.png', extension: 'png', mimeType: 'image/png', source: 'agent', sizeBytes: 123, sha256: 'a'.repeat(64), internalUrl: 'http://private-artifacts/files/' + artifactId, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' });
  const artifacts = new Map([[id, artifact(id)], [other, artifact(other)]]);
  const outputPort = { fetch: async () => { throw new Error('No result bytes in Agent'); }, request: async (subject, value, options) => {
    calls.push({ subject, value: structuredClone(value), options });
    assert.ok(validateRequest(subject, value), `${subject}: request schema`);
    if (unavailable) throw new Error('offline');
    let result;
    if (subject === subjects.get) { const found = artifacts.get(value.artifactId); if (!found) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' }); result = found; }
    else if (subject === subjects.outputList) result = { bindings: value.itemIds.map(itemId => bindings.get(itemId)).filter(binding => binding && ['ownerId', 'projectId', 'threadId'].every(key => value[key] === binding[key])) };
    else if (subject === subjects.outputBind) {
      const previous = bindings.get(value.itemId);
      if (previous && JSON.stringify({ ...previous, createdAt: undefined }) !== JSON.stringify(value)) throw Object.assign(new Error('conflict'), { code: 'OPERATION_CONFLICT' });
      if (!previous && value.artifactIds.some(artifactId => artifacts.get(artifactId)?.ownerId !== value.ownerId || artifacts.get(artifactId)?.status !== 'ready')) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
      const binding = previous ?? { ...value, createdAt: '2026-10-10T00:00:00.000Z' }; bindings.set(value.itemId, binding); result = { binding };
    } else throw new Error('Unexpected outgoing subject ' + subject);
    assert.ok(validateResponse(subject, result), `${subject}: response schema`); return structuredClone(result);
  } };
  const incomingPort = { fetch: outputPort.fetch, request: async subject => { assert.equal(subject, subjects.referenceList); return { items: [] }; } };
  const thread = { id: 't', name: 'Desktop', preview: '', updatedAt: 1, cwd: '/tmp/results-project', model: 'test', status: { type: 'idle' } };
  const native = { status: () => ({ generation, connection: 'connected', authorization: 'ready' }), subscribe: listener => { observer = listener; return () => {}; }, call: async (method, params) => {
    if (method === 'thread/read') return { thread };
    if (method === 'thread/resume') return { thread, model: 'test' };
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: completed ? 'completed' : 'inProgress' }] };
    if (method === 'thread/items/list') {
      let data = params.sortDirection === 'desc' ? history.slice().reverse() : history.slice();
      if (params.cursor?.type === 'item') data = data.slice(data.findIndex(entry => entry.item.id === params.cursor.itemId) + 1);
      return { data: data.slice(0, params.limit), nextCursor: null };
    }
    throw new Error('Unexpected native call ' + method);
  } };
  const config = { ownerId, artifacts: { baseUrl: 'http://incoming-private', timeoutMs, resultRoot: root, resultsBaseUrl: 'http://outgoing-private' }, projects: [{ projectId: 'p', name: 'P', cwd: thread.cwd }] };
  let app = createApplication(native, config, event => events.push(event), incomingPort, outputPort);
  return { get app() { return app; }, native, config, incomingPort, outputPort, calls, events, history, artifacts, bindings, offline: value => { unavailable = value; }, restart: () => { app.close(); generation = 'next'; app = createApplication(native, config, event => events.push(event), incomingPort, outputPort); }, observe: (method, item = history[0].item) => observer({ type: 'notification', method, params: { threadId: 't', turnId: 'turn', item } }) };
}

test('inline links and images accept exact root, angle paths and parentheses; code/escaped/URLs/traversal never bind', () => {
  const names = ['result.png', 'result with space.txt', 'report(1).txt'];
  for (const filename of names) assert.equal(resultTargets(`[file](<${root}/${id}/${filename}>)`, root)[0].filename, filename);
  assert.equal(resultTargets(`[file](${root}/${id}/report(1).txt "label")`, root)[0].filename, 'report(1).txt');
  assert.equal(resultTargets(markdown, root).length, 1);
  const literal = [
    '`' + markdown + '`', '``' + markdown + '``', '```markdown\n' + markdown + '\n```', '~~~\n' + markdown + '\n~~~', '```\n' + markdown,
    '> ```\n> ' + markdown + '\n> ```', '- ```\n  ' + markdown + '\n  ```', '> - ~~~\n>   ' + markdown + '\n>   ~~~', '>     ' + markdown,
    '<pre>' + markdown + '</pre>', '<code>' + markdown + '</code>', '<!-- ' + markdown + ' -->',
    '    ' + markdown, '\t' + markdown, '\\[file](<' + target + '>)', '\\![file](<' + target + '>)',
    `[file](file://${target})`, `[file](https://example.org${target})`, `[file](${root}x/${id}/result.png)`, `[file](${root}/${id}/../result.png)`, `[file](${root}/${id}/nested/result.png)`, `[file](${root}/${id}/%2e%2e)`, `[file](${target}?key=secret)`, `[file](${target}#part)`, `[file](${root}//${id}/result.png)`, `[file](${root}/not-uuid/result.png)`, `[file](<${root}/${id}/file\n.png>)`, `[ref][saved]\n[saved]: ${target}`,
  ];
  for (const text of literal) assert.deepEqual(resultTargets(text, root), [], text);
  assert.equal(resultTargets(`unclosed \` literal\n${markdown}`, root).length, 1);
  assert.equal(resultTargets(`![nested [label]](<${target}>)`, root).length, 1);
});

test('Desktop-started completed history restores binding before truncation and every message page retains descriptors', async t => {
  const full = 'До результата '.repeat(1600) + markdown;
  const f = fixture(full); t.after(() => f.app.close());
  const view = await f.app.request(command), item = view.items[0];
  assert.ok(item.truncated); assert.ok(!item.text.includes(target)); assert.equal(item.resultCount, 1); assert.ok(validItem(item), JSON.stringify(validItem.errors));
  assert.deepEqual(f.bindings.get('message').artifactIds, [id]); assert.equal(item.results[0].target, target); assert.equal(item.results[0].state, 'ready');
  assert.equal(item.results[0].previewUrl, `/api/agent/results/${id}?projectId=p&threadId=t&turnId=turn&itemId=message&expectedUserId=${ownerId}`);
  assert.equal(item.results[0].downloadUrl, item.results[0].previewUrl + '&download=1');
  assert.equal(f.history[0].item.text, full); assert.ok(f.events.every(event => !JSON.stringify(event).includes('private-artifacts') && !event.event.snapshot.items.some(item => item.results)));
  let cursor, reconstructed = '', pages = 0;
  do { const page = await f.app.request({ ...command, action: 'item', turnId: 'turn', itemId: 'message', ...(cursor ? { cursor } : {}) }); reconstructed += page.item.text; assert.deepEqual(page.item.results, item.results); assert.equal(page.item.resultCount, 1); cursor = page.nextCursor; pages++; } while (cursor);
  assert.equal(reconstructed, full); assert.ok(pages > 2);
  f.restart(); assert.deepEqual((await f.app.request(command)).items[0].results, item.results);
  assert.equal(f.calls.filter(call => call.subject === subjects.outputBind).length, 1);
});

test('only item/completed binds: started and streamed text remains unchanged, live snapshots have counts only', async t => {
  const f = fixture(markdown, false); t.after(() => f.app.close()); await f.app.request(command);
  f.observe('item/started'); await new Promise(setImmediate); assert.equal(f.bindings.size, 0);
  f.observe('item/completed'); await new Promise(setImmediate);
  assert.equal(f.bindings.size, 1); f.history[0].completedAtMs = 2;
  const view = await f.app.request(command); assert.equal(view.items[0].text, markdown); assert.equal(view.items[0].results[0].artifactId, id);
  assert.ok(f.events.every(event => event.event.snapshot.items.every(item => item.results === undefined && item.resultsState === undefined)));
});

test('owner validation rejects foreign, missing and filename mismatches; untrusted RPC never receives descriptors', async t => {
  for (const mode of ['foreign', 'missing', 'filename', 'identity']) {
    const f = fixture(); t.after(() => f.app.close());
    if (mode === 'foreign') f.artifacts.get(id).ownerId = 'other-owner';
    if (mode === 'missing') f.artifacts.delete(id);
    if (mode === 'filename') f.artifacts.get(id).filename = 'different.png';
    if (mode === 'identity') f.artifacts.get(id).artifactId = other;
    const view = await f.app.request(command); assert.equal(f.bindings.size, 0); assert.equal(view.items[0].resultsState, 'unavailable'); assert.equal(view.items[0].results, undefined);
  }
  const f = fixture(); t.after(() => f.app.close()); await f.app.request(command);
  const before = f.calls.length;
  const foreign = await f.app.request({ ...command, ownerId: 'other-owner' }), anonymous = await f.app.request({ ...command, ownerId: undefined });
  assert.equal(f.calls.length, before); assert.equal(foreign.items[0].results, undefined); assert.equal(anonymous.items[0].results, undefined);
});

test('deleted results retain immutable binding and tombstones without usable URLs after restart', async t => {
  const f = fixture(); t.after(() => f.app.close()); await f.app.request(command);
  f.artifacts.get(id).status = 'deleted'; f.artifacts.get(id).deletedAt = '2026-10-10T00:01:00.000Z'; delete f.artifacts.get(id).internalUrl; f.restart();
  const view = await f.app.request(command), result = view.items[0].results[0];
  assert.equal(result.state, 'deleted'); assert.equal(result.target, target); assert.equal(result.filename, 'result.png'); assert.equal(result.previewUrl, undefined); assert.equal(result.downloadUrl, undefined); assert.equal(f.calls.filter(call => call.subject === subjects.outputBind).length, 1);
});

test('open outage exposes unavailable count and later cached item/open recovery binds without native resend', async t => {
  const f = fixture(); t.after(() => f.app.close()); f.offline(true);
  const first = await f.app.request(command); assert.equal(first.items[0].resultsState, 'unavailable'); assert.equal(first.items[0].resultCount, 1);
  f.offline(false);
  const recovered = await f.app.request({ ...command, action: 'item', turnId: 'turn', itemId: 'message' }); assert.equal(recovered.item.results[0].state, 'ready'); assert.equal(f.bindings.size, 1);
  assert.equal((await f.app.request({ ...command, action: 'items' })).data[0].results[0].state, 'ready');
});

test('raw image generation/dynamic tool/savedPath payloads never create results and metadata owner changes disclose nothing', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const helper = createResults(f.native, f.config.artifacts, ownerId, f.outputPort);
  const image = { id: 'raw-image', type: 'imageGeneration', savedPath: target, revisedPrompt: markdown, result: 'private-base64' };
  const dynamic = { id: 'raw-tool', type: 'dynamicToolCall', text: markdown, contentItems: [{ type: 'image', data: 'private-base64' }] };
  assert.equal(helper.count(image), 0); assert.equal(helper.count(dynamic), 0); assert.deepEqual(resultTargets(JSON.stringify({ savedPath: target }), root), []);
  await helper.recoverItems(command, [image, dynamic].map(item => ({ item, turnId: 'turn', completedAtMs: 1 }))); assert.equal(f.bindings.size, 0);
  await f.app.request(command); f.artifacts.get(id).ownerId = 'other-owner'; f.artifacts.get(id).filename = 'foreign-secret.png';
  const result = (await f.app.request(command)).items[0].results[0]; assert.equal(result.state, 'unavailable'); assert.equal(result.previewUrl, undefined); assert.notEqual(result.filename, 'foreign-secret.png');
});

test('results have no arbitrary 100-count cap and metadata deadline stops remaining reads', async t => {
  const ids = Array.from({ length: 120 }, (_, n) => n.toString(16).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const full = ids.map(artifactId => `[file](<${root}/${artifactId}/result.png>)`).join('\n');
  const f = fixture(full); t.after(() => f.app.close());
  for (const artifactId of ids) f.artifacts.set(artifactId, { ...f.artifacts.get(id), artifactId, requestId: artifactId, internalUrl: 'http://private-artifacts/files/' + artifactId });
  const view = await f.app.request(command); assert.equal(view.items[0].results.length, 120); assert.equal(view.items[0].resultCount, 120);
  const helper = createResults(f.native, { ...f.config.artifacts, timeoutMs: 50 }, ownerId, { ...f.outputPort, request: async (...args) => { await new Promise(resolve => setTimeout(resolve, Math.min(30, args[2].timeoutMs))); return f.outputPort.request(...args); } });
  const start = performance.now(), from = f.calls.length;
  const result = await helper.decorate(command, [{ id: 'message', turnId: 'turn', type: 'agentMessage', text: '', resultCount: 120 }]);
  assert.ok(performance.now() - start < 110); assert.equal(result[0].results.length, 120); assert.equal(result[0].resultsState, 'unavailable'); assert.ok(f.calls.slice(from).filter(call => call.subject === subjects.get).length <= 1);
});

test('rotated generation rejects late descriptors and invalid trusted result config fails before use', async t => {
  const f = fixture(); t.after(() => f.app.close()); await f.app.request(command);
  const get = f.outputPort.request;
  const helper = createResults(f.native, f.config.artifacts, ownerId, { ...f.outputPort, request: async (...args) => { const value = await get(...args); f.restart(); return value; } });
  await assert.rejects(helper.decorate(command, [{ id: 'message', turnId: 'turn', type: 'agentMessage', text: '', resultCount: 1 }]), error => error.code === 'STALE_GENERATION');
  for (const resultRoot of ['relative', '/', '/safe/../results', '/safe//results', '/safe/results/', '/safe/results?x']) assert.throws(() => createResults(f.native, { ...f.config.artifacts, resultRoot }, ownerId, f.outputPort), /INVALID_AGENT_CONFIG/);
  assert.throws(() => createResults(f.native, f.config.artifacts, undefined, f.outputPort), /INVALID_AGENT_CONFIG/);
  assert.throws(() => createResults(f.native, f.config.artifacts, ' owner ', f.outputPort), /INVALID_AGENT_CONFIG/);
});

test('a configured but missing results port gives explicit unavailable and response budget never truncates descriptors', async t => {
  const f = fixture(); t.after(() => f.app.close());
  const missing = createResults(f.native, f.config.artifacts, ownerId);
  const unavailable = await missing.decorate(command, [{ id: 'message', turnId: 'turn', type: 'agentMessage', text: markdown, resultCount: 1 }]); assert.equal(unavailable[0].resultsState, 'unavailable');
  const ids = Array.from({ length: 250 }, (_, n) => n.toString(16).padStart(8, '0') + '-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  f.bindings.set('message', { ownerId, projectId: 'p', threadId: 't', turnId: 'turn', itemId: 'message', artifactIds: ids, createdAt: '2026-10-10T00:00:00.000Z' });
  for (const artifactId of ids) f.artifacts.set(artifactId, { ...f.artifacts.get(id), artifactId, requestId: artifactId, filename: 'x'.repeat(1000) + '.png', internalUrl: 'http://private-artifacts/files/' + artifactId });
  const helper = createResults(f.native, f.config.artifacts, ownerId, f.outputPort);
  await assert.rejects(helper.decorate(command, [{ id: 'message', turnId: 'turn', type: 'agentMessage', text: '', resultCount: ids.length }]), error => error.code === 'CAPACITY_EXHAUSTED' && error.outcome === 'query');
});

test('ordinary native text never queries an unresponsive results store', async t => {
  const source = 'Native answer with no artifact links', f = fixture(source, true, 100); t.after(() => f.app.close());
  let outputCalls = 0;
  f.outputPort.request = async () => { outputCalls++; throw new Error('unresponsive outgoing must not be queried'); };
  const opened = await f.app.request(command), detailed = await f.app.request({ ...command, action: 'item', turnId: 'turn', itemId: 'message' }), listed = await f.app.request({ ...command, action: 'items' });
  assert.equal(opened.items[0].text, source); assert.equal(detailed.item.text, source); assert.equal(listed.data[0].text, source); assert.equal(outputCalls, 0);
});

test('native reads and slow incoming/outgoing metadata share one request deadline and preserve native text', async t => {
  const f = fixture(markdown, true, 200); t.after(() => f.app.close());
  const nativeCall = f.native.call; f.native.call = async (...args) => { if (args[0] === 'thread/read') await new Promise(resolve => setTimeout(resolve, 40)); return nativeCall(...args); };
  const incoming = f.incomingPort.request; const metadataTimeouts = [];
  f.incomingPort.request = async (subject, value, options) => { metadataTimeouts.push({ phase: 'incoming', timeoutMs: options.timeoutMs }); await new Promise(resolve => setTimeout(resolve, 140)); return incoming(subject, value, options); };
  f.outputPort.request = async (_subject, _value, options) => { metadataTimeouts.push({ phase: 'outgoing', timeoutMs: options.timeoutMs }); await new Promise(resolve => setTimeout(resolve, options.timeoutMs)); throw new Error('outgoing timeout'); };
  let timer;
  const work = f.app.request(command);
  const result = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(null), 350); })]); clearTimeout(timer); await work;
  assert.ok(result, 'Metadata must return before the external read deadline');
  assert.equal(result.items[0].text, markdown); assert.equal(result.items[0].resultsState, 'unavailable');
  assert.equal(metadataTimeouts.filter(entry => entry.phase === 'outgoing').length, 1);
  assert.ok(metadataTimeouts.find(entry => entry.phase === 'incoming').timeoutMs < 200, 'Native read consumes the same deadline');
  assert.ok(metadataTimeouts.find(entry => entry.phase === 'outgoing').timeoutMs < 60, 'Incoming read cannot reset the outgoing budget');
});

test('incoming history recovery consumes the read budget before both decorators', async t => {
  const f = fixture(markdown, true, 200); t.after(() => f.app.close());
  f.history.unshift({ turnId: 'turn', completedAtMs: 1, item: { id: 'input', type: 'userMessage', clientId: 'brai:agent:v3:recovery', content: [{ type: 'text', text: 'Native user text' }] } });
  const nativeCall = f.native.call; f.native.call = async (...args) => { if (args[0] === 'thread/read') await new Promise(resolve => setTimeout(resolve, 40)); return nativeCall(...args); };
  const incoming = f.incomingPort.request, observed = [];
  f.incomingPort.request = async (subject, value, options) => {
    observed.push({ phase: subject === subjects.referenceGet ? 'recovery' : 'incoming', timeoutMs: options.timeoutMs });
    if (subject === subjects.referenceGet) { await new Promise(resolve => setTimeout(resolve, 110)); throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' }); }
    return incoming(subject, value, options);
  };
  f.outputPort.request = async (_subject, _value, options) => { observed.push({ phase: 'outgoing', timeoutMs: options.timeoutMs }); await new Promise(resolve => setTimeout(resolve, options.timeoutMs)); throw new Error('outgoing timeout'); };
  let timer;
  const work = f.app.request(command);
  const result = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(null), 300); })]); clearTimeout(timer); await work;
  assert.ok(result, 'Recovery must not grant fresh decorator budgets');
  assert.equal(result.items[0].text, 'Native user text'); assert.equal(result.items[1].text, markdown); assert.equal(result.items[1].resultsState, 'unavailable');
  assert.ok(observed.find(entry => entry.phase === 'recovery').timeoutMs < 200);
  assert.ok(observed.find(entry => entry.phase === 'incoming').timeoutMs < 80);
  assert.ok(observed.find(entry => entry.phase === 'outgoing').timeoutMs < 80);
  assert.equal(observed.filter(entry => entry.phase === 'outgoing').length, 1);
});

test('incoming attachment descriptors survive an expired outgoing deadline', async t => {
  const f = fixture(markdown, true, 200); t.after(() => f.app.close());
  f.history.unshift({ turnId: 'turn', completedAtMs: 1, item: { id: 'input', type: 'userMessage', content: [{ type: 'image', url: 'data:image/png;base64,native-private-media' }] } });
  const observed = [], attachment = { originalArtifactId: id, modelArtifactId: id };
  f.incomingPort.request = async (subject, _value, options) => {
    observed.push({ phase: 'incoming', timeoutMs: options.timeoutMs });
    if (subject === subjects.referenceList) {
      await new Promise(resolve => setTimeout(resolve, 50));
      return { items: [{ scope: { ownerId, projectId: 'p', threadId: 't', operationId: 'input-operation' }, clientUserMessageId: 'brai:agent:v3:input-operation', commandHash: 'a'.repeat(64), attachments: [attachment], state: 'confirmed', turnId: 'turn', itemId: 'input', createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' }] };
    }
    assert.equal(subject, subjects.get); await new Promise(resolve => setTimeout(resolve, 80)); return structuredClone(f.artifacts.get(id));
  };
  f.outputPort.request = async (_subject, _value, options) => { observed.push({ phase: 'outgoing', timeoutMs: options.timeoutMs }); await new Promise(resolve => setTimeout(resolve, options.timeoutMs)); throw new Error('outgoing timeout'); };
  let timer; const work = f.app.request(command);
  const result = await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(null), 300); })]); clearTimeout(timer); await work;
  assert.ok(result, 'The outgoing timeout must preserve the completed incoming decoration');
  assert.equal(result.items[0].imageCount, 1); assert.equal(result.items[0].attachmentsState, 'ready'); assert.equal(result.items[0].attachments[0].status, 'ready'); assert.ok(result.items[0].attachments[0].url.startsWith(`/api/agent/attachments/${id}?`));
  assert.equal(result.items[1].text, markdown); assert.equal(result.items[1].resultsState, 'unavailable'); assert.ok(observed.find(entry => entry.phase === 'outgoing').timeoutMs < 100); assert.ok(!JSON.stringify(result).includes('native-private-media'));
});
