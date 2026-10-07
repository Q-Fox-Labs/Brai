// ABOUTME: Проверяет согласованность транспортных описаний с owner DTO transcription.
// ABOUTME: Проверяет refs и границы приватности, не запускает HTTP, MCP, NATS или RPC серверы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { methodMap, schemas } from '../../contracts/index.mjs';

const base = new URL('../../contracts/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, base), 'utf8'));
const schemaRef = name => `../schemas/messages.schema.json#/definitions/${name}`;

/** Разрешает локальный JSON pointer без копирования owner определения. */
function resolveRef(ref, document, filename) {
  const [path, fragment = ''] = ref.split('#');
  const target = path ? JSON.parse(readFileSync(new URL(path, new URL(filename, base)), 'utf8')) : document;
  return fragment.split('/').slice(1).reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], target);
}

/** Проверяет все ссылки конкретного описания, включая owner property pointers. */
function verifyRefs(value, document, filename) {
  if (!value || typeof value !== 'object') return;
  if (value.$ref) assert.notEqual(resolveRef(value.$ref, document, filename), undefined, `${filename}: ${value.$ref}`);
  for (const item of Object.values(value)) verifyRefs(item, document, filename);
}

test('three OpenRPC contracts describe every fixed method with named owner properties', () => {
  for (const program of ['helper', 'local', 'external']) {
    const filename = `${program}.openrpc.json`;
    const document = read(filename);
    verifyRefs(document, document, filename);
    assert.equal(document.openrpc, '1.3.2');
    assert.deepEqual(document.methods.map(method => method.name).sort(), Object.keys(methodMap[program]).sort());
    for (const method of document.methods) {
      const [params, result] = methodMap[program][method.name];
      assert.equal(method['x-params-schema'].$ref, schemaRef(params));
      assert.equal(method.result.schema.$ref, schemaRef(result));
      assert.equal(method.paramStructure, 'by-name');
      assert.deepEqual(method.params.map(param => param.name).sort(), Object.keys(schemas.definitions[params].properties).sort());
      assert.ok(method.errors.some(error => error.code === -32602));
      assert.equal(method.errors.find(error => error.code === -32000)['x-data-schema'].$ref, schemaRef('ErrorResponse'));
    }
  }
});

test('NATS exposes exactly six metadata operations and safe service errors', () => {
  const filename = 'asyncapi.json';
  const document = read(filename);
  verifyRefs(document, document, filename);
  const publicMethods = Object.keys(methodMap.public).filter(method => method !== 'result.get');
  assert.equal(Object.keys(document.operations).length, 7);
  assert.deepEqual(Object.values(document.channels).map(channel => channel.address).filter(address => address && address !== 'brai.alerts.v1.ingest').sort(), publicMethods.map(method => 'brai.transcription.v1.' + method).sort());
  for (const method of publicMethods) {
    const [params, result] = methodMap.public[method];
    assert.equal(document.components.messages[params].payload.$ref, schemaRef(params));
    assert.equal(document.components.messages[result].payload.$ref, schemaRef(result));
  }
  for (const operation of Object.values(document.operations).filter(operation => operation.action !== 'send')) assert.deepEqual(operation.bindings.nats, { queue: 'brai_transcription', bindingVersion: '0.1.0' });
  assert.equal(document.components.messages.ErrorResponse.headers.properties['Nats-Service-Error'].$ref, schemaRef('ErrorCode'));
  assert.equal(document.components.messages.PublicResult, undefined);
  assert.equal(document.components.messages.ResultGetResult, undefined);
  assert.deepEqual(document.components.messages.ErrorResponse.headers.required, ['Nats-Service-Error', 'Nats-Service-Error-Code']);
});

test('HTTP and MCP expose identical seven public owner DTO pairs; text has no-store', () => {
  const http = read('http.openapi.json');
  const mcp = read('mcp.json');
  verifyRefs(http, http, 'http.openapi.json');
  verifyRefs(mcp, mcp, 'mcp.json');
  assert.equal(Object.keys(http.paths).length, 7);
  assert.equal(mcp.tools.length, 7);
  for (const [method, [params, result]] of Object.entries(methodMap.public)) {
    const operation = http.paths['/v1/transcription/' + method].post;
    assert.equal(operation.requestBody.content['application/json'].schema.$ref, schemaRef(params));
    assert.equal(operation.responses['200'].content['application/json'].schema.$ref, schemaRef(result));
    assert.equal(operation.responses.default.content['application/json'].schema.$ref, schemaRef('ErrorResponse'));
    const tool = mcp.tools.find(item => item.name === 'transcription_' + method.replaceAll('.', '_'));
    assert.equal(tool.inputSchema.$ref, schemaRef(params));
    assert.equal(tool.outputSchema.$ref, schemaRef(result));
  }
  assert.equal(http.paths['/v1/transcription/result.get'].post.responses['200'].headers['Cache-Control'].schema.const, 'no-store');
});
