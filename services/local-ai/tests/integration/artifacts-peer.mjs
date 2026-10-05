// ABOUTME: Принимает реальный путь local-ai → NATS artifacts → HTTP files на выделенном fixture.
// ABOUTME: Требует явной готовности fixture и синтетических данных; работает только с созданными им ID.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { connect, credsAuthenticator, ServiceErrorCodeHeader, ServiceErrorHeader } from 'nats';
import test from 'node:test';

const names = [
  'ARTIFACTS_PEER_READY',
  'ARTIFACTS_PEER_NATS_URL',
  'ARTIFACTS_PEER_NATS_INBOX_PREFIX',
  'ARTIFACTS_PEER_INTERNAL_BASE_URL',
  'ARTIFACTS_PEER_ALLOWED_ORIGINS',
  'ARTIFACTS_PEER_TEMP_ROOT',
  'ARTIFACTS_PEER_MAX_AUDIO_BYTES',
  'ARTIFACTS_PEER_ALLOWED_MIME_TYPES',
  'ARTIFACTS_PEER_TIMEOUT_MS',
];
const absent = names.filter((name) => !process.env[name]?.trim());
if (absent.length) throw new Error('Missing required fixture inputs: ' + absent.join(', '));
if (process.env.ARTIFACTS_PEER_READY !== 'verified') {
  throw new Error('ARTIFACTS_PEER_READY must be "verified" after release confirms the fixture.');
}

function safeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseOrigin(value, allowedProtocols) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw safeError('INVALID_FIXTURE_URL');
  }
  if (!allowedProtocols.includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/') {
    throw safeError('INVALID_FIXTURE_URL');
  }
  return url;
}

function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (version === 6) {
    return host === '::1'
      || /^f[cd]/i.test(host)
      || /^fe[89ab]/i.test(host);
  }
  return false;
}

function originKey(url) {
  return url.protocol + '//' + url.host.toLowerCase();
}

function assertPrivateOrigin(url, allowedOrigins, privateHosts) {
  if (url.port === '19080'
    || /^130\d+$/.test(url.port)
    || !allowedOrigins.has(originKey(url))
    || !(isPrivateHost(url.hostname) || privateHosts.has(url.hostname.toLowerCase()))) {
    throw safeError('FIXTURE_ORIGIN_NOT_ALLOWED');
  }
}

function parseUploadUrl(value, config) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw safeError('UPLOAD_URL_REJECTED');
  }
  assertPrivateOrigin(url, config.allowedOrigins, config.privateHosts);
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || value.includes('%')
    || value.includes('\\')
    || !/^\/upload\/[A-Za-z0-9._~-]+$/.test(url.pathname)) {
    throw safeError('UPLOAD_URL_REJECTED');
  }
  return url;
}

function readConfig() {
  const natsUrl = parseOrigin(process.env.ARTIFACTS_PEER_NATS_URL, ['nats:', 'tls:']);
  const inboxPrefix = process.env.ARTIFACTS_PEER_NATS_INBOX_PREFIX;
  if (inboxPrefix !== '_INBOX.brai_fixture') {
    throw safeError('INVALID_FIXTURE_INBOX_PREFIX');
  }
  const internalBaseUrl = parseOrigin(process.env.ARTIFACTS_PEER_INTERNAL_BASE_URL, ['http:', 'https:']);
  const allowedOrigins = new Set(process.env.ARTIFACTS_PEER_ALLOWED_ORIGINS
    .split(',')
    .map((value) => originKey(parseOrigin(value.trim(), ['nats:', 'tls:', 'http:', 'https:']))));
  const privateHosts = new Set((process.env.ARTIFACTS_PEER_PRIVATE_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean));
  assertPrivateOrigin(natsUrl, allowedOrigins, privateHosts);
  assertPrivateOrigin(internalBaseUrl, allowedOrigins, privateHosts);

  const tempRoot = process.env.ARTIFACTS_PEER_TEMP_ROOT;
  const maxAudioBytes = Number(process.env.ARTIFACTS_PEER_MAX_AUDIO_BYTES);
  const timeoutMs = Number(process.env.ARTIFACTS_PEER_TIMEOUT_MS);
  const allowedMimeTypes = process.env.ARTIFACTS_PEER_ALLOWED_MIME_TYPES
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!isAbsolute(tempRoot)
    || !Number.isSafeInteger(maxAudioBytes)
    || maxAudioBytes < 1
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || !allowedMimeTypes.includes('audio/wav')) {
    throw safeError('INVALID_FIXTURE_CONFIG');
  }

  const user = process.env.ARTIFACTS_PEER_NATS_USER;
  const pass = process.env.ARTIFACTS_PEER_NATS_PASSWORD;
  const token = process.env.ARTIFACTS_PEER_NATS_TOKEN;
  const credentials = process.env.ARTIFACTS_PEER_NATS_CREDENTIALS_FILE;
  if ((Boolean(user) !== Boolean(pass))
    || [token, credentials].filter(Boolean).length > 1
    || ((token || credentials) && (user || pass))) {
    throw new Error('Configure one NATS auth method: token, credentials file, or user/password pair.');
  }
  if (!token && !credentials && !user) {
    throw new Error('Missing NATS credentials: set NATS token, credentials file, or user/password pair.');
  }

  return {
    natsUrl,
    inboxPrefix,
    internalBaseUrl,
    allowedOrigins,
    privateHosts,
    tempRoot,
    maxAudioBytes,
    timeoutMs,
    allowedMimeTypes,
    user,
    pass,
    token,
    credentials,
  };
}

function syntheticWav() {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const sampleCount = 160;
  const dataBytes = sampleCount * channels * bitsPerSample / 8;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  wav.writeUInt16LE(channels * bitsPerSample / 8, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function operationContext(ownerId, operationId, timeoutMs) {
  return {
    ownerId,
    operationId,
    deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    signal: new AbortController().signal,
  };
}

test('real artifacts prepare/upload/get/delete and local-ai ready audio adapter', async () => {
  const config = readConfig();
  const { createArtifactsAdapter } = await import('../../dist/adapters/artifacts/index.js');
  const audio = syntheticWav();
  if (audio.length > config.maxAudioBytes) throw safeError('FIXTURE_AUDIO_EXCEEDS_CONFIGURED_LIMIT');

  let nc;
  let runTempRoot;
  const prepared = [];
  let call;
  let upload;
  try {
    const connectOptions = { servers: config.natsUrl.href, timeout: config.timeoutMs, inboxPrefix: config.inboxPrefix };
    if (config.credentials) {
      let credentialBytes;
      try {
        credentialBytes = await readFile(config.credentials);
      } catch {
        throw safeError('NATS_CREDENTIALS_UNAVAILABLE');
      }
      connectOptions.authenticator = credsAuthenticator(credentialBytes);
    } else if (config.token) connectOptions.token = config.token;
    else {
      connectOptions.user = config.user;
      connectOptions.pass = config.pass;
    }
    try {
      nc = await connect(connectOptions);
    } catch {
      throw safeError('NATS_CONNECT_FAILED');
    }

    runTempRoot = await mkdtemp(join(config.tempRoot, 'artifacts-peer-'));
    call = async (subject, value) => {
      let reply;
      try {
        reply = await nc.request(subject, Buffer.from(JSON.stringify(value)), { timeout: config.timeoutMs });
      } catch {
        throw safeError('NATS_REQUEST_FAILED');
      }
      const error = reply.headers?.get(ServiceErrorHeader);
      const status = reply.headers?.get(ServiceErrorCodeHeader);
      if (Boolean(error) !== Boolean(status) || status && !/^[45][0-9]{2}$/.test(status)) {
        throw safeError('NATS_BAD_SERVICE_ERROR');
      }
      if (error) throw Object.assign(safeError('NATS_SERVICE_ERROR'), { status });
      try {
        return JSON.parse(Buffer.from(reply.data).toString('utf8'));
      } catch {
        throw safeError('NATS_BAD_JSON_REPLY');
      }
    };
    const get = (artifactId) => call('brai.artifacts.v1.get', { artifactId });
    const prepare = async (ownerId) => {
      const result = await call('brai.artifacts.v1.prepare', {
        requestId: randomUUID(),
        ownerId,
        kind: 'original',
        metadata: {
          title: 'Synthetic peer audio',
          filename: 'synthetic.wav',
          extension: 'wav',
          mimeType: 'audio/wav',
          source: 'local-ai-peer-test',
        },
      });
      if (!result?.artifact
        || typeof result.artifact.artifactId !== 'string'
        || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result.artifact.artifactId)
        || result.artifact.ownerId !== ownerId
        || result.artifact.status !== 'pending'
        || typeof result.uploadUrl !== 'string') {
        throw safeError('PREPARE_BAD_REPLY');
      }
      parseUploadUrl(result.uploadUrl, config);
      const entry = { artifactId: result.artifact.artifactId, ownerId, uploadUrl: result.uploadUrl };
      prepared.push(entry);
      return entry;
    };
    upload = async (entry) => {
      const uploadUrl = parseUploadUrl(entry.uploadUrl, config);
      let response;
      try {
        response = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(audio.length) },
          body: audio,
          redirect: 'manual',
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch {
        throw safeError('UPLOAD_FAILED');
      }
      if (response.status !== 201) throw safeError('UPLOAD_STATUS_FAILED');
      const id = response.headers.get('x-artifact-id');
      const state = response.headers.get('x-artifact-state');
      const size = response.headers.get('x-artifact-size');
      const hash = response.headers.get('x-artifact-sha256');
      const location = response.headers.get('location');
      let emptyBody;
      try {
        emptyBody = await response.arrayBuffer();
      } catch {
        throw safeError('UPLOAD_BODY_UNAVAILABLE');
      }
      if (id?.toLowerCase() !== entry.artifactId.toLowerCase()
        || state !== 'ready'
        || size !== String(audio.length)
        || hash !== sha256(audio)
        || !location
        || emptyBody.byteLength !== 0) {
        throw safeError('UPLOAD_HEADERS_FAILED');
      }
      return location;
    };
    const unavailable = async (artifactId, ownerId) => {
      const operationId = randomUUID();
      const adapter = createArtifactsAdapter({
        nats: nc,
        internalBaseUrl: config.internalBaseUrl.origin,
        tempRoot: runTempRoot,
        maxAudioBytes: config.maxAudioBytes,
        allowedMimeTypes: config.allowedMimeTypes,
      });
      await assert.rejects(
        adapter.withReadyAudio(
          { artifactId, ownerId, operationId },
          operationContext(ownerId, operationId, config.timeoutMs),
          async () => assert.fail('Unavailable artifact reached the audio consumer.'),
        ),
        { code: 'ARTIFACT_NOT_AVAILABLE' },
      );
    };

    const ownerId = randomUUID();
    const foreignOwnerId = randomUUID();
    const ready = await prepare(ownerId);
    const pendingBeforeUpload = await get(ready.artifactId);
    assert.equal(pendingBeforeUpload.status, 'pending');
    const uploadLocation = await upload(ready);
    const readyArtifact = await get(ready.artifactId);
    if (uploadLocation !== readyArtifact.internalUrl) throw safeError('UPLOAD_LOCATION_MISMATCH');
    assert.equal(readyArtifact.status, 'ready');
    assert.equal(readyArtifact.ownerId, ownerId);
    assert.equal(readyArtifact.sizeBytes, audio.length);
    assert.equal(readyArtifact.sha256, sha256(audio));

    const adapter = createArtifactsAdapter({
      nats: nc,
      internalBaseUrl: config.internalBaseUrl.origin,
      tempRoot: runTempRoot,
      maxAudioBytes: config.maxAudioBytes,
      allowedMimeTypes: config.allowedMimeTypes,
    });
    const operationId = randomUUID();
    const result = await adapter.withReadyAudio(
      { artifactId: ready.artifactId, ownerId, operationId },
      operationContext(ownerId, operationId, config.timeoutMs),
      async ({ localPath }) => {
        const received = await readFile(localPath);
        assert.deepEqual(received, audio);
        assert.equal(received.length, readyArtifact.sizeBytes);
        assert.equal(sha256(received), readyArtifact.sha256);
        return 'bytes-verified';
      },
    );
    assert.equal(result, 'bytes-verified');
    assert.deepEqual(await readdir(runTempRoot), []);

    await unavailable(ready.artifactId, foreignOwnerId);

    const pending = await prepare(ownerId);
    assert.equal((await get(pending.artifactId)).status, 'pending');
    await unavailable(pending.artifactId, ownerId);
    await upload(pending);

    const missingId = randomUUID();
    await assert.rejects(get(missingId), { status: '404' });
    await unavailable(missingId, ownerId);

    const deleted = await call('brai.artifacts.v1.delete', { requestId: randomUUID(), artifactId: ready.artifactId });
    assert.equal(deleted.status, 'deleted');
    assert.equal((await get(ready.artifactId)).status, 'deleted');
    await unavailable(ready.artifactId, ownerId);

    const pendingReady = await get(pending.artifactId);
    assert.equal(pendingReady.status, 'ready');
    const deletedPending = await call('brai.artifacts.v1.delete', { requestId: randomUUID(), artifactId: pending.artifactId });
    assert.equal(deletedPending.status, 'deleted');
    assert.deepEqual(await readdir(runTempRoot), []);
  } finally {
    let cleanupFailed = false;
    if (nc) {
      if (call && upload) {
        for (const entry of prepared) {
          try {
            let current;
            try {
              current = await call('brai.artifacts.v1.get', { artifactId: entry.artifactId });
            } catch (error) {
              if (error.status === '404') continue;
              throw error;
            }
            if (current.status === 'pending') {
              await upload(entry);
              current = await call('brai.artifacts.v1.get', { artifactId: entry.artifactId });
            }
            if (current.status === 'ready' || current.status === 'deleting') {
              await call('brai.artifacts.v1.delete', { requestId: randomUUID(), artifactId: entry.artifactId });
            } else if (current.status !== 'deleted') {
              cleanupFailed = true;
            }
          } catch {
            cleanupFailed = true;
          }
        }
      }
      await nc.drain().catch(() => { cleanupFailed = true; });
    }
    if (runTempRoot) await rm(runTempRoot, { recursive: true, force: true }).catch(() => { cleanupFailed = true; });
    if (cleanupFailed) throw safeError('PEER_CLEANUP_FAILED');
  }
});
