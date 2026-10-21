// ABOUTME: Проверяет схемы Elements и настоящий MCP HTTP initialize/list/call lifecycle.
// ABOUTME: HTTP использует синтетический backend в памяти, без БД и пользовательских данных.
import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcp, toolInputs, toolNames } from '../dist/mcp.js';
import { createLoadGate } from '../dist/load.js';
import { ElementsFault } from '../dist/domain.js';

const elementId = '00000000-0000-4000-8000-000000000001';
const moveId = '00000000-0000-4000-8000-000000000002';
const canonicalBatch = {
  elements: [{ id: elementId, kind: 'task', title: 'Синтетическая проверка' }],
  moves: [{ id: moveId, element_id: elementId, kind: 'action', purpose: 'confirm', title: 'Подтвердить план', instructions: 'Рассмотреть план', result_schema: { type: 'object' } },
    { element_id: elementId, previous_move_id: moveId, kind: 'operation', purpose: 'work', title: 'Продолжить', instructions: 'Выполнить следующий шаг', result_schema: { type: 'object' } }],
};

test('MCP публикует полный набор инструментов Elements', () => {
  assert.deepEqual(toolNames, [
    'elements_structure_create',
    'elements_element_create',
    'elements_element_revise',
    'elements_element_reclassify',
    'elements_move_create',
    'elements_move_link',
    'elements_element_activate',
    'elements_graph_get',
    'elements_timeline_get',
    'elements_moves_available',
    'elements_move_claim',
    'elements_move_complete',
    'elements_move_fail',
    'elements_planning_packet',
    'elements_planning_bind',
    'elements_planning_build',
    'elements_planning_apply',
    'elements_planning_expand_repeat',
  ]);
  for (const name of toolNames) {
    const schema = toolInputs[name];
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.equal(Object.hasOwn(schema.properties ?? {}, 'user_id'), false);
  }
});

test('MCP требует JSON Schema результата для элементов и ходов', () => {
  assert.deepEqual(toolInputs.elements_element_create.required, ['kind', 'title']);
  assert.deepEqual(toolInputs.elements_move_create.required, ['element_id', 'kind', 'title', 'instructions', 'result_schema']);
  assert.equal(toolInputs.elements_move_complete.required.includes('result'), true);
});

test('structure_create exposes standalone nested schemas and rejects the actual malformed batch', () => {
  const schema = toolInputs.elements_structure_create;
  assert.equal(schema.properties.elements.items, toolInputs.elements_element_create);
  assert.equal(schema.properties.moves.items, toolInputs.elements_move_create);
  const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
  const validate = ajv.compile(schema);
  const malformed = { elements: [{ title: 'Синтетическая проверка' }],
    moves: [{ title: 'Подтвердить', executor_kind: 'human', stage: 'planning', description: 'Рассмотреть план' }] };
  assert.equal(validate(malformed), false);
  assert.ok(validate.errors.some(error => error.instancePath === '/elements/0' && error.keyword === 'required' && error.params.missingProperty === 'kind'));
  assert.equal(validate(canonicalBatch), true, 'new UUIDs can be referenced by later records in the same batch');
  for (const [list, field, value] of [['elements', 'kind', 'unknown'], ['moves', 'element_id', 'placeholder'], ['elements', 'owner_id', 'forged'], ['elements', 'user_id', 'forged'], ['moves', 'owner_id', 'forged'], ['moves', 'user_id', 'forged'], ['moves', 'executor_kind', 'human'], ['moves', 'stage', 'planning'], ['moves', 'status', 'succeeded'], ['moves', 'description', 'wrong field']]) {
    const invalid = structuredClone(canonicalBatch); invalid[list][0][field] = value;
    assert.equal(validate(invalid), false, `${list}.${field} is not a valid create field/value`);
  }
});

test('HTTP MCP инициализирует сессию, перечисляет и вызывает owner-bound инструменты', { timeout: 10_000 }, async () => {
  const owner = 'mcp-test-owner', calls = [], creates = [];
  const graph = { elements: [{ id: '00000000-0000-4000-8000-000000000001', title: 'Synthetic task' }], moves: [], attempts: [], resources: [] };
  const handlers = {
    async structureCreate(args, context) {
      creates.push({ args, actorId: context.actorId });
      return { elements: [{ id: elementId }], moves: [{ id: moveId }] };
    },
    async graphGet(args, context) {
      calls.push({ args, actorId: context.actorId });
      if (args.root_id) throw new ElementsFault('NOT_FOUND');
      return structuredClone(graph);
    },
  };
  const config = { mcpHost: '127.0.0.1', mcpPort: 0, mcpOwnerId: owner, mcpAllowedHosts: [], mcpAllowedOrigins: [] };
  const gate = createLoadGate(), runtime = await startMcp(config, handlers, gate);
  const url = new URL(runtime.url);
  config.mcpAllowedHosts.push(url.host); config.mcpAllowedOrigins.push(url.origin);
  const client = new Client({ name: 'elements-http-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url);
  try {
    await client.connect(transport, { timeout: 1000 });
    assert.equal(client.getServerVersion().name, 'brai-elements');
    assert.ok(transport.sessionId, 'initialize creates a reusable HTTP session');
    const listed = (await client.listTools()).tools;
    assert.deepEqual(listed.map(tool => tool.name), [...toolNames]);
    const advertised = listed.find(tool => tool.name === 'elements_structure_create').inputSchema;
    assert.deepEqual(advertised.properties.elements.items, toolInputs.elements_element_create);
    assert.deepEqual(advertised.properties.moves.items, toolInputs.elements_move_create);
    const created = await client.callTool({ name: 'elements_structure_create', arguments: canonicalBatch });
    assert.notEqual(created.isError, true);
    assert.deepEqual(creates, [{ args: { ...canonicalBatch, user_id: owner }, actorId: owner }]);

    const result = await client.callTool({ name: 'elements_graph_get', arguments: { depth: 1, user_id: 'forged-owner' } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.structuredContent, graph);
    assert.deepEqual(calls[0], { args: { depth: 1, user_id: owner }, actorId: owner });

    const failure = await client.callTool({ name: 'elements_graph_get', arguments: { root_id: graph.elements[0].id } });
    assert.equal(failure.isError, true);
    assert.equal(failure.structuredContent, undefined);
    assert.deepEqual(JSON.parse(failure.content[0].text), { code: 'NOT_FOUND', message: 'NOT_FOUND', retryable: false });

    const sessionId = transport.sessionId;
    await transport.terminateSession();
    const closed = await fetch(url, { headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId } });
    assert.equal(closed.status, 404, 'DELETE removes the initialized session');
    await closed.body?.cancel();
  } finally {
    await client.close(); gate.stopAccepting(); await gate.drain(); await runtime.close();
  }
  assert.equal(runtime.http.listening, false);
});
