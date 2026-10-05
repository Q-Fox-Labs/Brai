// ABOUTME: Проверяет реальные helper/artifacts/history и настоящий coordinator через HTTP/MCP/NATS.
// ABOUTME: Только изолированные синтетические fixtures; external отказывает, распознавание и живой transcript не заявляются.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { connect, headers } from 'nats';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadCoordinatorConfig } from '../../dist/coordinator/config.js';
import { methodMap, validateDto } from '../../contracts/index.mjs';
import { subjects as artifactSubjects, validateRequest as artifactRequest, validateResponse as artifactResponse } from '../../../artifacts/contracts/index.mjs';
import historyCommon from '../../../history/schemas/common.schema.json' with { type: 'json' };
import historyMessages from '../../../history/schemas/messages.schema.json' with { type: 'json' };

const responseBytes = 262144;
const requestTimeout = 10000;
const fixtureOwnerPrefix = 'transcription-acceptance-';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deadline(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer));
}
function ownNats(settings, user, inboxPrefix) {
  let url;
  try { url = new URL(settings.servers); } catch { throw new Error('Invalid own fixture NATS configuration'); }
  assert.ok(url.protocol === 'nats:' && url.hostname === '127.0.0.1' && url.port === '19680' && !url.username && !url.password && !url.search && !url.hash && (!url.pathname || url.pathname === '/'), 'own isolated NATS only');
  assert.ok(settings.user === user && settings.inboxPrefix === inboxPrefix && typeof settings.pass === 'string' && settings.pass.length > 0 && !settings.token, 'explicit fixture principal required');
}
function clientSettings(prefix, user, inboxPrefix) {
  const settings = { servers: process.env[`${prefix}URL`], user: process.env[`${prefix}USER`], pass: process.env[`${prefix}PASSWORD`], inboxPrefix: process.env[`${prefix}INBOX_PREFIX`] };
  ownNats(settings, user, inboxPrefix);
  return settings;
}
function ownHttp(value, host, port, pathPrefix) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid own fixture HTTP URL'); }
  assert.ok(url.protocol === 'http:' && url.hostname === host && url.port === port && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith(pathPrefix), 'own isolated HTTP only');
  return url;
}
async function jsonBody(response) {
  const reader = response.body.getReader();
  const bytes = Buffer.allocUnsafe(responseBytes);
  let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      if (length + next.value.length > responseBytes) throw new Error('Fixture response exceeds byte limit');
      bytes.set(next.value, length); length += next.value.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { await reader.cancel().catch(() => {}); }
}
async function natsJson(nc, subject, input, requestHeaders) {
  const encoded = Buffer.from(JSON.stringify(input));
  assert.ok(encoded.length <= 65536, 'bounded fixture request');
  const message = await nc.request(subject, encoded, { timeout: requestTimeout, headers: requestHeaders });
  assert.ok(message.data.length <= responseBytes, 'bounded fixture response');
  return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message.data)), headers: message.headers };
}
function auth(binding) { const value = headers(); value.set('Authorization', `Bearer ${binding.token}`); return value; }
function publicResult(method, result) { assert.ok(validateDto(methodMap.public[method][1], result), 'owner public result DTO'); return result; }
function syntheticWave() {
  const bytes = Buffer.alloc(364); // 160 mono PCM silence samples; no user audio.
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
function coordinatorProcess(config) {
  const child = fork(fileURLToPath(new URL('./fixtures/coordinator-process.mjs', import.meta.url)), [], { env: {}, execArgv: [], detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let sequence = 0;
  let outputBytes = 0;
  let exited = false;
  const pending = new Map();
  child.stdout.on('data', (chunk) => { outputBytes += chunk.length; });
  child.stderr.on('data', (chunk) => { outputBytes += chunk.length; });
  const exit = new Promise((resolve) => child.once('exit', () => { exited = true; for (const reject of pending.values()) reject(new Error('Fixture coordinator exited')); pending.clear(); resolve(); }));
  child.on('error', () => { for (const reject of pending.values()) reject(new Error('Fixture coordinator unavailable')); pending.clear(); });
  const call = (action, extra = {}, ms = requestTimeout) => {
    const id = ++sequence;
    let receive;
    return deadline(new Promise((resolve, reject) => {
      receive = (message) => { if (message.id === id) resolve(message); };
      pending.set(id, reject); child.on('message', receive);
      child.send({ id, action, ...extra }, (error) => { if (error) reject(new Error('Fixture IPC unavailable')); });
    }), ms, 'Fixture coordinator deadline').finally(() => { child.off('message', receive); pending.delete(id); });
  };
  let cleanup;
  const close = () => cleanup ??= (async () => {
    try {
      try { if (!exited) await call('close', {}, 15000); } catch { /* Own process group terminated below. */ }
      if (!exited) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already gone. */ } }
      await deadline(exit, 5000, 'Fixture shutdown deadline');
    } finally {
      // Even a shutdown failure or unexpected harness exit cannot leave its own three children behind.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* No remaining own group. */ }
      if (!exited) await deadline(exit, 5000, 'Fixture forced shutdown deadline');
    }
    assert.equal(outputBytes, 0, 'coordinator output contains no diagnostics or payload');
  })();
  return { start: () => call('start', { config }, 45000), status: () => call('status'), close };
}

test('actual guarded metadata path: three real children, seven HTTP/MCP methods, six NATS metadata endpoints and delivered history', { timeout: 180000 }, async (t) => {
  assert.equal(process.env.TRANSCRIPTION_TEST_METADATA, '1', 'explicit own-fixture activation required');
  const config = loadCoordinatorConfig(process.env);
  assert.ok(config.children.helper.PGHOST === '127.0.0.1' && config.children.helper.PGPORT === '19679' && config.children.helper.PGDATABASE === 'brai_transcription_acceptance' && config.children.helper.PGUSER === 'transcription_app', 'own app-role database only');
  assert.ok(config.http.host === '127.0.0.1' && config.http.port === 19682 && config.http.allowedHosts.includes('127.0.0.1:19682'), 'own coordinator listener only');
  assert.ok(config.localAi === undefined, 'metadata acceptance has no recognition runtime');
  ownNats(config.nats, 'transcription', '_INBOX.brai_transcription');
  assert.ok(config.bindings.every((binding) => binding.principal.scopeType === 'user' && binding.principal.ownerId.startsWith(fixtureOwnerPrefix) && binding.principal.scopeId.startsWith(fixtureOwnerPrefix)), 'synthetic fixture identities only');
  const writer = config.bindings.find((binding) => binding.principal.permissions.includes('transcription:use') && binding.principal.permissions.includes('transcription:settings:write'));
  const other = config.bindings.find((binding) => binding.principal.ownerId !== writer?.principal.ownerId && binding.principal.scopeId !== writer?.principal.scopeId && binding.principal.permissions.includes('transcription:use') && !binding.principal.permissions.includes('transcription:settings:write'));
  assert.ok(writer && other, 'two independent fixture identities required');
  const uploaderSettings = clientSettings('TRANSCRIPTION_TEST_ARTIFACT_NATS_', 'test_uploader', '_INBOX.brai_artifacts_test');
  const historySettings = clientSettings('TRANSCRIPTION_TEST_HISTORY_NATS_', 'history_reader', '_INBOX.brai_history_test');
  const publicSettings = clientSettings('TRANSCRIPTION_TEST_PUBLIC_NATS_', 'transcription_test', '_INBOX.brai_transcription_test');
  const connections = [];
  const createdArtifacts = [];
  let processFixture;
  let client;
  let uploader;
  t.after(async () => {
    let failed = false;
    try {
      try { if (client) await deadline(client.close(), 10000, 'Fixture MCP shutdown deadline'); } catch { failed = true; }
      try { await processFixture?.close(); } catch { failed = true; }
      // Ordered cleanup keeps uploader available until all newly-created artifacts are removed.
      for (const artifactId of createdArtifacts) {
        try {
          const input = { requestId: randomUUID(), artifactId };
          assert.ok(artifactRequest(artifactSubjects.delete, input));
          const removed = await natsJson(uploader, artifactSubjects.delete, input);
          assert.ok(!removed.headers?.get('Nats-Service-Error') && artifactResponse(artifactSubjects.delete, removed.value) && removed.value.status === 'deleted');
        } catch { failed = true; }
      }
    } finally {
      const stopped = await Promise.allSettled(connections.map((connection) => connection.close()));
      if (stopped.some((result) => result.status === 'rejected')) failed = true;
    }
    assert.ok(!failed, 'own fixture processes/artifacts cleaned up');
  });
  const open = async (settings) => { const nc = await connect({ ...settings, reconnect: false, timeout: 5000 }); connections.push(nc); return nc; };
  uploader = await open(uploaderSettings);
  const historyReader = await open(historySettings);
  const publicClient = await open(publicSettings);
  const prepare = { requestId: randomUUID(), ownerId: writer.principal.ownerId, kind: 'original', metadata: { title: 'Synthetic metadata acceptance', filename: 'silence.wav', extension: 'wav', mimeType: 'audio/wav', source: 'transcription_acceptance' } };
  assert.ok(artifactRequest(artifactSubjects.prepare, prepare));
  const prepared = await natsJson(uploader, artifactSubjects.prepare, prepare);
  assert.ok(!prepared.headers?.get('Nats-Service-Error') && artifactResponse(artifactSubjects.prepare, prepared.value) &&
    prepared.value.artifact.ownerId === prepare.ownerId && prepared.value.artifact.requestId === prepare.requestId, 'real correlated owner prepare response');
  const artifactId = prepared.value.artifact.artifactId; createdArtifacts.push(artifactId);
  const uploadUrl = ownHttp(prepared.value.uploadUrl, '172.31.246.1', '19681', '/upload/');
  const wave = syntheticWave();
  const uploaded = await fetch(uploadUrl, { method: 'PUT', body: wave, headers: { 'content-type': 'audio/wav' }, signal: AbortSignal.timeout(requestTimeout), redirect: 'error' });
  assert.ok(uploaded.status === 201 && uploaded.headers.get('x-artifact-id') === artifactId && uploaded.headers.get('x-artifact-state') === 'ready' && Number(uploaded.headers.get('x-artifact-size')) === wave.length, 'real upload became ready');
  ownHttp(uploaded.headers.get('location'), '172.31.246.1', '19684', '/files/');
  await uploaded.arrayBuffer();

  processFixture = coordinatorProcess(config);
  const startup = await processFixture.start();
  assert.ok(startup.okay && startup.address.address === '127.0.0.1' && startup.address.port === 19682, 'actual main started');
  const status = await processFixture.status();
  assert.ok(status.okay && status.status.metadataReady && !status.status.ready, 'metadata ready; recognition unavailable');
  assert.deepEqual(status.status.localExecutor, { configured: false, verified: false, available: false });
  const baseUrl = 'http://127.0.0.1:19682';
  const http = async (method, input, binding = writer, extraHeaders = {}) => {
    const response = await fetch(`${baseUrl}/v1/transcription/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: binding ? `Bearer ${binding.token}` : '', ...extraHeaders }, body: JSON.stringify(input), signal: AbortSignal.timeout(requestTimeout), redirect: 'error' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, value: await jsonBody(response) };
  };
  const api = async (method, input, binding = writer) => { const reply = await http(method, input, binding); assert.equal(reply.status, 200); return publicResult(method, reply.value); };
  const nats = async (method, input, binding = writer) => {
    const reply = await natsJson(publicClient, `brai.transcription.v1.${method}`, input, binding ? auth(binding) : headers());
    assert.ok(!reply.headers?.get('Nats-Service-Error'), 'successful public NATS metadata');
    return publicResult(method, reply.value);
  };
  client = new Client({ name: 'transcription-real-metadata-acceptance', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(baseUrl + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${writer.token}` } } }));
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), Object.keys(methodMap.public).map((method) => `transcription_${method.replaceAll('.', '_')}`).sort());
  const mcp = async (method, input) => { const result = await client.callTool({ name: `transcription_${method.replaceAll('.', '_')}`, arguments: input }, undefined, { timeout: requestTimeout }); assert.ok(!result.isError); return publicResult(method, result.structuredContent); };
  const infoMessage = await publicClient.request('$SRV.INFO.brai_transcription', undefined, { timeout: requestTimeout });
  assert.ok(infoMessage.data.length <= responseBytes);
  const info = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(infoMessage.data));
  assert.deepEqual(info.endpoints.map((endpoint) => endpoint.subject).sort(), Object.keys(methodMap.public).filter((method) => method !== 'result.get').map((method) => `brai.transcription.v1.${method}`).sort());

  const denied = await http('settings.get', {}, undefined);
  assert.ok(denied.status === 401 && validateDto('ErrorResponse', denied.value) && denied.value.errorCode === 'UNAUTHENTICATED');
  const injected = await http('settings.get', { ownerId: other.principal.ownerId });
  assert.ok(injected.status === 400 && injected.value.errorCode === 'INVALID_ARGUMENT');
  const forbidden = await http('settings.set', { settings: { defaultLocalModel: null, allowReplacement: false, policyVersion: 1 }, expectedRevision: 1 }, other);
  assert.ok(forbidden.status === 403 && forbidden.value.errorCode === 'FORBIDDEN');
  const rejectedNats = await natsJson(publicClient, 'brai.transcription.v1.settings.get', {}, headers());
  assert.ok(rejectedNats.headers.get('Nats-Service-Error') === 'UNAUTHENTICATED' && rejectedNats.headers.get('Nats-Service-Error-Code') === '401' && validateDto('ErrorResponse', rejectedNats.value));
  const rejectedMcp = await client.callTool({ name: 'transcription_settings_get', arguments: { ownerId: other.principal.ownerId } });
  assert.ok(rejectedMcp.isError && rejectedMcp.structuredContent === undefined && JSON.parse(rejectedMcp.content.at(-1).text).errorCode === 'INVALID_ARGUMENT');
  for (const caller of [api, mcp, nats]) {
    const current = await caller('settings.get', {});
    const changed = await caller('settings.set', { settings: { ...current.settings, policyVersion: current.settings.policyVersion + 1 }, expectedRevision: current.revision });
    assert.equal(changed.revision, current.revision + 1);
    assert.deepEqual(await caller('models.list', {}), { localCatalogState: 'unavailable', localItems: [], externalAvailable: false, externalItems: [], catalogErrorCode: 'MODEL_CATALOG_UNAVAILABLE' });
  }
  // Owner policy является общей; отдельное write permission защищает изменения, а не скрывает настройки.
  assert.deepEqual(await api('settings.get', {}, other), await api('settings.get', {}), 'common owner policy readable by permitted identities');
  const submitted = { clientIdempotencyKey: randomUUID(), audioArtifactId: artifactId, requestedModel: { route: 'external', selection: 'required' }, deadlineAt: null };
  const wrongOwner = await http('request.submit', { ...submitted, clientIdempotencyKey: randomUUID() }, other);
  assert.ok(wrongOwner.status === 403 && wrongOwner.value.errorCode === 'ARTIFACT_OWNER_MISMATCH', 'real artifact owner gate');
  const accepted = await api('request.submit', submitted);
  const requestId = accepted.request.requestId;
  for (const caller of [mcp, nats]) assert.equal((await caller('request.submit', submitted)).request.requestId, requestId, 'public idempotency across transports');
  let terminal;
  const terminalDeadline = Date.now() + 30000;
  do {
    terminal = await api('request.get', { requestId });
    if (terminal.request.taskState === 'failed') break;
    await pause(100);
  } while (Date.now() < terminalDeadline);
  assert.ok(terminal.request.taskState === 'failed' && terminal.request.errorCode === 'EXTERNAL_ROUTE_UNAVAILABLE' && terminal.request.actualModel === null && terminal.request.resultState === 'not_ready', 'actual external executor refuses; no recognition success');
  for (const caller of [mcp, nats]) assert.deepEqual(await caller('request.get', { requestId }), terminal);
  const unavailable = await api('result.get', { requestId });
  assert.deepEqual(unavailable, { state: 'not_ready', errorCode: 'RESULT_UNAVAILABLE' });
  assert.deepEqual(await mcp('result.get', { requestId }), unavailable);
  for (const caller of [api, mcp, nats]) {
    const canceled = await caller('request.cancel', { requestId });
    assert.ok(!canceled.stopConfirmed && canceled.request.taskState === 'failed', 'cancel never claims stop of completed failure');
  }
  const foreign = await http('request.get', { requestId }, other);
  assert.ok([403, 404].includes(foreign.status) && validateDto('ErrorResponse', foreign.value), 'foreign owner cannot read own request');
  await assert.rejects(publicClient.request('brai.transcription.v1.result.get', Buffer.from(JSON.stringify({ requestId })), { timeout: 600, headers: auth(writer) }), (error) => ['TIMEOUT', '503', 'PERMISSIONS_VIOLATION'].includes(error.code));

  const ajv = new Ajv({ strict: false, coerceTypes: false, useDefaults: false }); addFormats(ajv); ajv.addSchema(historyCommon); ajv.addSchema(historyMessages);
  const historyListRequest = ajv.getSchema(`${historyMessages.$id}#/definitions/listRequest`);
  const historyListResponse = ajv.getSchema(`${historyMessages.$id}#/definitions/listResponse`);
  const historyGetResponse = ajv.getSchema(`${historyMessages.$id}#/definitions/getResponse`);
  const listInput = { user_id: writer.principal.scopeId, filters: { source: 'transcription' }, limit: 100 };
  assert.ok(historyListRequest(listInput));
  let observed = [];
  const historyDeadline = Date.now() + 30000;
  do {
    const listed = await natsJson(historyReader, 'brai.history.v1.query.list', listInput);
    assert.ok(!listed.headers?.get('Nats-Service-Error') && historyListResponse(listed.value), 'real owner history list');
    observed = listed.value.items.filter((event) => event.data.requestId === requestId);
    if (observed.some((event) => event.data.phase === 'accepted') && observed.some((event) => event.data.phase === 'terminal' && event.data.outcome === 'failed')) break;
    await pause(100);
  } while (Date.now() < historyDeadline);
  assert.ok(observed.some((event) => event.data.phase === 'accepted') && observed.some((event) => event.data.phase === 'terminal' && event.data.outcome === 'failed' && event.data.errorCode === 'EXTERNAL_ROUTE_UNAVAILABLE'), 'actual coordinator history dispatch delivered metadata');
  for (const event of observed) {
    assert.ok(event.source === 'transcription' && event.scope_type === 'user' && event.scope_id === writer.principal.scopeId && validateDto('HistoryFact', event.data), 'source/scope and closed metadata');
    assert.ok(!JSON.stringify(event.data).includes('"text"') && !JSON.stringify(event.data).includes('"segments"'), 'history contains no transcript');
    const got = await natsJson(historyReader, 'brai.history.v1.query.get', { user_id: writer.principal.scopeId, source: 'transcription', id: event.id });
    assert.ok(!got.headers?.get('Nats-Service-Error') && historyGetResponse(got.value));
    assert.deepEqual(got.value.event, event, 'stable real history event');
  }
  const finalStatus = await processFixture.status();
  assert.ok(finalStatus.okay && finalStatus.status.metadataReady && !finalStatus.status.ready, 'healthy metadata delivery; no hidden recognition readiness');
});
