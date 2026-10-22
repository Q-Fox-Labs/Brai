// ABOUTME: Проверяет owner boundary, подтверждения Telegram и реальные MCP/RPC транспорты Hermes.
// ABOUTME: Не требует учётных данных, работающего брокера или пользовательских файлов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { compileInput, natsTools } from '../catalog.mjs';
import { validateConfig } from '../config.mjs';
import { createBraiTools, connectMcpEndpoint, unwrap, fault } from '../runtime.mjs';
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
    { name: 'elements_element_reclassify', description: 'reclassify', inputSchema: schema({ element_id: { type: 'string' }, expected_revision_id: { type: 'string' }, target_kind: { enum: ['task', 'goal', 'quest'] }, idempotency_key: { type: 'string' }, reason: { type: 'string' } }) },
    { name: 'elements_planning_expand_repeat', description: 'expand', inputSchema: schema({ move_id: { type: 'string' }, revision_id: { type: 'string' }, resource_id: { type: 'string' }, items: { type: 'array' }, idempotency_key: { type: 'string' } }) },
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

test('Hermes owner catalog exposes only the reclassify and repeat expansion MCP contracts', async () => {
  const { ports, calls } = fixture(), runtime = await createBraiTools(config, ports);
  assert.deepEqual(runtime.tools.filter(tool => tool.name.includes('reclassify') || tool.name.includes('expand_repeat')).map(tool => tool.name).sort(), ['elements_element_reclassify', 'elements_planning_expand_repeat']);
  await runtime.call('elements_element_reclassify', { element_id: ids[0], expected_revision_id: ids[1], target_kind: 'quest', idempotency_key: 'classify-1', reason: 'Contains multiple independently accepted goals.' });
  await runtime.call('elements_planning_expand_repeat', { move_id: ids[2], revision_id: ids[1], resource_id: ids[3], items: [{ id: ids[4], label: 'First' }], idempotency_key: 'repeat-1' });
  assert.deepEqual(calls.slice(-2).map(call => call.name), ['elements_element_reclassify', 'elements_planning_expand_repeat']);
  await assert.rejects(runtime.call('elements_element_reclassify', { element_id: ids[0], expected_revision_id: ids[1], target_kind: 'level', idempotency_key: 'bad', reason: 'bad' }), /INVALID_ARGUMENT/);
});

test('reclassify and repeat expansion preserve unknown mutation outcome without automatic retry', async () => {
  let calls = 0;
  const { ports } = fixture({ mcp: async () => { calls++; throw fault('TIMEOUT'); } });
  const runtime = await createBraiTools(config, ports);
  await assert.rejects(runtime.call('elements_planning_expand_repeat', { move_id: ids[2], revision_id: ids[1], resource_id: ids[3],
    items: [{ id: ids[4], label: 'First' }], idempotency_key: 'repeat-1' }), /OUTCOME_UNKNOWN/);
  assert.equal(calls, 1);
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

test('integrated decision-only Actions derive canonical stage and write review/changes', async () => {
  const document = JSON.parse(await readFile(new URL('../trusted.openrpc.json', import.meta.url), 'utf8'));
  const validateAction = compileInput({ $ref: '#/components/schemas/Action', components: document.components });
  for (const [decision, stage, positive] of [['confirm', 'planning', 'approved'], ['final', 'final', 'success']]) {
    const { ports, graph, calls } = fixture();
    graph.moves[0].fields = { planning: { decision, revision_id: ids[1], output_contracts: [{ key: ids[6] }] } };
    ports.mcp = async (endpoint, name, args) => {
      calls.push({ endpoint, name, args });
      if (name === 'elements_graph_get') return graph;
      if (name === 'elements_move_claim') return { attempt: { id: ids[3], executor_kind: 'human', status: 'running' } };
      // Same accepted pairs as current game-core; no database or model involved.
      const metadata = args.result.resources[0].metadata;
      assert.ok(metadata.stage === stage && metadata.outcome === positive || metadata.stage === 'review' && metadata.outcome === 'changes');
      return { attempt: { id: ids[3], status: 'succeeded' } };
    };
    const human = createHumanActions(await createBraiTools(config, ports));
    const prepared = await human.prepare({ moveId: ids[2], revisionId: ids[1], idempotencyKey: 'decision', inputResourceIds: [] });
    assert.equal(prepared.confirmationStage, stage);
    assert.equal(validateAction(prepared), true);
    const args = { moveId: ids[2], revisionId: ids[1], attemptId: ids[3], stage: stage === 'final' ? 'planning' : 'final' };
    await human.complete({ ...args, decision: positive });
    assert.equal(calls.at(-1).args.result.resources[0].metadata.stage, stage);
    await human.complete({ ...args, decision: 'changes', comment: 'Исправить итог' });
    assert.equal(calls.at(-1).args.result.resources[0].metadata.stage, 'review');
    assert.equal(calls.at(-1).args.result.resources[0].content, 'Исправить итог');
    const count = calls.filter(call => call.name === 'elements_move_complete').length;
    await assert.rejects(human.complete({ ...args, decision: positive === 'approved' ? 'success' : 'approved' }), /INVALID_ARGUMENT/);
    assert.equal(calls.filter(call => call.name === 'elements_move_complete').length, count);
    assert.equal(validateAction({ ...prepared, confirmationStage: 'review' }), false);
  }
});

test('practical human output Actions claim only through native owner path; decision-only plan is rejected', async () => {
  for (const [decision, count] of [[null, 1], ['final', 1], ['confirm', 2]]) {
    const { ports, graph, calls } = fixture();
    graph.moves[0].status = 'planned';
    graph.moves[0].fields = { planning: { decision, output_contracts: Array.from({ length: count }, (_, index) => ({ key: ids[6 + index] })) } };
    ports.mcp = async (endpoint, name, args) => {
      calls.push({ endpoint, name, args });
      if (name === 'elements_graph_get') return graph;
      if (name === 'elements_move_claim') return { attempt: { id: ids[3], executor_kind: 'human', status: 'running' } };
      return { status: 'failed' };
    };
    const runtime = await createBraiTools(config, ports), human = createHumanActions(runtime);
    const args = { moveId: ids[2], revisionId: ids[1], idempotencyKey: 'same-key', inputResourceIds: [] };
    assert.equal((await human.read({ moveId: ids[2] })).confirmationStage, decision === 'final' ? 'final' : null);
    if (decision === 'confirm') {
      await assert.rejects(human.prepare(args), /HUMAN_OUTPUT_REQUIRED/);
      assert.equal(calls.filter(call => call.name === 'elements_move_claim').length, 0);
      const dispatch = createTrustedDispatcher(runtime);
      const rejected = await dispatch(JSON.stringify({ jsonrpc: '2.0', id: 'unsupported', method: 'actions.prepare', params: args }));
      assert.equal(rejected.error.data.code, 'HUMAN_OUTPUT_REQUIRED');
      assert.equal(calls.filter(call => call.name === 'elements_move_claim').length, 0);
      continue;
    }
    const prepared = await human.prepare(args);
    assert.equal(prepared.status, 'running');
    assert.equal(calls.filter(call => call.name === 'elements_move_claim').length, 1);
    graph.moves[0].status = 'claimed';
    const recovered = await human.prepare(args);
    assert.equal(recovered.attemptId, ids[3]);
    assert.equal(recovered.confirmationStage, decision === 'final' ? 'final' : null);
    if (decision === null) {
      await assert.rejects(human.complete({ moveId: ids[2], revisionId: ids[1], attemptId: ids[3], stage: 'final', decision: 'success' }), /HUMAN_OUTPUT_REQUIRED/);
      assert.equal(calls.filter(call => call.name === 'elements_move_complete').length, 0);
    }
    await human.cancel({ moveId: ids[2], revisionId: ids[1], attemptId: recovered.attemptId, reason: 'cancelled' });
    assert.equal(calls.at(-1).name, 'elements_move_fail');
  }
});

test('legacy Action retains requested positive stage without a planning DTO field', async () => {
  const { ports, graph, calls } = fixture();
  ports.mcp = async (endpoint, name, args) => {
    calls.push({ endpoint, name, args });
    return name === 'elements_graph_get' ? graph : { attempt: { id: ids[3], status: 'succeeded' } };
  };
  const human = createHumanActions(await createBraiTools(config, ports));
  assert.equal(Object.hasOwn(await human.read({ moveId: ids[2] }), 'confirmationStage'), false);
  for (const stage of ['planning', 'review', 'final']) {
    await human.complete({ moveId: ids[2], revisionId: ids[1], attemptId: ids[3], stage, decision: stage === 'final' ? 'success' : 'approved' });
    assert.equal(calls.at(-1).args.result.resources[0].metadata.stage, stage);
  }
});

test('Telegram plan contains saved task meaning and conditions without technical boundaries', async () => {
  const { ports, graph } = fixture();
  graph.elements[0] = { ...graph.elements[0], kind: 'task', title: 'Подготовить чек-лист', description: 'Проверенный перечень покупок.', fields: { expected_result: 'Ровно три пункта.', constraints: 'Без личных данных.' } };
  const approval = graph.moves[0];
  approval.title = 'Рассмотреть постановку'; approval.previousId = ids[5]; approval.purpose = 'confirm';
  approval.fields = { planning: { decision: 'confirm', revision_id: ids[1], output_contracts: [{}] } };
  graph.moves = [
    { id: ids[6], targetId: ids[0], ownerId: ids[0], previousId: approval.id, kind: 'operation', purpose: 'work', title: 'Написать три пункта', fields: { actor: 'agent', planning: { revision_id: ids[1] } } },
    { id: ids[7], targetId: ids[7], kind: 'operation', purpose: 'work', title: 'Чужой план' }, approval,
    { id: ids[5], targetId: ids[0], previousId: null, kind: 'operation', purpose: 'plan', title: 'Составить план', status: 'succeeded' },
  ];
  const action = await createHumanActions(await createBraiTools(config, ports)).read({ moveId: approval.id });
  assert.match(action.confirmationText, /Подготовить чек-лист[\s\S]*Ровно три пункта[\s\S]*Без личных данных/);
  assert.match(action.confirmationText, /Написать три пункта/);
  assert.doesNotMatch(action.confirmationText, /Составить план|Рассмотреть постановку|Чужой план|00000000-|https?:/);
});

test('final confirmation shows only required actual resources, not all available context', async () => {
  const { ports, graph, calls } = fixture();
  graph.moves[0].fields = { planning: { decision: 'final', output_contracts: [{}] } };
  graph.resources = [
    { id: ids[4], title: 'Чек-лист', content: '1. План.\n2. Почта.\n3. Работа.' },
    { id: ids[6], title: 'Внутренний контекст', content: 'Не для приёмки' },
  ];
  ports.mcp = async (endpoint, name, args) => {
    calls.push({ name, args });
    if (name === 'elements_graph_get') return graph;
    if (name === 'elements_moves_available') return { items: [{ id: ids[2], required_resource_ids: [ids[4]], available_resource_ids: [ids[4], ids[6]] }] };
    return { attempt: { id: ids[3], executor_kind: 'human', status: 'running' } };
  };
  const human = createHumanActions(await createBraiTools(config, ports));
  assert.equal((await human.read({ moveId: ids[2] })).confirmationText, null);
  const prepared = await human.prepare({ moveId: ids[2], revisionId: ids[1], idempotencyKey: 'review' });
  assert.deepEqual(prepared.inputResourceIds, [ids[4]]);
  assert.match(prepared.confirmationText, /1\. План\.\n2\. Почта\.\n3\. Работа\./);
  assert.doesNotMatch(prepared.confirmationText, /Внутренний контекст|Не для приёмки/);
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

test('CLI entry points start through direct and stable directory symlink paths', async () => {
  const tmpRoot = fileURLToPath(new URL('../../../tmp/', import.meta.url));
  await mkdir(tmpRoot, { recursive: true });
  const directory = await mkdtemp(join(tmpRoot, 'hermes-cli-'));
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const link = join(directory, 'runtime');
    await symlink(root, link, 'dir');
    const env = { BRAI_HERMES_CONFIG: join(directory, 'absent-config.json') };
    for (const [name, rejection] of [['tools.mjs', 'HERMES_TOOLS_STARTUP_FAILED'], ['trusted.mjs', 'HERMES_TRUSTED_FAILED'], ['voice.mjs', 'ENOENT']]) {
      for (const base of [root, link]) {
        const result = spawnSync(process.execPath, [join(base, name)], { env, encoding: 'utf8', timeout: 5000 });
        assert.equal(result.error, undefined, name);
        assert.equal(result.signal, null, name);
        assert.equal(result.status, 1, `${name} must start and reject missing config`);
        assert.equal(result.stdout, '', name);
        assert.equal(result.stderr.trim(), rejection, name);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CLI entry points remain importable with nonexistent argv path and no config', () => {
  const modules = ['tools.mjs', 'trusted.mjs', 'voice.mjs'].map(name => new URL(`../${name}`, import.meta.url).href);
  const code = modules.map(url => `await import(${JSON.stringify(url)});`).join('');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, '/nonexistent-hermes-import-argv'], { env: {}, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});


test('trusted text feedback writes actual remarks and delegates cancellation with revision CAS', async () => {
  const { ports, graph, calls } = fixture();
  graph.moves[0].fields = { planning: { decision: 'confirm', revision_id: ids[1], output_contracts: [{ key: ids[6] }] } };
  ports.mcp = async (endpoint, name, args) => {
    calls.push({ endpoint, name, args });
    if (name === 'elements_graph_get') return graph;
    if (name === 'elements_element_activate') return { id: ids[0], status: 'cancelled', element_ids: [ids[0]] };
    return { attempt: { id: ids[3], status: 'succeeded' } };
  };
  const human = createHumanActions(await createBraiTools(config, ports));
  const feedback = { id: ids[7], content: 'Сократи план до нужного результата.', source: { platform: 'telegram', message_id: '42' } };
  const args = { elementId: ids[0], revisionId: ids[1], moveId: ids[2], feedback };
  await human.feedback({ ...args, decision: 'changes' });
  const decision = calls.at(-1).args.result.resources[0];
  assert.equal(decision.content, feedback.content);
  assert.deepEqual(decision.metadata.source, feedback.source);
  assert.equal(decision.metadata.outcome, 'changes');
  await human.feedback({ ...args, decision: 'cancelled' });
  assert.equal(calls.at(-1).name, 'elements_element_activate');
  assert.deepEqual(calls.at(-1).args, { element_id: ids[0], revision_id: ids[1], cancel: true, feedback });
  await assert.rejects(human.feedback({ ...args, decision: 'approved' }), /INVALID_ARGUMENT/);
  await assert.rejects(human.feedback({ ...args, elementId: ids[5], decision: 'cancelled' }), /NOT_FOUND/);
});

test('clarification feedback completes only the real clarification Action with answered provenance', async () => {
  const { graph } = fixture(), calls = [];
  graph.moves[0] = { id: ids[2], kind: 'action', targetId: ids[0], attemptId: ids[3], executor: 'human',
    status: 'claimed', title: 'Уточнить поручение', input: [], instructions: 'Какой результат считать готовым?',
    fields: { planning: { decision: 'clarify', output_contracts: [{ key: 'answer' }] } } };
  graph.attempts[0] = { id: ids[3], moveId: ids[2], status: 'running' };
  const human = createHumanActions({ graph: async () => graph, elementsCall: async (name, args) => {
    calls.push({ name, args }); return { attempt: { id: ids[3], status: 'succeeded' } };
  } });
  const feedback = { id: ids[7], content: 'Письменное подтверждение от поставщика.', source: { platform: 'telegram', message_id: '43' } };
  await human.feedback({ elementId: ids[0], revisionId: ids[1], moveId: ids[2], decision: 'clarify', feedback });
  const result = calls[0].args.result.resources[0];
  assert.equal(calls[0].name, 'elements_move_complete');
  assert.equal(result.content, feedback.content);
  assert.deepEqual(result.metadata, { element_id: ids[0], revision_id: ids[1], stage: 'clarification', outcome: 'answered', source: feedback.source });
  await assert.rejects(human.feedback({ elementId: ids[0], revisionId: ids[1], moveId: ids[2], decision: 'changes', feedback }), /HUMAN_OUTPUT_REQUIRED/);
});

test('practical final result needs an explicit human decision and records both real message sources', async () => {
  const { ports, graph, calls } = fixture();
  graph.moves[0].status = 'claimed';
  graph.moves[0].attemptId = ids[3];
  graph.moves[0].fields = { planning: { decision: 'final', revision_id: ids[1], output_contracts: [{ key: 'result', name: 'Отчёт', content: 'Фактический отчёт' }] } };
  graph.attempts[0] = { id: ids[3], moveId: ids[2], status: 'running', executorKind: 'human' };
  ports.mcp = async (endpoint, name, args) => {
    calls.push({ endpoint, name, args });
    if (name === 'elements_graph_get') return graph;
    return { attempt: { id: ids[3], status: 'succeeded' } };
  };
  const human = createHumanActions(await createBraiTools(config, ports));
  await assert.rejects(human.result({ moveId: ids[2], revisionId: ids[1], content: 'Забрал и проверил часы.', source: { message_id: '41' } }), /HUMAN_FINAL_DECISION_REQUIRED/);
  const result = await human.result({ moveId: ids[2], revisionId: ids[1], content: 'Забрал и проверил часы.', source: { message_id: '41' },
    decisionText: 'Всё принимаю.', decisionSource: { message_id: '42' } });
  assert.equal(result.attempt.status, 'succeeded');
  const payload = calls.filter(call => call.name === 'elements_move_complete').at(-1).args.result.resources[0];
  assert.equal(payload.content, 'Забрал и проверил часы.');
  assert.equal(payload.output_key, 'result');
  assert.equal(payload.metadata.outcome, 'success');
  assert.deepEqual(payload.metadata.source, { message_id: '42' });
  assert.deepEqual(payload.metadata.practical_source, { message_id: '41' });
});

test('native stop recovery fails only the exact running agent Operation attempt', async () => {
  const { graph } = fixture(), calls = [];
  graph.moves[0] = { id: ids[2], kind: 'operation', targetId: ids[0], attemptId: ids[3], executor: 'agent', status: 'claimed' };
  graph.attempts[0] = { id: ids[3], moveId: ids[2], status: 'running', executor_kind: 'agent' };
  const human = createHumanActions({ graph: async () => graph, elementsCall: async (name, args) => { calls.push({ name, args }); return { attempt: { id: ids[3], status: 'failed' } }; } });
  await human.failAgent({ moveId: ids[2], attemptId: ids[3] });
  assert.deepEqual(calls, [{ name: 'elements_move_fail', args: { attempt_id: ids[3], error_code: 'AGENT_STOPPED' } }]);
  graph.moves[0].attemptId = ids[4];
  graph.attempts.push({ id: ids[4], moveId: ids[2], status: 'running', executor_kind: 'agent' });
  const replaced = await human.failAgent({ moveId: ids[2], attemptId: ids[3] });
  assert.equal(replaced.status, 'already_stopped');
  assert.equal(calls.length, 1);
  graph.moves[0].executor = 'human';
  await assert.rejects(human.failAgent({ moveId: ids[2], attemptId: ids[3] }), /FORBIDDEN/);
});


test('draft acceptance keeps current revision meaning without lifecycle Move titles', async () => {
  const { ports, graph } = fixture();
  graph.elements[0].kind = 'goal'; graph.elements[0].title = 'Текущий результат'; graph.elements[0].description = 'Текущий итог';
  graph.elements[0].fields = { planning: {}, expected_result: 'Текущий итог', draft: { title: 'Подготовить документы', expected_result: 'Текущий итог' } };
  graph.moves[0].fields = { planning: { decision: 'confirm', revision_id: ids[1], output_contracts: [{ key: ids[6] }] } };
  graph.moves[0].title = 'Рассмотреть новую постановку'; graph.moves[0].previousId = ids[4];
  graph.moves.push({ id: ids[4], ownerId: ids[0], targetId: ids[0], title: 'Доработать текущий план', status: 'succeeded' },
    { id: ids[5], ownerId: ids[0], targetId: ids[0], title: 'Старая постановка', status: 'succeeded' },
    { id: ids[6], ownerId: ids[0], targetId: ids[0], title: 'Старое рассмотрение', status: 'succeeded', fields: { planning: { revision_id: ids[7] } } });
  graph.resources = [{ metadata: { plan_revision_id: ids[1], receipt: { operation: ids[4] } } }];
  const action = await createHumanActions(await createBraiTools(config, ports)).read({ moveId: ids[2] });
  assert.match(action.confirmationText, /Текущий итог/);
  assert.match(action.confirmationText, /Принять этот план/);
  assert.doesNotMatch(action.confirmationText, /Доработать текущий план|Рассмотреть новую постановку/);
  assert.doesNotMatch(action.confirmationText, /Старая постановка|Старое рассмотрение/);
});


// A real HTTP peer reproduces owner restart/session loss without touching business data.
async function restartedOwner(t, invalidStatus = 404) {
  let generation = 1, initializes = 0, effects = 0, drop = false;
  const calls = [], waiting = [];
  let hold = false;
  const http = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    let bytes = ''; for await (const part of req) bytes += part;
    const body = JSON.parse(bytes);
    if (!body.id && body.id !== 0) { res.writeHead(202).end(); return; }
    const reply = result => { res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': String(generation) }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); };
    if (body.method === 'initialize') { initializes++; reply({ protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic-owner', version: '1' } }); return; }
    if (req.headers['mcp-session-id'] !== String(generation)) { res.writeHead(invalidStatus).end('Bad Request: Server not initialized'); return; }
    if (body.method === 'tools/list') { reply({ tools: [
      { name: 'elements_planning_build', inputSchema: schema({ attempt_id: { type: 'string' }, candidate: { type: 'object' } }) },
      { name: 'elements_timeline_get', inputSchema: schema({}) },
    ] }); return; }
    calls.push(body.params.name);
    if (hold) { waiting.push(() => { res.writeHead(500).end('synthetic transport failure'); }); return; }
    if (body.params.name === 'elements_planning_build') {
      effects++;
      if (drop) { drop = false; req.socket.destroy(); return; }
    }
    reply({ content: [], structuredContent: { effects } });
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const endpoint = await connectMcpEndpoint({ url: `http://127.0.0.1:${http.address().port}/mcp` }, { timeout: 1000, callTimeout: 1000 });
  t.after(async () => { await endpoint.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  const runtime = await createBraiTools(config, { list: async name => name === 'elements' ? (await endpoint.list()).tools : [],
    mcp: async (_, name, args, signal) => unwrap(await endpoint.call(name, args, signal)), close: async () => {} });
  return { runtime, endpoint, calls, waiting, restart: () => { generation++; }, dropReply: () => { drop = true; }, hold: () => { hold = true; },
    release: () => { hold = false; }, counts: () => ({ initializes, effects }) };
}

for (const status of [400, 404]) test(`owner session HTTP ${status} never replays mutation; next explicit read reconnects`, async t => {
  const owner = await restartedOwner(t, status);
  owner.restart();
  await assert.rejects(owner.runtime.call('elements_planning_build', { attempt_id: ids[0], candidate: {} }), error => error.code === 'OUTCOME_UNKNOWN' && error.requestId === ids[0]);
  assert.deepEqual(owner.counts(), { initializes: 1, effects: 0 });
  assert.deepEqual(await owner.runtime.call('elements_timeline_get', {}), { effects: 0 });
  assert.deepEqual(owner.counts(), { initializes: 2, effects: 0 });
  assert.deepEqual(owner.calls, ['elements_timeline_get']);
});

test('lost mutation reply stays unknown; explicit reconciliation sees one persisted effect', async t => {
  const owner = await restartedOwner(t); owner.dropReply();
  await assert.rejects(owner.runtime.call('elements_planning_build', { attempt_id: ids[0], candidate: {} }), /OUTCOME_UNKNOWN/);
  assert.deepEqual(await owner.runtime.call('elements_timeline_get', {}), { effects: 1 });
  assert.deepEqual(owner.counts(), { initializes: 2, effects: 1 });
  assert.deepEqual(owner.calls, ['elements_planning_build', 'elements_timeline_get']);
});

test('late old-generation failure preserves a replacement client during concurrent calls', async t => {
  const owner = await restartedOwner(t); owner.hold();
  const first = owner.endpoint.call('elements_timeline_get', {}).catch(error => error);
  const second = owner.endpoint.call('elements_timeline_get', {}).catch(error => error);
  while (owner.waiting.length !== 2) await new Promise(resolve => setTimeout(resolve, 1));
  owner.waiting[0](); await first;
  owner.release();
  assert.deepEqual(unwrap(await owner.endpoint.call('elements_timeline_get', {})), { effects: 0 });
  owner.waiting[1](); await second;
  assert.deepEqual(unwrap(await owner.endpoint.call('elements_timeline_get', {})), { effects: 0 });
  assert.equal(owner.counts().initializes, 2);
});
