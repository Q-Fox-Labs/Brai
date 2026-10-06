// ABOUTME: Проверяет локальный маршрут расшифровки через coordinator, helper, artifacts и local-ai.
// ABOUTME: Использует только защищённые синтетические WAV-файлы и не выводит текст или аудиоданные.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { connect } from 'nats';
import pg from 'pg';
import { startCoordinator } from '../../dist/coordinator/main.js';
import { loadCoordinatorConfig } from '../../dist/coordinator/config.js';
import { methodMap, validateDto } from '../../contracts/index.mjs';
import { subjects as artifactSubjects, validateRequest as artifactRequest, validateResponse as artifactResponse } from '../../../artifacts/contracts/index.mjs';
import { subjects as localAiSubjects, validateRequest as localAiRequest, validateResponse as localAiResponse } from '../../../local-ai/contracts/index.mjs';
import historyCommon from '../../../history/schemas/common.schema.json' with { type: 'json' };
import historyMessages from '../../../history/schemas/messages.schema.json' with { type: 'json' };
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const responseLimit = 262144;
const timeoutMs = 10000;
const ownerPrefix = 'transcription-acceptance-';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function hasSensitiveFields(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasSensitiveFields);
  return Object.entries(value).some(([key, nested]) => ['text', 'segments', 'audio', 'audioBytes', 'transcript'].includes(key) || hasSensitiveFields(nested));
}

function ownNats(settings, user, inboxPrefix, role) {
  let url;
  try { url = new URL(settings.servers); } catch { throw new Error(`Invalid own ${role} NATS configuration`); }
  assert.ok(url.protocol === 'nats:' && url.hostname === '127.0.0.1' && url.port === '19680' &&
    !url.username && !url.password && !url.search && !url.hash && (!url.pathname || url.pathname === '/'), `own isolated ${role} NATS only`);
  assert.ok(settings.user === user && settings.inboxPrefix === inboxPrefix && typeof settings.pass === 'string' && settings.pass.length > 0 && !settings.token,
    `explicit own ${role} principal required`);
  return settings;
}

function envNats(prefix, user, inboxPrefix, role) {
  return ownNats({ servers: process.env[`${prefix}URL`], user: process.env[`${prefix}USER`],
    pass: process.env[`${prefix}PASSWORD`], token: process.env[`${prefix}TOKEN`], inboxPrefix: process.env[`${prefix}INBOX_PREFIX`] }, user, inboxPrefix, role);
}

function boundedJson(message, label) {
  assert.ok(message.data.length <= responseLimit, `${label} response bound`);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message.data));
}

async function natsRequest(nc, subject, input, requestHeaders) {
  const bytes = Buffer.from(JSON.stringify(input));
  assert.ok(bytes.length <= 65536, 'bounded fixture request');
  const message = await nc.request(subject, bytes, { timeout: timeoutMs, headers: requestHeaders });
  return { value: boundedJson(message, subject), headers: message.headers };
}

async function jsonBody(response) {
  const reader = response.body.getReader();
  const bytes = Buffer.allocUnsafe(responseLimit);
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (length + next.value.length > responseLimit) throw new Error('Bounded fixture response exceeded');
      bytes.set(next.value, length); length += next.value.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { await reader.cancel().catch(() => {}); }
}

function fixtureSha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function readSpokenFixtures() {
  const fixtureRoot = process.env.TRANSCRIPTION_TEST_ASR_FIXTURE_ROOT;
  assert.equal(fixtureRoot, '/var/lib/brai-transcription-acceptance/fixtures/asr-ru', 'explicit own fixture root required');
  const rootStat = lstatSync(fixtureRoot);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink() && rootStat.uid === process.getuid() && realpathSync(fixtureRoot) === fixtureRoot && (rootStat.mode & 0o222) === 0,
    'fixture root is a read-only owned directory');
  assert.deepEqual(readdirSync(fixtureRoot).sort(), ['long-ru.wav', 'manifest.json', 'short-ru.wav'], 'closed fixture directory contents');
  const manifestPath = resolve(fixtureRoot, 'manifest.json');
  const manifestStat = lstatSync(manifestPath);
  assert.ok(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.uid === process.getuid() && (manifestStat.mode & 0o777) === 0o400 && manifestStat.size <= 16384,
    'fixture manifest is an owned read-only regular file');
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['generator', 'long', 'short', 'synthetic', 'version', 'voice'].sort(), 'closed fixture manifest fields');
  assert.ok(manifest.version === 1 && manifest.synthetic === true && manifest.generator === 'espeak-ng' && manifest.voice === 'ru', 'published synthetic Russian fixtures');
  const read = (kind, expectedFile, predicate) => {
    const descriptor = manifest[kind];
    assert.ok(descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor), `bounded ${kind} fixture descriptor`);
    assert.deepEqual(Object.keys(descriptor).sort(), ['channels', 'durationMs', 'file', 'sampleFormat', 'sampleRateHz', 'sha256', 'sizeBytes'].sort(),
      `closed ${kind} fixture metadata`);
    assert.ok(descriptor.file === expectedFile && /^[0-9a-f]{64}$/.test(descriptor.sha256) && Number.isSafeInteger(descriptor.sizeBytes) &&
      descriptor.sizeBytes > 0 && descriptor.sizeBytes <= 6 * 1024 * 1024 && Number.isSafeInteger(descriptor.durationMs) && predicate(descriptor.durationMs) &&
      descriptor.channels === 1 && descriptor.sampleFormat === 'pcm_s16le' && Number.isSafeInteger(descriptor.sampleRateHz) &&
      descriptor.sampleRateHz >= 8000 && descriptor.sampleRateHz <= 48000, `bounded ${kind} fixture properties`);
    const path = resolve(fixtureRoot, expectedFile);
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o400 && stat.size === descriptor.sizeBytes,
      `owned read-only ${kind} WAV`);
    const bytes = readFileSync(path);
    assert.ok(fixtureSha256(bytes) === descriptor.sha256 && bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.readUInt32LE(4) === bytes.length - 8, `frozen ${kind} WAV bytes`);
    let offset = 12;
    let byteRate;
    let dataBytes;
    let channels;
    let sampleRate;
    let blockAlign;
    let bitsPerSample;
    let fmtSeen = false;
    let dataSeen = false;
    while (offset < bytes.length) {
      assert.ok(offset + 8 <= bytes.length, `complete ${kind} WAV chunk header`);
      const size = bytes.readUInt32LE(offset + 4);
      const id = bytes.toString('ascii', offset, offset + 4);
      const bodyOffset = offset + 8;
      assert.ok(size <= bytes.length - bodyOffset, `complete ${kind} WAV chunk body`);
      if (id === 'fmt ') {
        assert.ok(!fmtSeen && size >= 16, `single complete ${kind} WAV format chunk`);
        fmtSeen = true;
        assert.equal(bytes.readUInt16LE(bodyOffset), 1, 'PCM WAV encoding');
        channels = bytes.readUInt16LE(bodyOffset + 2);
        sampleRate = bytes.readUInt32LE(bodyOffset + 4);
        byteRate = bytes.readUInt32LE(bodyOffset + 8);
        blockAlign = bytes.readUInt16LE(bodyOffset + 12);
        bitsPerSample = bytes.readUInt16LE(bodyOffset + 14);
      }
      if (id === 'data') {
        assert.ok(!dataSeen, `single ${kind} WAV data chunk`);
        dataSeen = true;
        dataBytes = size;
      }
      offset = bodyOffset + size + (size % 2);
      assert.ok(offset <= bytes.length, `complete ${kind} WAV chunk padding`);
    }
    assert.ok(fmtSeen && dataSeen && channels === 1 && sampleRate === descriptor.sampleRateHz && blockAlign === 2 && bitsPerSample === 16 && byteRate === sampleRate * blockAlign &&
      Number.isSafeInteger(dataBytes) && dataBytes > 0 && dataBytes % blockAlign === 0 && Math.round(dataBytes / byteRate * 1000) === descriptor.durationMs,
      `measured ${kind} WAV format and duration`);
    return { wav: bytes, durationSeconds: dataBytes / byteRate };
  };
  return {
    short: read('short', 'short-ru.wav', milliseconds => milliseconds > 0 && milliseconds <= 25000),
    long: read('long', 'long-ru.wav', milliseconds => milliseconds > 25000 && milliseconds <= 60000),
  };
}

function silenceWave(durationSeconds) {
  const sampleRate = 16000;
  const data = Buffer.alloc(sampleRate * durationSeconds * 2);
  const wav = Buffer.alloc(44 + data.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(data.length, 40); data.copy(wav, 44);
  return { wav, durationSeconds };
}

test('guarded real local route: short and long Russian speech, volatile results and metadata-only history', { timeout: 900000 }, async t => {
  assert.equal(process.env.TRANSCRIPTION_TEST_ASR, '1', 'explicit own-fixture activation required');
  const config = loadCoordinatorConfig({ ...process.env, TRANSCRIPTION_INSTANCE_ID: randomUUID() });
  assert.ok(config.localAi, 'real local-ai owner connection required');
  assert.ok(config.domain.resultTtlMs <= 60000, 'bounded own-fixture result TTL required');
  ownNats(config.nats, 'transcription', '_INBOX.brai_transcription', 'coordinator');
  ownNats(config.localAi, 'transcription_local_ai', '_INBOX.brai_transcription_local', 'local-ai client');
  assert.ok(config.http.host === '127.0.0.1' && config.http.port === 19682 && config.http.allowedHosts.includes('127.0.0.1:19682'),
    'coordinator uses the own loopback listener only');
  assert.ok(config.children.helper.PGHOST === '127.0.0.1' && config.children.helper.PGPORT === '19679' &&
    config.children.helper.PGDATABASE === 'brai_transcription_acceptance' && config.children.helper.PGUSER === 'transcription_app', 'own application database only');
  assert.ok(config.bindings.every(binding => binding.principal.scopeType === 'user' && binding.principal.ownerId.startsWith(ownerPrefix) && binding.principal.scopeId.startsWith(ownerPrefix)),
    'synthetic fixture identities only');
  const writer = config.bindings.find(binding => binding.principal.permissions.includes('transcription:use') && binding.principal.permissions.includes('transcription:settings:write'));
  const other = config.bindings.find(binding => binding !== writer && binding.principal.permissions.includes('transcription:use') && binding.principal.ownerId !== writer?.principal.ownerId);
  assert.ok(writer && other, 'two independent fixture principals required');
  const uploaderSettings = envNats('TRANSCRIPTION_TEST_ARTIFACT_NATS_', 'test_uploader', '_INBOX.brai_artifacts_test', 'artifact uploader');
  const historySettings = envNats('TRANSCRIPTION_TEST_HISTORY_NATS_', 'history_reader', '_INBOX.brai_history_test', 'history reader');
  const tapSettings = envNats('TRANSCRIPTION_TEST_LOCAL_AI_TAP_NATS_', 'transcription_restart_observer', '_INBOX.brai_transcription_restart_observer', 'local-ai observer');
  const connections = [];
  const artifacts = [];
  let runtime;
  let uploader;
  let historyReader;
  let tap;
  let storage;
  let storageConnected = false;
  let storageReadOnly = false;
  const open = async settings => {
    const nc = await connect({ ...settings, timeout: 5000, reconnect: false });
    connections.push(nc);
    return nc;
  };
  t.after(async () => {
    let cleanupFailed = false;
    try {
      try { await runtime?.close(); } catch { cleanupFailed = true; }
      for (const artifactId of artifacts) {
        try {
          const input = { requestId: randomUUID(), artifactId };
          assert.ok(artifactRequest(artifactSubjects.delete, input));
          const deleted = await natsRequest(uploader, artifactSubjects.delete, input);
          assert.ok(!deleted.headers?.get('Nats-Service-Error') && artifactResponse(artifactSubjects.delete, deleted.value) && deleted.value.status === 'deleted');
        } catch { cleanupFailed = true; }
      }
    } finally {
      try {
        if (storageConnected) {
          if (storageReadOnly) await storage.query('ROLLBACK');
          await storage.end();
        }
      } catch { cleanupFailed = true; }
      try {
        const stopped = await Promise.allSettled(connections.map(connection => connection.close()));
        if (stopped.some(result => result.status === 'rejected')) cleanupFailed = true;
      } catch { cleanupFailed = true; }
    }
    assert.ok(!cleanupFailed, 'own coordinator, artifacts, database client and NATS connections cleaned up');
  });

  uploader = await open(uploaderSettings);
  historyReader = await open(historySettings);
  tap = await open(tapSettings);
  let selector;
  const observer = tap.subscribe(localAiSubjects.invokeTranscribe, { max: 8 });
  await tap.flush();
  const invocations = [];
  let observerInvalid = false;
  void (async () => {
    for await (const message of observer) {
      if (message.data.byteLength > 65536) { observerInvalid = true; continue; }
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message.data)); }
      catch { observerInvalid = true; continue; }
      if (!localAiRequest(localAiSubjects.invokeTranscribe, value) || value.ownerId !== writer.principal.ownerId ||
        !artifacts.includes(value.audioArtifactId) || value.requestId !== value.operationId || !selector || JSON.stringify(value.model) !== JSON.stringify(selector)) {
        observerInvalid = true;
        continue;
      }
      invocations.push({ requestId: value.requestId, operationId: value.operationId, model: value.model, audioArtifactId: value.audioArtifactId });
    }
  })();

  const localAiClient = await open(config.localAi);
  const modelsReply = await natsRequest(localAiClient, localAiSubjects.modelsList, {
    filter: { modelId: 'gigaam-v3-e2e-ctc', operation: 'transcribe', inputKind: 'audio_artifact', outputKind: 'transcription' },
    page: { limit: 100 },
  });
  assert.ok(!modelsReply.headers?.get('Nats-Service-Error') && localAiResponse(localAiSubjects.modelsList, modelsReply.value));
  const available = modelsReply.value.items.filter(item => item.modelId === 'gigaam-v3-e2e-ctc' && item.profileId === 'gigaam_pytorch' && item.supported &&
    item.installationState === 'installed' && item.runtimeState === null).map(item => ({ selector: { modelId: item.modelId, revision: item.revision, profileId: item.profileId } }));
  assert.equal(available.length, 1, 'one actual installed GigaAM model with a fresh cold runtime slot required');
  selector = available[0].selector;
  assert.ok(validateDto('ModelSelector', selector), 'published full model selector');
  runtime = await startCoordinator(config);
  const runtimeStatus = await runtime.status();
  assert.ok(runtimeStatus.ready && runtimeStatus.localExecutor.configured && runtimeStatus.localExecutor.verified && runtimeStatus.localExecutor.available,
    'real coordinator and local executor report verified readiness');
  const rawApi = async (method, input, binding = writer) => {
    const response = await fetch(`http://${config.http.host}:${config.http.port}/v1/transcription/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${binding.token}` },
      body: JSON.stringify(input), signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, value: await jsonBody(response) };
  };
  const api = async (method, input, binding = writer) => {
    const response = await rawApi(method, input, binding);
    assert.equal(response.status, 200);
    assert.ok(validateDto(methodMap.public[method][1], response.value), 'public result DTO');
    return response.value;
  };
  const settings = await api('settings.get', {});
  await api('settings.set', { settings: { ...settings.settings, defaultLocalModel: selector }, expectedRevision: settings.revision });
  const catalog = await api('models.list', {});
  assert.ok(catalog.localItems.some(item => JSON.stringify(item.selector) === JSON.stringify(selector) && !item.ready && item.installed && item.supported),
    'coordinator admits the actual installed model while it is unloaded');

  const prepareAudio = async (fixture, label, options = {}) => {
    const requestId = randomUUID();
    const prepare = { requestId, ownerId: writer.principal.ownerId, kind: 'original', metadata: {
      title: `ASR acceptance ${label}`, filename: `${label}.${options.extension ?? 'wav'}`, extension: options.extension ?? 'wav',
      mimeType: options.mimeType ?? 'audio/wav', source: 'transcription_asr_acceptance' } };
    assert.ok(artifactRequest(artifactSubjects.prepare, prepare));
    const prepared = await natsRequest(uploader, artifactSubjects.prepare, prepare);
    assert.ok(!prepared.headers?.get('Nats-Service-Error') && artifactResponse(artifactSubjects.prepare, prepared.value) &&
      prepared.value.artifact.ownerId === writer.principal.ownerId && prepared.value.artifact.requestId === requestId);
    const artifactId = prepared.value.artifact.artifactId;
    artifacts.push(artifactId);
    const upload = new URL(prepared.value.uploadUrl);
    assert.ok(upload.protocol === 'http:' && upload.hostname === '172.31.246.1' && upload.port === '19681' && upload.pathname.startsWith('/upload/') && !upload.username && !upload.password && !upload.search && !upload.hash,
      'own isolated artifact upload endpoint only');
    if (options.upload === false) return artifactId;
    const bytes = options.bytes ?? fixture.wav;
    const response = await fetch(upload, { method: 'PUT', body: bytes, headers: { 'content-type': prepare.metadata.mimeType }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    assert.ok(response.status === 201 && response.headers.get('x-artifact-id') === artifactId && response.headers.get('x-artifact-state') === 'ready' && Number(response.headers.get('x-artifact-size')) === bytes.length,
      'real owner upload reached ready state');
    await response.arrayBuffer();
    return artifactId;
  };

  async function transcribe(fixture, label, requireNonEmpty = true, requestedModel = { route: 'local', selection: 'required', modelId: selector.modelId }) {
    const artifactId = await prepareAudio(fixture, label);
    const clientIdempotencyKey = randomUUID();
    const accepted = await api('request.submit', { clientIdempotencyKey, audioArtifactId: artifactId,
      requestedModel, deadlineAt: null });
    const requestId = accepted.request.requestId;
    const finishBy = Date.now() + 180000;
    let current;
    do {
      current = await api('request.get', { requestId });
      if (['succeeded', 'failed', 'outcome_unknown', 'cancelled'].includes(current.request.taskState)) break;
      await pause(150);
    } while (Date.now() < finishBy);
    assert.ok(current.request.taskState === 'succeeded', 'real local GigaAM route succeeded');
    assert.ok(JSON.stringify(current.request.actualModel) === JSON.stringify(selector), 'request records the full selected model');
    const result = await api('result.get', { requestId });
    assert.ok(result.state === 'available' && typeof result.result.text === 'string' &&
      (!requireNonEmpty || result.result.text.trim().length > 0),
      'transient transcript available without exposing it');
    assert.ok(JSON.stringify(result.result.actualModel) === JSON.stringify(selector), 'result records the full actual model');
    assert.ok(result.result.segments === null || Array.isArray(result.result.segments), 'owner-reported optional segments');
    const invocationEnd = Date.now() + 5000;
    while (!invocations.some(value => value.audioArtifactId === artifactId) && Date.now() < invocationEnd) await pause(20);
    const invocation = invocations.find(value => value.audioArtifactId === artifactId);
    assert.ok(invocation && invocation.requestId === invocation.operationId && invocation.operationId.length === 36 &&
      JSON.stringify(invocation.model) === JSON.stringify(selector), 'local-ai receives attempt ID in both correlation fields and the full selector');
    return { artifactId, requestId, clientIdempotencyKey, result, invocation, durationSeconds: fixture.durationSeconds, emptyTranscript: result.result.text.length === 0 };
  }

  const fixtures = readSpokenFixtures();
  const shortFixture = fixtures.short;
  const longFixture = fixtures.long;
  const shortRun = await transcribe(shortFixture, 'short', true, null);
  const afterShort = await natsRequest(localAiClient, localAiSubjects.modelsList, {
    filter: { modelId: selector.modelId, operation: 'transcribe', inputKind: 'audio_artifact', outputKind: 'transcription' }, page: { limit: 100 },
  });
  assert.ok(!afterShort.headers?.get('Nats-Service-Error') && localAiResponse(localAiSubjects.modelsList, afterShort.value) &&
    afterShort.value.items.some(item => item.modelId === selector.modelId && item.revision === selector.revision && item.profileId === selector.profileId && item.runtimeState === 'ready'),
    'first real invocation autoloaded the installed model without a manual load call');
  const coordinatorCatalog = await api('models.list', {});
  assert.ok(coordinatorCatalog.localItems.some(item => JSON.stringify(item.selector) === JSON.stringify(selector) && item.ready),
    'coordinator catalog observes the automatically loaded model');
  const longRun = await transcribe(longFixture, 'long');
  const emptyRun = await transcribe(silenceWave(1), 'silence', false);
  assert.ok(emptyRun.result.state === 'available' && typeof emptyRun.result.result.text === 'string',
    'a valid empty transcript, if returned for silence, remains an accepted result');
  assert.ok(shortRun.durationSeconds < 25 && longRun.durationSeconds > 25, 'both audio boundaries exercised');

  const wrongOwner = await rawApi('request.submit', { clientIdempotencyKey: randomUUID(), audioArtifactId: shortRun.artifactId,
    requestedModel: { route: 'local', selection: 'required', modelId: selector.modelId }, deadlineAt: null }, other);
  assert.ok(wrongOwner.status >= 400 && validateDto('ErrorResponse', wrongOwner.value) && wrongOwner.value.errorCode === 'ARTIFACT_OWNER_MISMATCH',
    'another owner cannot submit the real uploaded audio');

  const deletedArtifactId = await prepareAudio(shortFixture, 'deleted');
  const deleted = await natsRequest(uploader, artifactSubjects.delete, { requestId: randomUUID(), artifactId: deletedArtifactId });
  assert.ok(!deleted.headers?.get('Nats-Service-Error') && artifactResponse(artifactSubjects.delete, deleted.value) && deleted.value.status === 'deleted',
    'owned artifact deletion confirmed by its owner');
  artifacts.splice(artifacts.indexOf(deletedArtifactId), 1);
  const deletedSubmit = await rawApi('request.submit', { clientIdempotencyKey: randomUUID(), audioArtifactId: deletedArtifactId,
    requestedModel: { route: 'local', selection: 'required', modelId: selector.modelId }, deadlineAt: null }, writer);
  assert.ok(deletedSubmit.status >= 400 && validateDto('ErrorResponse', deletedSubmit.value), 'deleted audio is rejected with a typed public error');

  const malformedArtifactId = await prepareAudio(shortFixture, 'unsupported-format', { extension: 'bin', mimeType: 'application/octet-stream',
    bytes: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]) });
  const malformed = await api('request.submit', { clientIdempotencyKey: randomUUID(), audioArtifactId: malformedArtifactId,
    requestedModel: { route: 'local', selection: 'required', modelId: selector.modelId }, deadlineAt: null });
  const malformedDeadline = Date.now() + 180000;
  let malformedState;
  do {
    malformedState = await api('request.get', { requestId: malformed.request.requestId });
    if (['succeeded', 'failed', 'outcome_unknown'].includes(malformedState.request.taskState)) break;
    await pause(150);
  } while (Date.now() < malformedDeadline);
  assert.ok(['failed', 'outcome_unknown'].includes(malformedState.request.taskState) && malformedState.request.errorCode === 'INVALID_ARGUMENT',
    'unsupported audio cannot be reported as a successful transcript');
  const malformedResult = await api('result.get', { requestId: malformed.request.requestId });
  assert.ok(malformedResult.state !== 'available' && malformedResult.errorCode, 'rejected format has no transcript result');

  const { Client: PgClient } = pg;
  storage = new PgClient({ host: config.children.helper.PGHOST, port: Number(config.children.helper.PGPORT),
    database: config.children.helper.PGDATABASE, user: config.children.helper.PGUSER, password: config.children.helper.PGPASSWORD,
    connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000, application_name: 'transcription-asr-acceptance-readonly' });
  await storage.connect();
  storageConnected = true;
  await storage.query('BEGIN READ ONLY');
  storageReadOnly = true;

  const historySchema = new Ajv({ strict: false, coerceTypes: false, useDefaults: false });
  addFormats(historySchema); historySchema.addSchema(historyCommon); historySchema.addSchema(historyMessages);
  const historyListResponse = historySchema.getSchema(`${historyMessages.$id}#/definitions/listResponse`);
  const historyGetResponse = historySchema.getSchema(`${historyMessages.$id}#/definitions/getResponse`);
  const historyQuery = { user_id: writer.principal.scopeId, filters: { source: 'transcription' }, limit: 100 };

  const pendingArtifactId = await prepareAudio(shortFixture, 'pending', { upload: false });
  const pendingSubmit = await rawApi('request.submit', { clientIdempotencyKey: randomUUID(), audioArtifactId: pendingArtifactId,
    requestedModel: { route: 'local', selection: 'required', modelId: selector.modelId }, deadlineAt: null });
  assert.ok(pendingSubmit.status >= 400 && validateDto('ErrorResponse', pendingSubmit.value) && pendingSubmit.value.errorCode === 'ARTIFACT_NOT_READY',
    'a prepared but unuploaded artifact is rejected as not ready');
  await tap.flush();
  assert.ok(!invocations.some(value => value.audioArtifactId === pendingArtifactId), 'pending artifact rejection does not invoke local-ai');

  const missingModelArtifactId = await prepareAudio(shortFixture, 'missing-model');
  const missingModelId = `missing-${randomUUID()}`;
  const missingModelAccepted = await api('request.submit', { clientIdempotencyKey: randomUUID(), audioArtifactId: missingModelArtifactId,
    requestedModel: { route: 'local', selection: 'required', modelId: missingModelId }, deadlineAt: null });
  const missingModelRequestId = missingModelAccepted.request.requestId;
  assert.equal(missingModelAccepted.request.taskState, 'accepted');
  const missingModelFinishBy = Date.now() + 30000;
  let missingModelState;
  do {
    missingModelState = await api('request.get', { requestId: missingModelRequestId });
    if (['succeeded', 'failed', 'outcome_unknown', 'cancelled'].includes(missingModelState.request.taskState)) break;
    await pause(100);
  } while (Date.now() < missingModelFinishBy);
  assert.ok(missingModelState.request.taskState === 'failed' && missingModelState.request.errorCode === 'MODEL_UNAVAILABLE' && missingModelState.request.actualModel === null,
    'unknown model fails durably without selecting an actual model');
  const missingModelAgain = await api('request.get', { requestId: missingModelRequestId });
  assert.deepEqual(missingModelAgain.request, missingModelState.request, 'terminal missing-model request remains stable');
  await tap.flush();
  assert.ok(!invocations.some(value => value.audioArtifactId === missingModelArtifactId), 'missing model does not invoke local-ai');
  const missingModelRow = await storage.query('SELECT metadata FROM transcription.requests WHERE request_id = $1', [missingModelRequestId]);
  assert.equal(missingModelRow.rowCount, 1);
  assert.ok(missingModelRow.rows[0].metadata.taskState === 'failed' && missingModelRow.rows[0].metadata.errorCode === 'MODEL_UNAVAILABLE' &&
    missingModelRow.rows[0].metadata.actualModel === null && !hasSensitiveFields(missingModelRow.rows[0].metadata),
    'missing-model failure is durable and contains no transcript or audio');
  for (const run of [shortRun, longRun, emptyRun]) {
    let events = [];
    const finishBy = Date.now() + 30000;
    do {
      const listed = await natsRequest(historyReader, 'brai.history.v1.query.list', historyQuery);
      assert.ok(!listed.headers?.get('Nats-Service-Error') && historyListResponse(listed.value), 'published history list response');
      events = listed.value.items.filter(event => event.data.requestId === run.requestId);
      if (events.some(event => event.data.phase === 'terminal' && event.data.outcome === 'succeeded')) break;
      await pause(100);
    } while (Date.now() < finishBy);
    assert.ok(events.some(event => event.data.phase === 'accepted') && events.some(event => event.data.phase === 'terminal' && event.data.outcome === 'succeeded'),
      'history has accepted and succeeded metadata');
    const terminal = events.find(event => event.data.phase === 'terminal' && event.data.outcome === 'succeeded');
    assert.ok(terminal.data.attemptId === run.invocation.operationId && run.invocation.requestId === run.invocation.operationId,
      'history terminal attempt matches both local-ai owner correlation IDs');
    for (const event of events) {
      assert.ok(event.source === 'transcription' && event.scope_type === 'user' && event.scope_id === writer.principal.scopeId && validateDto('HistoryFact', event.data));
      assert.ok(!hasSensitiveFields(event.data), 'history excludes transcript and audio fields');
      const fetched = await natsRequest(historyReader, 'brai.history.v1.query.get', { user_id: writer.principal.scopeId, source: 'transcription', id: event.id });
      assert.ok(!fetched.headers?.get('Nats-Service-Error') && historyGetResponse(fetched.value) && fetched.value.event.id === event.id);
    }
    const attempt = await storage.query('SELECT metadata FROM transcription.attempts WHERE attempt_id = $1', [terminal.data.attemptId]);
    assert.equal(attempt.rowCount, 1, 'one durable attempt record');
    const metadata = attempt.rows[0].metadata;
    assert.ok(validateDto('AttemptRecord', metadata) && metadata.state === 'succeeded' && metadata.requestId === run.requestId && metadata.attemptId === terminal.data.attemptId,
      'durable attempt metadata identifies the completed call');
    assert.ok(typeof metadata.durationMs === 'number' && metadata.durationMs >= 0 && metadata.usage === null && metadata.cost === null,
      'owner processing duration is durable while usage and cost remain explicitly unavailable');
    assert.ok(!hasSensitiveFields(metadata), 'durable attempt metadata excludes transcript and audio');
    const requestMetadata = await storage.query('SELECT metadata FROM transcription.requests WHERE request_id = $1', [run.requestId]);
    assert.equal(requestMetadata.rowCount, 1, 'one durable request metadata record');
    assert.ok(!hasSensitiveFields(requestMetadata.rows[0].metadata), 'durable request metadata excludes transcript and audio');
  }

  let missingModelEvents = [];
  const missingModelHistoryDeadline = Date.now() + 30000;
  do {
    const listed = await natsRequest(historyReader, 'brai.history.v1.query.list', historyQuery);
    assert.ok(!listed.headers?.get('Nats-Service-Error') && historyListResponse(listed.value), 'published history list response');
    missingModelEvents = listed.value.items.filter(event => event.data.requestId === missingModelRequestId);
    if (missingModelEvents.some(event => event.data.phase === 'terminal')) break;
    await pause(100);
  } while (Date.now() < missingModelHistoryDeadline);
  const acceptedMissingModelEvent = missingModelEvents.find(event => event.data.phase === 'accepted');
  const terminalMissingModelEvent = missingModelEvents.find(event => event.data.phase === 'terminal');
  assert.ok(acceptedMissingModelEvent && terminalMissingModelEvent && terminalMissingModelEvent.data.outcome === 'failed' &&
    terminalMissingModelEvent.data.errorCode === 'MODEL_UNAVAILABLE' && validateDto('HistoryFact', acceptedMissingModelEvent.data) &&
    validateDto('HistoryFact', terminalMissingModelEvent.data) && !hasSensitiveFields(acceptedMissingModelEvent.data) && !hasSensitiveFields(terminalMissingModelEvent.data),
    'missing-model history has accepted and failed metadata without sensitive fields');
  const acceptedHistoryRead = await natsRequest(historyReader, 'brai.history.v1.query.get', { user_id: writer.principal.scopeId, source: 'transcription', id: acceptedMissingModelEvent.id });
  const terminalHistoryRead = await natsRequest(historyReader, 'brai.history.v1.query.get', { user_id: writer.principal.scopeId, source: 'transcription', id: terminalMissingModelEvent.id });
  assert.ok(!acceptedHistoryRead.headers?.get('Nats-Service-Error') && historyGetResponse(acceptedHistoryRead.value) &&
    !terminalHistoryRead.headers?.get('Nats-Service-Error') && historyGetResponse(terminalHistoryRead.value), 'history reader fetches both missing-model facts');
  assert.deepEqual(acceptedHistoryRead.value.event, acceptedMissingModelEvent, 'accepted history event is stable');
  assert.deepEqual(terminalHistoryRead.value.event, terminalMissingModelEvent, 'terminal history event is stable');

  const expiring = longRun;
  const retentionBy = Date.now() + config.domain.resultTtlMs + 5000;
  let expiry;
  do {
    expiry = await api('result.get', { requestId: expiring.requestId });
    if (expiry.state !== 'available') break;
    await pause(200);
  } while (Date.now() < retentionBy);
  assert.ok(expiry.state === 'expired' && expiry.errorCode === 'RESULT_UNAVAILABLE', 'volatile result reports its configured TTL expiry');
  const expiredRequest = await api('request.get', { requestId: expiring.requestId });
  assert.ok(expiredRequest.request.taskState === 'succeeded' && expiredRequest.request.resultState === 'expired',
    'result TTL expiry preserves the succeeded request record');
  const expiringCallsBefore = invocations.filter(value => value.audioArtifactId === expiring.artifactId).length;
  await pause(1500);
  const expiringCallsAfter = invocations.filter(value => value.audioArtifactId === expiring.artifactId).length;
  assert.equal(expiringCallsAfter, expiringCallsBefore,
    'result expiry does not automatically execute again');
  const beforeExplicit = invocations.filter(value => value.audioArtifactId === expiring.artifactId).length;
  assert.equal(beforeExplicit, expiringCallsBefore, 'no local invocation occurred between the stable result and the new request');
  const repeated = await api('request.submit', { clientIdempotencyKey: expiring.clientIdempotencyKey, audioArtifactId: expiring.artifactId,
    requestedModel: { route: 'local', selection: 'required', modelId: selector.modelId }, deadlineAt: null });
  assert.ok(repeated.request.requestId === expiring.requestId, 'same key remains idempotent after volatile result expiry');
  assert.equal(invocations.filter(value => value.audioArtifactId === expiring.artifactId).length, beforeExplicit, 'idempotent replay does not execute again');
  const explicit = await api('request.submit', { clientIdempotencyKey: randomUUID(), audioArtifactId: expiring.artifactId,
    requestedModel: { route: 'local', selection: 'required', modelId: selector.modelId }, deadlineAt: null });
  assert.ok(explicit.request.requestId !== expiring.requestId, 'only a new explicit idempotency key creates a new request');
  const explicitDeadline = Date.now() + 180000;
  let explicitState;
  do {
    explicitState = await api('request.get', { requestId: explicit.request.requestId });
    if (['succeeded', 'failed', 'outcome_unknown', 'cancelled'].includes(explicitState.request.taskState)) break;
    await pause(150);
  } while (Date.now() < explicitDeadline);
  const invocationObservedBy = Date.now() + 5000;
  while (invocations.filter(value => value.audioArtifactId === expiring.artifactId).length < beforeExplicit + 1 && Date.now() < invocationObservedBy) await pause(20);
  assert.ok(explicitState.request.taskState === 'succeeded' &&
    invocations.filter(value => value.audioArtifactId === expiring.artifactId).length === beforeExplicit + 1,
    'explicit new request creates exactly one fresh attempt');
  await tap.flush();
  assert.ok(!observerInvalid, 'observer validates all owner invoke messages');
  const historySettledBy = Date.now() + 30000;
  let historyBacklog;
  do {
    const counts = await storage.query("SELECT count(*)::integer AS backlog FROM transcription.history_outbox WHERE state <> 'acknowledged'");
    historyBacklog = counts.rows[0].backlog;
    if (historyBacklog === 0) break;
    await pause(100);
  } while (Date.now() < historySettledBy);
  assert.equal(historyBacklog, 0, 'all own fixture metadata is delivered before coordinator shutdown and the restart baseline');
});
