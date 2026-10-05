// ABOUTME: Проверяет инструменты MCP настоящим SDK через HTTP и live artifacts runtime.
// ABOUTME: Использует только явные loopback fixtures и удаляет принадлежащие тесту ресурсы.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { connect } from 'nats';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadArtifactsConfig } from '../../dist/config.js';
import { startArtifactsRuntime } from '../../dist/main.js';
import { migrate } from '../../dist/migrate.js';
import { startMcpServer, loadMcpConfig } from '../../dist/mcp.js';

const fixture = process.env.ARTIFACTS_TEST_ADMIN_URL;
const natsFixture = process.env.ARTIFACTS_TEST_NATS_URL;
if (!fixture || !natsFixture) throw new Error('Explicit ARTIFACTS_TEST_ADMIN_URL and ARTIFACTS_TEST_NATS_URL required');
const adminURL = new URL(fixture), natsURL = new URL(natsFixture);
if (adminURL.hostname !== '127.0.0.1' || adminURL.port !== '25541' || adminURL.pathname !== '/brai_artifacts_test' || adminURL.username !== 'fixture_postgres' || natsURL.hostname !== '127.0.0.1' || natsURL.port !== '24241' || natsURL.protocol !== 'nats:') throw new Error('Refusing non-fixture PostgreSQL or NATS');
const suffix = `${process.pid}_${Date.now()}`;
const database = `brai_artifacts_mcp_${suffix}`, ownerRole = `artifacts_mcp_owner_${suffix}`, appRole = `artifacts_mcp_app_${suffix}`;
const ownerURL = new URL(fixture), appURL = new URL(fixture);
ownerURL.username = ownerRole; ownerURL.pathname = `/${database}`;
appURL.username = appRole; appURL.pathname = `/${database}`;
const admin = new Pool({ connectionString: fixture, connectionTimeoutMillis: 1000 });
let owner, app, runtime, mcp, client, transport, dataDir;
const port = async () => {
  const server = createNetServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
};
const metadata = (filename, mimeType) => ({ title: filename, filename, extension: filename.split('.').at(-1), mimeType, source: 'mcp-integration' });
const result = async (name, args) => client.callTool({ name, arguments: args });
const artifact = async (kind, ownerId, filename, requestId = randomUUID()) => {
  const prepared = await result('prepare', { requestId, ownerId, kind, metadata: metadata(filename, 'application/octet-stream') });
  assert.equal(prepared.isError, undefined);
  const value = prepared.structuredContent;
  assert.equal(value.artifact.status, 'pending');
  assert.equal(typeof value.uploadUrl, 'string');
  const bytes = Buffer.from(`test:${filename}`);
  const upload = await fetch(value.uploadUrl, { method: 'PUT', body: bytes });
  assert.equal(upload.status, 201);
  assert.equal(upload.headers.get('x-artifact-sha256'), createHash('sha256').update(bytes).digest('hex'));
  return value.artifact;
};

test('official MCP client lists and invokes all artifacts operations over NATS', async t => {
  t.after(async () => {
    await client?.close().catch(() => {});
    await mcp?.close().catch(() => {});
    await runtime?.stop().catch(() => {});
    await app?.end().catch(() => {});
    await owner?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS "${appRole}"`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS "${ownerRole}"`).catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    await admin.end();
  });
  await admin.query(`CREATE ROLE "${ownerRole}" LOGIN`);
  await admin.query(`CREATE ROLE "${appRole}" LOGIN`);
  await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
  owner = new Pool({ connectionString: ownerURL.href, connectionTimeoutMillis: 1000 });
  app = new Pool({ connectionString: appURL.href, connectionTimeoutMillis: 1000 });
  await migrate(owner, ownerRole, appRole);
  dataDir = await mkdtemp(join(tmpdir(), 'artifacts-mcp-'));
  const httpPort = await port();
  runtime = await startArtifactsRuntime(loadArtifactsConfig({
    ARTIFACTS_DATABASE_URL: appURL.href, NATS_URL: natsFixture, ARTIFACTS_DATA_DIR: dataDir,
    ARTIFACTS_UPLOAD_BASE_URL: `http://127.0.0.1:${httpPort}`, ARTIFACTS_INTERNAL_BASE_URL: `http://127.0.0.1:${httpPort}`,
    ARTIFACTS_EXTERNAL_BASE_URL: `http://127.0.0.1:${httpPort}`, ARTIFACTS_HTTP_HOST: '127.0.0.1', ARTIFACTS_HTTP_PORT: String(httpPort),
    ARTIFACTS_MAX_CONCURRENT_NATS: '16', ARTIFACTS_RECONCILE_INTERVAL_MS: '60000',
  }));
  const mcpPort = await port();
  mcp = await startMcpServer(loadMcpConfig({ NATS_URL: natsFixture, ARTIFACTS_MCP_PORT: String(mcpPort), ARTIFACTS_MCP_MAX_SESSIONS: '1', ARTIFACTS_MCP_MAX_CONCURRENT: '1', ARTIFACTS_MCP_REQUEST_TIMEOUT_MS: '5000' }));
  client = new Client({ name: 'artifacts-mcp-integration', version: '1.0.0' });
  transport = new StreamableHTTPClientTransport(new URL(mcp.url));
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), [
    'delete', 'get', 'link_create', 'link_revoke', 'list', 'prepare', 'reference_confirm', 'reference_get',
    'reference_list', 'reference_reserve', 'reference_update_state', 'relation_add', 'relation_list', 'relation_remove', 'stats', 'update',
  ].sort());
  assert.equal(listed.tools.find(tool => tool.name === 'prepare').inputSchema.additionalProperties, false);
  const rejectedClient = new Client({ name: 'over-capacity-client', version: '1.0.0' });
  const rejectedTransport = new StreamableHTTPClientTransport(new URL(mcp.url));
  await assert.rejects(rejectedClient.connect(rejectedTransport));
  await rejectedClient.close().catch(() => {});

  const ownerId = randomUUID();
  const original = await artifact('original', ownerId, 'original.bin');
  const model = await artifact('copy', ownerId, 'model.bin');
  const got = await result('get', { artifactId: original.artifactId });
  assert.equal(got.structuredContent.artifactId, original.artifactId);
  const changed = await result('update', { requestId: randomUUID(), artifactId: model.artifactId, metadata: { title: 'renamed model' } });
  assert.equal(changed.structuredContent.title, 'renamed model');
  const listing = await result('list', { filter: { ownerId, status: 'ready' }, sort: 'createdAt', order: 'asc', limit: 10, offset: 0 });
  assert.equal(listing.structuredContent.total, 2);
  assert.equal((await result('stats', { ownerId })).structuredContent.totalCount, 2);

  const waitForPrepareLock = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const waiting = await admin.query("SELECT count(*) FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND wait_event='advisory'", [database]);
      if (Number(waiting.rows[0].count) > 0) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('MCP prepare did not reach the held test lock');
  };
  const sdkRequestId = randomUUID(), sdkLocker = await app.connect();
  await sdkLocker.query('SELECT pg_advisory_lock(hashtextextended($1,73490217))', [`prepare:${sdkRequestId}`]);
  try {
    const abort = new AbortController();
    const waitingCall = client.callTool({ name: 'prepare', arguments: { requestId: sdkRequestId, ownerId, kind: 'original', metadata: metadata('sdk-cancel.bin', 'application/octet-stream') } }, undefined, { signal: abort.signal });
    await waitForPrepareLock();
    abort.abort();
    await assert.rejects(waitingCall);
    const sdkResumeStarted = Date.now();
    const whileMutationUncertain = await result('stats', { ownerId });
    assert.equal(whileMutationUncertain.isError, undefined, 'SDK cancellation must release MCP NATS capacity without claiming to undo the pending mutation');
    assert.ok(Date.now() - sdkResumeStarted < 1000, 'stats must complete before the 5-second MCP deadline');
  } finally {
    await sdkLocker.query('SELECT pg_advisory_unlock(hashtextextended($1,73490217))', [`prepare:${sdkRequestId}`]).catch(() => {});
    sdkLocker.release();
  }

  const httpRequestId = randomUUID(), httpLocker = await app.connect();
  await httpLocker.query('SELECT pg_advisory_lock(hashtextextended($1,73490217))', [`prepare:${httpRequestId}`]);
  try {
    const abort = new AbortController();
    const disconnectedCall = fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': transport.sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 'http-disconnect-1', method: 'tools/call', params: { name: 'prepare', arguments: { requestId: httpRequestId, ownerId, kind: 'original', metadata: metadata('http-disconnect.bin', 'application/octet-stream') } } }), signal: abort.signal });
    await waitForPrepareLock();
    abort.abort();
    await assert.rejects(disconnectedCall);
    const httpResumeStarted = Date.now();
    let afterDisconnect;
    do {
      afterDisconnect = await result('stats', { ownerId });
      if (afterDisconnect.isError && afterDisconnect.structuredContent?.code === 'OVERLOADED') await new Promise(resolve => setTimeout(resolve, 20));
      else break;
    } while (Date.now() - httpResumeStarted < 1000);
    assert.equal(afterDisconnect.isError, undefined, `HTTP disconnect must release the MCP request and NATS inbox: ${JSON.stringify(afterDisconnect.structuredContent)}`);
    assert.ok(Date.now() - httpResumeStarted < 1000, 'stats must complete before the 5-second MCP deadline');
  } finally {
    await httpLocker.query('SELECT pg_advisory_unlock(hashtextextended($1,73490217))', [`prepare:${httpRequestId}`]).catch(() => {});
    httpLocker.release();
  }

  const relation = { requestId: randomUUID(), modelArtifactId: model.artifactId, originalArtifactId: original.artifactId };
  assert.ok((await result('relation_add', relation)).structuredContent.relation);
  assert.equal((await result('relation_list', { artifactId: original.artifactId })).structuredContent.items.length, 1);
  assert.ok((await result('relation_remove', relation)).structuredContent.relation);

  const scope = { ownerId, projectId: 'project', threadId: 'thread', operationId: randomUUID() };
  const reference = { scope, clientUserMessageId: 'native-1', commandHash: createHash('sha256').update('command').digest('hex'), attachments: [{ originalArtifactId: original.artifactId, modelArtifactId: model.artifactId }] };
  assert.equal((await result('reference_reserve', reference)).structuredContent.created, true);
  assert.equal((await result('reference_get', { scope })).structuredContent.reference.state, 'pending');
  assert.equal((await result('reference_update_state', { scope, state: 'unknown' })).structuredContent.reference.state, 'unknown');
  assert.equal((await result('reference_confirm', { scope, clientUserMessageId: 'native-1', turnId: 'turn-1', itemId: 'item-1' })).structuredContent.reference.state, 'confirmed');
  assert.equal((await result('reference_list', { scope: { ownerId, projectId: 'project', threadId: 'thread' }, nativeItemIds: ['item-1'] })).structuredContent.items.length, 1);

  const grant = await result('link_create', { requestId: randomUUID(), artifactId: original.artifactId });
  assert.equal(typeof grant.structuredContent.link.url, 'string');
  assert.ok((await result('link_revoke', { requestId: randomUUID(), linkId: grant.structuredContent.link.linkId })).structuredContent.link);
  const absent = await result('get', { artifactId: randomUUID() });
  assert.equal(absent.isError, true);
  assert.equal(absent.structuredContent.code, 'NOT_FOUND');
  const deleted = await result('delete', { requestId: randomUUID(), artifactId: model.artifactId });
  assert.equal(deleted.structuredContent.status, 'deleted');
});
