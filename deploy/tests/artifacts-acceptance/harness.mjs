// ABOUTME: Проверяет HTTP upload, MCP metadata и внутреннюю выдачу artifacts.
// ABOUTME: Работает только с выданным изолированным стендом и удаляет свои объекты.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { contentValue, validateArtifactMessage } from './artifact-contract.mjs';

assert.equal(process.argv[2], 'media', 'Supported phase: media');
const runId = process.env.BRAI_ACCEPTANCE_RUN_ID;
if (process.env.BRAI_ACCEPTANCE_GATE !== 'accepted') throw new Error('Set BRAI_ACCEPTANCE_GATE=accepted after operation 1/2 and source revision are accepted');
if (!runId || !/^[a-z0-9][a-z0-9-]{2,40}$/.test(runId)) throw new Error('Set a unique BRAI_ACCEPTANCE_RUN_ID');
const sourceRevision = process.env.BRAI_ACCEPTANCE_SOURCE_REVISION;
if (!/^[0-9a-f]{40}$/.test(sourceRevision ?? '')) throw new Error('Set exact 40-character BRAI_ACCEPTANCE_SOURCE_REVISION');
const webOrigin = new URL(process.env.BRAI_ACCEPTANCE_WEB_ORIGIN ?? 'http://127.0.0.1:13000');
const mcpUrl = new URL(process.env.BRAI_ACCEPTANCE_MCP_URL ?? 'http://127.0.0.1:13005/mcp');
const filesUrl = new URL(process.env.BRAI_ACCEPTANCE_FILES_URL ?? 'http://127.0.0.1:19080');
const metadataOrigin = new URL(process.env.BRAI_ACCEPTANCE_METADATA_ORIGIN ?? 'http://172.30.59.1:19080');
for (const url of [webOrigin, mcpUrl, filesUrl]) {
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw new Error(`Refusing non-loopback test endpoint: ${url.origin}`);
}
if (metadataOrigin.origin !== 'http://172.30.59.1:19080') throw new Error('Metadata origin must be the shared test gateway http://172.30.59.1:19080');
const reportDir = resolve(process.env.BRAI_ACCEPTANCE_TMP ?? 'tmp/artifacts-acceptance', runId);
const ownerId = randomUUID();
const requestId = () => `acceptance-${runId}-${randomUUID()}`;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const assetDir = resolve(process.env.BRAI_ACCEPTANCE_ASSET_DIR ?? 'tmp/artifacts-root-assets');
const assetManifest = JSON.parse(await readFile(resolve(assetDir, 'assets-manifest.json'), 'utf8'));
const media = await Promise.all(assetManifest.files.map(async item => {
  const data = await readFile(resolve(assetDir, item.filename));
  assert.equal(data.length, item.sizeBytes, `fixture size changed: ${item.filename}`);
  assert.equal(sha256(data), item.sha256, `fixture hash changed: ${item.filename}`);
  const extension = item.filename.split('.').at(-1);
  return { kind: 'original', ...item, extension, data };
}));
assert.deepEqual(new Set(media.map(item => item.mimeType)), new Set(['image/png', 'application/pdf', 'audio/wav', 'video/webm']));
const expectedTools = ['prepare','get','update','list','stats','delete','relation_add','relation_remove','relation_list','reference_reserve','reference_get','reference_confirm','reference_list','reference_update_state','link_create','link_revoke'];
const client = new Client({ name: 'brai-artifacts-acceptance', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(mcpUrl);
const created = [];
const results = [];
async function call(name, args) {
  return contentValue(await client.callTool({ name, arguments: args }));
}

let connected = false;
let primaryError;
const cleanupErrors = [];
let sharingResult;
let toolsChecked = 0;
try {
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  await client.connect(transport);
  connected = true;
  const listing = await client.listTools();
  assert.deepEqual(listing.tools.map(tool => tool.name).sort(), [...expectedTools].sort(), 'MCP must expose the exact 16 artifacts tools');
  toolsChecked = listing.tools.length;

  for (const item of media) {
    const prepareRequest = {
      requestId: requestId(), ownerId, kind: item.kind,
      metadata: {
        title: item.filename, filename: item.filename, extension: item.extension,
        mimeType: item.mimeType, source: 'manual', details: { runId },
      },
    };
    validateArtifactMessage('PrepareRequest', prepareRequest);
    const prepared = await call('prepare', prepareRequest);
    validateArtifactMessage('PrepareResponse', prepared);
    const artifactId = prepared.artifact.artifactId;
    created.push(artifactId);
    const upload = new URL(prepared.uploadUrl);
    assert.equal(upload.origin, webOrigin.origin, 'upload token must use the public edge origin');
    assert.match(upload.pathname, /^\/upload\/[A-Za-z0-9_-]{16,512}$/);
    const uploaded = await fetch(upload, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': String(item.data.length) }, body: item.data, redirect: 'error' });
    assert.equal(uploaded.status, 201, `${item.filename} upload failed`);
    assert.equal(uploaded.headers.get('x-artifact-id'), artifactId);
    assert.equal(uploaded.headers.get('x-artifact-state'), 'ready');
    assert.equal(uploaded.headers.get('x-artifact-size'), String(item.data.length));
    assert.equal(uploaded.headers.get('x-artifact-sha256'), sha256(item.data));
    assert.equal(await uploaded.text(), '');

    const getRequest = { artifactId };
    validateArtifactMessage('GetRequest', getRequest);
    const metadata = await call('get', getRequest);
    validateArtifactMessage('Artifact', metadata);
    assert.equal(metadata.status, 'ready');
    assert.equal(metadata.mimeType, item.mimeType);
    assert.equal(metadata.sizeBytes, item.data.length);
    assert.equal(metadata.sha256, sha256(item.data));
    assert.equal(new URL(metadata.internalUrl).origin, metadataOrigin.origin, 'persisted URL must use the common host/container gateway');
    assert.equal(new URL(metadata.internalUrl).pathname, `/files/${artifactId}`);

    const downloadUrl = new URL(`/files/${artifactId}`, filesUrl);
    const response = await fetch(downloadUrl, { redirect: 'error' });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, item.data);
    assert.equal(sha256(bytes), metadata.sha256);
    const head = await fetch(downloadUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(item.data.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const range = await fetch(downloadUrl, { headers: { range: 'bytes=1-4' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), item.data.subarray(1, 5));
    if (response.headers.has('etag')) {
      const conditional = await fetch(downloadUrl, { headers: { 'if-none-match': response.headers.get('etag') } });
      assert.equal(conditional.status, 304);
      await conditional.body?.cancel();
    } else assert.fail('files Caddy must expose an ETag for conditional read checks');
    results.push({ filename: item.filename, artifactId, sizeBytes: bytes.length, sha256: metadata.sha256, status: 'passed' });
  }

  const shareRequest = { requestId: requestId(), artifactId: created[0] };
  validateArtifactMessage('LinkCreateRequest', shareRequest);
  const shareAttempt = await client.callTool({ name: 'link_create', arguments: shareRequest });
  assert.equal(shareAttempt.isError, true, 'external links must remain disabled in normal test mode');
  sharingResult = shareAttempt.structuredContent ?? JSON.parse(shareAttempt.content.find(block => block.type === 'text').text);
  const shareError = sharingResult;
  assert.equal(shareError.code, 'SHARING_NOT_CONFIGURED');
} catch (error) {
  primaryError = error;
} finally {
  if (connected) {
    for (const artifactId of created.reverse()) {
      try {
        const request = { requestId: requestId(), artifactId };
        validateArtifactMessage('DeleteRequest', request);
        await call('delete', request);
      } catch (error) {
        cleanupErrors.push({ artifactId, message: String(error.message ?? error) });
      }
    }
  }
  await client.close().catch(() => {});
}

const reportPath = resolve(reportDir, 'media.json');
await mkdir(reportDir, { recursive: true, mode: 0o700 });
const report = {
  runId, sourceRevision, completedAt: new Date().toISOString(), mode: 'media',
  status: primaryError ? 'failed' : cleanupErrors.length ? 'failed_cleanup' : 'passed',
  fixture: 'root-provided valid test assets verified against assets-manifest.json; live native inference is not exercised',
  toolsChecked, results,
  externalSharing: sharingResult?.code === 'SHARING_NOT_CONFIGURED' ? 'disabled; SHARING_NOT_CONFIGURED verified' : 'not verified',
  cleanup: { attemptedArtifactIds: created, errors: cleanupErrors },
  ...(primaryError ? { error: String(primaryError.stack ?? primaryError) } : {}),
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ report: reportPath, status: report.status, artifactsChecked: results.length, cleanupErrors: cleanupErrors.length }));
if (primaryError) throw primaryError;
if (cleanupErrors.length) throw new Error(`Cleanup failed for ${cleanupErrors.length} owned artifacts; see ${reportPath}`);
