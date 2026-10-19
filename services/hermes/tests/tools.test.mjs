// ABOUTME: Проверяет owner boundary, подтверждения Telegram и реальные MCP/RPC транспорты Hermes.
// ABOUTME: Не требует учётных данных, работающего брокера или пользовательских файлов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { natsTools } from '../catalog.mjs';
import { validateConfig } from '../config.mjs';
import { createBraiTools, fault } from '../runtime.mjs';
import { createHumanActions } from '../human-actions.mjs';
import { createTrustedDispatcher, serveTrusted } from '../trusted.mjs';
import { serveTools } from '../tools.mjs';
import { synthesizeFile } from '../voice.mjs';

const owner = 'trusted-owner';
const ids = Array.from({ length: 8 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const schema = properties => ({ type: 'object', additionalProperties: false, properties });
const tools = {
  elements: [
    { name: 'elements_graph_get', inputSchema: schema({}) },
    { name: 'elements_move_claim', inputSchema: { ...schema({ move_id: { type: 'string' }, idempotency_key: { type: 'string' }, executor_kind: { enum: ['agent', 'human', 'system'] }, executor_id: { type: 'string' }, input_resource_ids: { type: 'array' } }), required: ['move_id', 'idempotency_key', 'executor_kind', 'input_resource_ids'] } },
    { name: 'elements_move_complete', inputSchema: schema({ attempt_id: { type: 'string' }, result: { type: 'object' } }) },
    { name: 'elements_move_fail', inputSchema: schema({ attempt_id: { type: 'string' }, error_code: { type: 'string' } }) },
  ],
  publisher: [{ name: 'publish_file', inputSchema: schema({ path: { type: 'string' }, requestId: { type: 'string' } }) }, { name: 'fetch_file', inputSchema: schema({ artifactId: { type: 'string' } }) }],
  history: [{ name: 'history_search', inputSchema: schema({}) }, { name: 'history_append', inputSchema: schema({}) }, { name: 'history_categories_list', inputSchema: schema({}) }],
  transcription: [{ name: 'transcription_request_submit', inputSchema: schema({ requestId: { type: 'string' }, artifactId: { type: 'string' } }) }],
};
function fixture(overrides = {}) {
  const calls = [], graph = { elements: [{ id: ids[0], revision: ids[1] }], moves: [{ id: ids[2], kind: 'action', targetId: ids[0], attemptId: ids[3], executor: 'human', status: 'claimed', title: 'Подтвердить', input: [] }], attempts: [{ id: ids[3], moveId: ids[2], status: 'running' }], revisions: [{ owner_id: owner }] };
  const ports = {
    list: async endpoint => tools[endpoint],
    mcp: async (endpoint, name, args) => { calls.push({ endpoint, name, args }); if (name === 'elements_graph_get') return graph; return { artifactId: ids[4], localPath: `/results/${ids[4]}/report.txt` }; },
    request: async (subject, payload) => { calls.push({ subject, payload }); return { userId: owner }; },
    publish: async (subject, payload) => { calls.push({ subject, payload }); },
    close: async () => {}, ...overrides,
  };
  return { calls, graph, ports };
}
const config = { ownerId: owner, nats: { servers: ['nats://internal:4222'] }, elements: { url: 'http://elements:8080/mcp', ownerId: owner }, history: { url: 'http://history:8080/mcp' }, transcription: { url: 'http://transcription:8080/mcp', token: 'private' }, publisher: { configPath: '/private/publisher.json' } };

test('доверенный owner обязателен; адреса и bearer не принимают URL credentials', () => {
  assert.equal(validateConfig(config, owner), config);
  for (const value of [{ ...config, ownerId: 'other' }, { ...config, elements: { ...config.elements, ownerId: 'other' } }, { ...config, transcription: { url: 'http://user:secret@host/mcp' } }]) assert.throws(() => validateConfig(value, owner), /INVALID_HERMES_CONFIG/);
});

test('Timer v2 сохраняет owner, исходные commandId и timestamps; PubAck не считается исполнением', async () => {
  const { ports, calls } = fixture(), runtime = await createBraiTools(config, ports);
  const args = { commandId: ids[0], timerId: ids[1], startedAt: '2026-10-19T12:00:00.000Z' };
  assert.deepEqual(await runtime.call('timer_start', args), { commandId: ids[0], status: 'stored', outcome: 'unknown', nextTool: 'timer_command_get' });
  assert.deepEqual(calls[0], { subject: 'brai.timer.v2.command.start', payload: { ...args, userId: owner } });
  await assert.rejects(runtime.call('timer_start', { ...args, userId: 'other' }), /INVALID_ARGUMENT/);
  await assert.rejects(runtime.call('timer_start', { ...args, startedAt: '2026-10-19T12:00:00Z' }), /INVALID_ARGUMENT/);
  await assert.rejects(runtime.call('nats_request', { subject: 'anything' }), /INVALID_ARGUMENT/);
});

test('потеря PubAck или LocalAI ответа даёт неизвестный исход без повтора', async () => {
  let publishes = 0, requests = 0;
  const { ports } = fixture({ publish: async () => { publishes++; throw fault('TIMEOUT'); }, request: async () => { requests++; throw fault('TIMEOUT'); } });
  const runtime = await createBraiTools(config, ports);
  await assert.rejects(runtime.call('timer_start', { commandId: ids[0], expectedVersion: 0 }), error => error.code === 'OUTCOME_UNKNOWN' && error.requestId === ids[0]);
  await assert.rejects(runtime.call('local_ai_models_load', { modelId: 'model', revision: 'revision', profileId: 'profile', deadlineAt: '2026-10-19T13:00:00Z' }), /OUTCOME_UNKNOWN/);
  assert.equal(publishes, 1); assert.equal(requests, 1);
});

test('History читает user scope, не выставляет административные MCP операции', async () => {
  const { ports, calls } = fixture({ request: async (subject, payload) => { calls.push({ subject, payload }); return { items: [], next_cursor: null }; } });
  const runtime = await createBraiTools(config, ports);
  assert.equal(runtime.tools.some(tool => ['history_search', 'history_append'].includes(tool.name)), false);
  await runtime.call('history_list', { filters: { object_id: 'example' } });
  assert.equal(calls[0].payload.user_id, owner);
  await assert.rejects(runtime.call('history_list', { filters: { scope_id: 'other' } }), /INVALID_ARGUMENT/);
});

test('модель не может claim/complete человеческую попытку; файлы проходят через publisher MCP', async () => {
  const { ports, calls } = fixture(), runtime = await createBraiTools(config, ports);
  await assert.rejects(runtime.call('elements_move_claim', { move_id: ids[2], executor_kind: 'human', idempotency_key: 'key', input_resource_ids: [] }), /INVALID_ARGUMENT|FORBIDDEN/);
  await assert.rejects(runtime.call('elements_move_complete', { attempt_id: ids[3], result: { resources: [] } }), /FORBIDDEN/);
  assert.equal(calls.some(call => call.name === 'elements_move_complete'), false);
  const instruction = await runtime.call('elements_request_human_action', { moveId: ids[2] });
  assert.equal(instruction.nextTool, 'brai_telegram_request_confirmation');
  assert.equal(instruction.revisionId, ids[1]);
  await runtime.call('fetch_file', { artifactId: ids[4] });
  assert.equal(calls.at(-1).endpoint, 'publisher');
  assert.equal(runtime.tools.some(tool => tool.name === 'actions.complete'), false);
});

test('owner mismatch в ответе и oversized arguments отклоняются', async () => {
  const { ports, graph } = fixture(), runtime = await createBraiTools(config, ports);
  graph.revisions[0].owner_id = 'other';
  await assert.rejects(runtime.call('elements_request_human_action', { moveId: ids[2] }), /OWNER_MISMATCH/);
  await assert.rejects(runtime.call('fetch_file', { artifactId: 'x'.repeat(70_000) }), /REQUEST_TOO_LARGE/);
});

test('trusted prepare привязывает human attempt; stale revision и чужая attempt отвергаются', async () => {
  const { ports, graph, calls } = fixture();
  ports.mcp = async (endpoint, name, args) => {
    calls.push({ endpoint, name, args });
    if (name === 'elements_graph_get') return graph;
    if (name === 'elements_move_claim') return { attempt: { id: ids[3], executor_kind: 'human', status: 'running' } };
    return { attempt: { id: ids[3], status: 'succeeded' } };
  };
  const human = createHumanActions(await createBraiTools(config, ports));
  const prepared = await human.prepare({ moveId: ids[2], revisionId: ids[1], idempotencyKey: 'callback-1', inputResourceIds: [] });
  assert.equal(prepared.attemptId, ids[3]);
  assert.equal(calls.at(-1).args.idempotency_key, 'telegram:callback-1');
  const recovery = await human.prepare({ moveId: ids[2], revisionId: ids[5], idempotencyKey: 'callback-1', inputResourceIds: [] });
  assert.equal(recovery.attemptId, ids[3]); assert.equal(recovery.revisionId, ids[5]); assert.equal(recovery.currentRevisionId, ids[1]);
  const params = { moveId: ids[2], attemptId: ids[3], revisionId: ids[1], stage: 'planning', decision: 'approved' };
  await assert.rejects(human.complete({ ...params, revisionId: ids[5] }), /STALE_ACTION/);
  await assert.rejects(human.complete({ ...params, attemptId: ids[5] }), /STALE_ACTION/);
  await human.complete(params);
  assert.deepEqual(calls.at(-1).args.result.resources[0].metadata, { element_id: ids[0], revision_id: ids[1], stage: 'planning', outcome: 'approved' });
  graph.attempts[0].status = 'succeeded';
  await assert.rejects(human.complete(params), /STALE_ACTION/);
});

test('trusted JSON-RPC сохраняет id, batch и notifications; не имеет произвольных методов', async () => {
  const { ports } = fixture(), dispatch = createTrustedDispatcher(await createBraiTools(config, ports));
  assert.equal((await dispatch('{')).error.code, -32700);
  assert.equal((await dispatch('[]')).error.code, -32600);
  assert.equal((await dispatch(JSON.stringify({ jsonrpc: '2.0', id: 'unknown', method: 'raw.nats' }))).id, 'unknown');
  assert.equal((await dispatch(JSON.stringify({ jsonrpc: '2.0', id: 'prototype', method: 'constructor' }))).error.code, -32601);
  assert.equal((await dispatch(JSON.stringify({ jsonrpc: '2.0', id: 'bad', method: 'files.fetch', params: [] }))).error.code, -32602);
  const batch = await dispatch(JSON.stringify([{ jsonrpc: '2.0', method: 'files.fetch', params: { artifactId: ids[4] } }, { jsonrpc: '2.0', id: 'fetch', method: 'files.fetch', params: { artifactId: ids[4] } }]));
  assert.equal(batch.length, 1); assert.equal(batch[0].id, 'fetch'); assert.equal(batch[0].result.artifactId, ids[4]);
});

test('trusted stdio ограничивает строку до parse и обрабатывает newline protocol', async () => {
  const { ports } = fixture(), runtime = await createBraiTools(config, ports), input = new PassThrough(), output = new PassThrough();
  let text = ''; output.on('data', chunk => { text += chunk; });
  const serving = serveTrusted(runtime, input, output);
  input.end(JSON.stringify({ jsonrpc: '2.0', id: 'file', method: 'files.fetch', params: { artifactId: ids[4] } }) + '\n');
  await serving; assert.equal(JSON.parse(text).id, 'file');
  const tooLarge = new PassThrough(), failed = serveTrusted(runtime, tooLarge, output);
  tooLarge.end('x'.repeat(65_537)); await assert.rejects(failed, /RPC_LINE_TOO_LARGE/);
});

test('настоящий MCP SDK передаёт tool catalogue и ошибки владельца без human методов', async () => {
  const { ports } = fixture(), runtime = await createBraiTools(config, ports);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const service = await serveTools(runtime, serverTransport), client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.equal(listed.tools.some(tool => tool.name === 'timer_start'), true);
    const result = await client.callTool({ name: 'fetch_file', arguments: { artifactId: ids[4] } });
    assert.equal(result.structuredContent.artifactId, ids[4]);
    const forbidden = await client.callTool({ name: 'actions.complete', arguments: {} });
    assert.equal(forbidden.isError, true);
  } finally { await client.close(); await service.close(); }
});

test('LocalAI synthesize использует новый owner контракт и фиксированные ограничения голоса', () => {
  const tool = natsTools.find(tool => tool.name === 'local_ai_invoke_synthesize');
  const args = { requestId: ids[0], operationId: ids[1], model: { modelId: 'silero-tts-ru-v5_5', revision: '50081637b602126ee06cb3bc8a744d25651d2da1', profileId: 'silero_pytorch' }, deadlineAt: '2026-10-19T13:00:00Z', text: 'Тест', voice: 'eugene' };
  assert.equal(tool.validateInput(args), true);
  assert.equal(tool.validateInput({ ...args, voice: 'unknown' }), false);
  assert.equal(tool.validateRequest({ ...args, ownerId: owner }), true);
  assert.equal(tool.validateRequest({ ...args, ownerId: owner, text: 'a'.repeat(901) }), false);
});

test('cancel и expiry завершают только exact human attempt и разрешают cleanup старой revision', async () => {
  const { ports, graph, calls } = fixture(), human = createHumanActions(await createBraiTools(config, ports));
  const args = { moveId: ids[2], attemptId: ids[3], revisionId: ids[5], reason: 'expired' };
  await human.cancel(args);
  assert.deepEqual(calls.at(-1).args, { attempt_id: ids[3], error_code: 'HUMAN_EXPIRED' });
  await assert.rejects(human.cancel({ ...args, attemptId: ids[4] }), /STALE_ACTION/);
  graph.attempts[0].status = 'failed';
  await assert.rejects(human.cancel(args), /STALE_ACTION/);
  assert.equal(calls.filter(call => call.name === 'elements_move_fail').length, 1);
});

test('voice CLI adapter получает owner artifact и копирует точные bytes; большие входы и output conflict не запускают compute', async () => {
  const tmpRoot = fileURLToPath(new URL('../../../tmp/', import.meta.url));
  await mkdir(tmpRoot, { recursive: true });
  const directory = await mkdtemp(join(tmpRoot, 'hermes-voice-'));
  try {
    const input = join(directory, 'text.txt'), output = join(directory, 'speech.ogg'), artifact = join(directory, 'verified.ogg');
    const bytes = Buffer.from('OggSverified-owner-bytes');
    await writeFile(input, 'Привет'); await writeFile(artifact, bytes);
    const calls = [], runtime = { async call(name, args) { calls.push({ name, args }); return name === 'local_ai_invoke_synthesize' ? { audioArtifactId: ids[4] } : { localPath: artifact, mimeType: 'audio/ogg' }; } };
    const voiceConfig = { tts: { model: { modelId: 'silero-tts-ru-v5_5', revision: '50081637b602126ee06cb3bc8a744d25651d2da1', profileId: 'silero_pytorch' } } };
    const result = await synthesizeFile(voiceConfig, runtime, { input, output, voice: 'eugene' });
    assert.equal(result.artifactId, ids[4]); assert.deepEqual(await readFile(output), bytes);
    assert.notEqual(calls[0].args.requestId, calls[0].args.operationId);
    assert.equal(calls[0].args.text, 'Привет'); assert.equal(calls[1].args.artifactId, ids[4]);
    await assert.rejects(synthesizeFile(voiceConfig, runtime, { input, output, voice: 'eugene' }), /OUTPUT_EXISTS/);
    await writeFile(input, 'x'.repeat(3601));
    await assert.rejects(synthesizeFile(voiceConfig, runtime, { input, output: join(directory, 'new.ogg'), voice: 'eugene' }), /INPUT_TOO_LARGE/);
    assert.equal(calls.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
