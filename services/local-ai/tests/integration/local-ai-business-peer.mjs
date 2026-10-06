// ABOUTME: Проверяет перегрузку, селекторы, idle-границы и аудиоформаты через собственные публичные API.
// ABOUTME: Конфигурация и media поступают только явными аргументами; import не читает окружение и не открывает сеть.
import { createHash, randomUUID } from 'node:crypto';
import { connect, ServiceErrorCodeHeader, ServiceErrorHeader } from 'nats';
import llamaProfile from '../../profiles/llama_cpp.json' with { type: 'json' };
import gigaProfile from '../../profiles/gigaam_pytorch.json' with { type: 'json' };
import { subjects, validateMetadataEvent, validateRequest, validateResponse } from '../../contracts/index.mjs';
import { assertEmbeddingOrder, assertEmbeddingResponse, assertTranscriptionResponse, parseFileUrl, parseUploadUrl } from './local-ai-peer.mjs';

export const BUSINESS_PHASES = Object.freeze(['overload', 'queued', 'idle', 'selectors', 'media']);
export const BUSINESS_MEDIA_TYPES = Object.freeze(['audio/wav', 'audio/flac', 'audio/mpeg', 'audio/ogg']);
const STATUS_BY_ERROR = Object.freeze({
  INVALID_ARGUMENT: '400', MODEL_NOT_FOUND: '404', MODEL_NOT_INSTALLED: '409', UNSUPPORTED_OPERATION: '400',
  MODEL_IN_USE: '409', INPUT_TOO_LARGE: '413', RESULT_TOO_LARGE: '413', BUSY: '429', MODEL_LOAD_FAILED: '503',
  ENGINE_UNAVAILABLE: '503', DEADLINE_EXCEEDED: '504', CANCELLED: '409', ARTIFACT_NOT_AVAILABLE: '404',
  DEPENDENCY_UNAVAILABLE: '503', INSTALLATION_FAILED: '500', REVISION_CONFLICT: '409', NOT_SUPPORTED: '400', INTERNAL: '500',
});
const MEDIA_FAILURE_CODES = new Set(['INVALID_ARGUMENT', 'NOT_SUPPORTED']);
const INVALID_MEDIA_KINDS = Object.freeze(['corrupt', 'playlist', 'concatenated', 'network_container']);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const REVISION = /^[0-9a-f]{40}$/i;
const ARTIFACT_UPLOAD_ORIGIN = 'http://172.31.247.1:19470/';
const ARTIFACT_FILES_ORIGIN = 'http://172.31.247.1:19474/';
const ARTIFACT = Object.freeze({
  prepare: 'brai.artifacts.v1.prepare', get: 'brai.artifacts.v1.get', delete: 'brai.artifacts.v1.delete',
});
const HISTORY_LIST = 'brai.history.v1.query.list';

function fail(code) { throw new Error(`LOCAL_AI_BUSINESS_${code}`); }
function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function exactObject(value, keys, field) {
  if (!isObject(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(`CONFIG_${field}`);
  return value;
}
function uuid(value, field) { if (typeof value !== 'string' || !UUID.test(value)) fail(`CONFIG_${field}`); return value; }
function positive(value, field) { if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) fail(`CONFIG_${field}`); return value; }
function digest(value, field) { if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(value)) fail(`CONFIG_${field}`); return value.toLowerCase(); }
function selector(value, expected, field) {
  exactObject(value, ['modelId', 'revision', 'profileId'], field);
  if (value.modelId !== expected.modelId || value.revision !== expected.revision || value.profileId !== expected.profileId) fail(`CONFIG_${field}`);
  if (!REVISION.test(value.revision)) fail(`CONFIG_${field}`);
  return value;
}

/** Валидирует защищённую фазовую конфигурацию и доказывает headroom для BUSY-классификации. */
export function validateBusinessConfig(input) {
  const config = exactObject(input, [
    'verifiedIsolated', 'phase', 'nats', 'proof', 'expectedProof', 'ownerId', 'foreignOwnerId',
    'timeoutMs', 'overallTimeoutMs', 'cleanupTimeoutMs', 'pollMs', 'acceptanceTimeoutMs', 'completionTimeoutMs',
    'outboxDrainTimeoutMs', 'requestDeadlineMarginMs', 'embeddingModel', 'transcriptionModel', 'operation',
    'texts', 'purpose', 'comparisonTolerance', 'positiveIdleSeconds', 'nullObservationMs', 'queueObservationMs',
    'idlePollMs', 'idleTimeoutMs', 'idleBoundaryLeadMs', 'maxInputBytes', 'maxAudioBytes', 'maxAudioSeconds',
    'providerMaxUploadBytes', 'artifactUploadOrigin', 'artifactFilesOrigin',
  ], 'ROOT');
  if (config.verifiedIsolated !== true || !BUSINESS_PHASES.includes(config.phase)) fail('CONFIG_ISOLATION');
  const natsConfig = exactObject(config.nats, ['servers', 'user', 'password', 'token', 'inboxPrefix', 'name'], 'NATS');
  if (!Array.isArray(natsConfig.servers) || natsConfig.servers.length !== 1 || natsConfig.servers[0] !== 'nats://127.0.0.1:19473'
    || natsConfig.user !== 'fixture' || typeof natsConfig.password !== 'string' || !natsConfig.password || natsConfig.token !== null
    || natsConfig.inboxPrefix !== '_INBOX.brai_fixture' || typeof natsConfig.name !== 'string' || !natsConfig.name) fail('CONFIG_NATS_GUARD');
  const proof = exactObject(config.proof, [
    'sourceRevision', 'imageDigest', 'configDigest', 'controllerServers', 'controllerUser', 'controllerInboxPrefix',
    'maxQueuedOperations', 'outboxCapacity', 'maxConcurrentRequests', 'maxRequestMs', 'maxInputBytes',
    'maxAudioBytes', 'maxAudioSeconds', 'providerMaxUploadBytes', 'outboxCounts',
  ], 'PROOF');
  const expected = exactObject(config.expectedProof, ['sourceRevision', 'imageDigest', 'configDigest'], 'EXPECTED_PROOF');
  if (!REVISION.test(proof.sourceRevision) || proof.sourceRevision !== expected.sourceRevision
    || digest(proof.imageDigest, 'PROOF_IMAGE') !== digest(expected.imageDigest, 'EXPECTED_IMAGE')
    || digest(proof.configDigest, 'PROOF_CONFIG') !== digest(expected.configDigest, 'EXPECTED_CONFIG')) fail('CONFIG_PROOF_MISMATCH');
  if (!Array.isArray(proof.controllerServers) || proof.controllerServers.length !== 1 || proof.controllerServers[0] !== 'nats://127.0.0.1:19473'
    || proof.controllerUser !== 'local_ai' || proof.controllerInboxPrefix !== '_INBOX.brai_local_ai') fail('CONFIG_PROOF_CONTROLLER_NATS');
  positive(proof.maxQueuedOperations, 'PROOF_QUEUE');
  if (!Number.isSafeInteger(proof.outboxCapacity) || proof.outboxCapacity < 8) fail('CONFIG_OUTBOX_CAPACITY');
  positive(proof.maxConcurrentRequests, 'PROOF_TRANSPORT');
  positive(proof.maxRequestMs, 'PROOF_REQUEST_TIMEOUT');
  positive(proof.maxInputBytes, 'PROOF_INPUT_BYTES');
  positive(proof.maxAudioBytes, 'PROOF_AUDIO_BYTES');
  positive(proof.providerMaxUploadBytes, 'PROOF_PROVIDER_UPLOAD_BYTES');
  if (!Number.isFinite(proof.maxAudioSeconds) || proof.maxAudioSeconds <= 0) fail('CONFIG_PROOF_AUDIO_SECONDS');
  positive(config.timeoutMs, 'TIMEOUT');
  positive(config.overallTimeoutMs, 'OVERALL_TIMEOUT');
  positive(config.cleanupTimeoutMs, 'CLEANUP_TIMEOUT');
  positive(config.pollMs, 'POLL');
  positive(config.acceptanceTimeoutMs, 'ACCEPTANCE_TIMEOUT');
  positive(config.completionTimeoutMs, 'COMPLETION_TIMEOUT');
  positive(config.outboxDrainTimeoutMs, 'OUTBOX_TIMEOUT');
  positive(config.requestDeadlineMarginMs, 'DEADLINE_MARGIN');
  if (config.timeoutMs <= config.completionTimeoutMs || config.cleanupTimeoutMs >= config.overallTimeoutMs
    || config.overallTimeoutMs <= config.completionTimeoutMs + config.cleanupTimeoutMs) fail('CONFIG_TIMEOUT_RELATION');
  uuid(config.ownerId, 'OWNER');
  uuid(config.foreignOwnerId, 'FOREIGN_OWNER');
  if (config.ownerId === config.foreignOwnerId) fail('CONFIG_OWNER_COLLISION');
  selector(config.embeddingModel, { modelId: llamaProfile.modelId, revision: llamaProfile.source.revision, profileId: llamaProfile.profileId }, 'EMBEDDING_MODEL');
  selector(config.transcriptionModel, { modelId: gigaProfile.modelId, revision: gigaProfile.source.revision, profileId: gigaProfile.profileId }, 'TRANSCRIPTION_MODEL');
  if (!['embed', 'transcribe'].includes(config.operation)) fail('CONFIG_OPERATION');
  if (config.phase === 'media' && config.operation !== 'transcribe') fail('CONFIG_MEDIA_OPERATION');
  if (!Array.isArray(config.texts) || config.texts.length < 2 || config.texts.some(text => typeof text !== 'string' || text.length === 0)
    || new Set(config.texts).size !== config.texts.length) fail('CONFIG_TEXTS');
  if (!['query', 'document', 'symmetric'].includes(config.purpose)) fail('CONFIG_PURPOSE');
  if (!Number.isFinite(config.comparisonTolerance) || config.comparisonTolerance <= 0) fail('CONFIG_TOLERANCE');
  if (config.phase === 'overload' && proof.maxQueuedOperations !== 1) fail('CONFIG_OVERLOAD_LIMIT');
  if (['queued', 'idle'].includes(config.phase) && proof.maxQueuedOperations !== 2) fail('CONFIG_QUEUED_LIMIT');
  const invokeConcurrency = config.phase === 'queued' || config.phase === 'idle' ? 3 : config.phase === 'overload' ? 2 : 1;
  if (proof.maxConcurrentRequests < invokeConcurrency + 2) fail('CONFIG_TRANSPORT_HEADROOM');
  const outboxCounts = exactObject(proof.outboxCounts, ['reserved', 'pending', 'sending', 'permanentlyFailed'], 'OUTBOX_COUNTS');
  const initialRows = Object.values(outboxCounts).reduce((total, count) => {
    if (!Number.isSafeInteger(count) || count < 0) fail('CONFIG_OUTBOX_COUNTS');
    return total + count;
  }, 0);
  if (initialRows !== 0) fail('CONFIG_OUTBOX_NOT_EMPTY');
  if (['idle', 'queued'].includes(config.phase)) positive(config.queueObservationMs, 'QUEUE_OBSERVATION');
  if (config.phase === 'idle') {
    positive(config.positiveIdleSeconds, 'POSITIVE_IDLE');
    positive(config.nullObservationMs, 'NULL_OBSERVATION');
    positive(config.idlePollMs, 'IDLE_POLL');
    positive(config.idleTimeoutMs, 'IDLE_TIMEOUT');
    positive(config.idleBoundaryLeadMs, 'IDLE_BOUNDARY_LEAD');
    if (config.nullObservationMs <= config.positiveIdleSeconds * 1000
      || config.idleTimeoutMs <= config.positiveIdleSeconds * 1000
      || config.idleBoundaryLeadMs >= config.positiveIdleSeconds * 1000) fail('CONFIG_IDLE_RELATION');
    if (config.queueObservationMs < config.positiveIdleSeconds * 1000) fail('CONFIG_IDLE_ACTIVITY_WINDOW');
  } else if (['queued', 'overload', 'selectors', 'media'].includes(config.phase)
    && ['positiveIdleSeconds', 'nullObservationMs', 'idlePollMs', 'idleTimeoutMs', 'idleBoundaryLeadMs'].some(key => config[key] !== null)) fail('CONFIG_UNEXPECTED_IDLE_POLICY');
  if (!Number.isSafeInteger(config.maxInputBytes) || config.maxInputBytes < 1
    || !Number.isSafeInteger(config.maxAudioBytes) || config.maxAudioBytes < 1
    || !Number.isSafeInteger(config.providerMaxUploadBytes) || config.providerMaxUploadBytes < config.maxAudioBytes
    || !Number.isFinite(config.maxAudioSeconds) || config.maxAudioSeconds <= 0
    || config.maxInputBytes !== proof.maxInputBytes || config.maxAudioBytes !== proof.maxAudioBytes
    || config.providerMaxUploadBytes !== proof.providerMaxUploadBytes
    || config.maxAudioSeconds !== proof.maxAudioSeconds) fail('CONFIG_AUDIO_LIMIT');
  if (config.artifactUploadOrigin !== ARTIFACT_UPLOAD_ORIGIN || config.artifactFilesOrigin !== ARTIFACT_FILES_ORIGIN) fail('CONFIG_ARTIFACT_ORIGIN');
  if (proof.maxRequestMs <= config.requestDeadlineMarginMs) fail('CONFIG_DEADLINE_MARGIN');
  return config;
}

/** Создаёт только узкий набор schema-valid отрицательных wire cases по закреплённым селекторам. */
export function buildSelectorNegativeCases(config) {
  const ownerId = config.ownerId;
  const now = new Date(Date.now() + config.proof.maxRequestMs - config.requestDeadlineMarginMs).toISOString();
  const base = { modelId: config.embeddingModel.modelId, revision: config.embeddingModel.revision, profileId: config.embeddingModel.profileId, ownerId };
  return [
    { id: randomUUID(), subject: subjects.modelsConfigure, request: { ...base, revision: 'f'.repeat(40), idleUnloadSeconds: null }, expected: 'REVISION_CONFLICT' },
    { id: randomUUID(), subject: subjects.modelsConfigure, request: { ...base, profileId: 'unsupported_profile', idleUnloadSeconds: null }, expected: 'REVISION_CONFLICT' },
    { id: randomUUID(), subject: subjects.modelsGet, request: { modelId: 'unregistered-fixture-model' }, expected: 'MODEL_NOT_FOUND' },
    { id: randomUUID(), subject: subjects.invokeEmbed, request: {
      requestId: randomUUID(), operationId: randomUUID(), model: config.transcriptionModel, ownerId,
      deadlineAt: now, texts: [config.texts[0]], purpose: config.purpose,
    }, expected: 'UNSUPPORTED_OPERATION' },
  ].map(item => {
    if (!validateRequest(item.subject, item.request)) fail('NEGATIVE_CASE_SCHEMA');
    return item;
  });
}

/** Требует четыре предоставленных media bytes fixtures с совпадающими SHA256 и измеренными ограничениями. */
export function validateBusinessMedia(media, config) {
  const input = exactObject(media, ['samples', 'invalidSamples'], 'MEDIA');
  if (!Array.isArray(input.samples) || input.samples.length !== BUSINESS_MEDIA_TYPES.length) fail('MEDIA_MATRIX');
  if (!Array.isArray(input.invalidSamples) || ![INVALID_MEDIA_KINDS.length, INVALID_MEDIA_KINDS.length + 1].includes(input.invalidSamples.length)) fail('MEDIA_INVALID_MATRIX');
  const byType = new Map();
  const fixtureIds = new Set();
  for (const sample of input.samples) {
    const checked = validateBusinessMediaSample(sample, config);
    if (byType.has(checked.mimeType)) fail('MEDIA_MIME_MATRIX');
    if (fixtureIds.has(checked.fixtureId)) fail('MEDIA_FIXTURE_DUPLICATE');
    fixtureIds.add(checked.fixtureId);
    byType.set(checked.mimeType, checked);
  }
  if (BUSINESS_MEDIA_TYPES.some(mime => !byType.has(mime))) fail('MEDIA_MIME_MATRIX');
  const invalidByKind = new Map();
  for (const sample of input.invalidSamples) {
    const checked = validateInvalidBusinessMediaSample(sample, config);
    if (invalidByKind.has(checked.kind)) fail('MEDIA_INVALID_DUPLICATE');
    if (fixtureIds.has(checked.fixtureId)) fail('MEDIA_FIXTURE_DUPLICATE');
    fixtureIds.add(checked.fixtureId);
    invalidByKind.set(checked.kind, checked);
  }
  if (INVALID_MEDIA_KINDS.some(kind => !invalidByKind.has(kind))) fail('MEDIA_INVALID_MATRIX');
  return { valid: BUSINESS_MEDIA_TYPES.map(mime => byType.get(mime)), invalid: [...invalidByKind.values()] };
}

/** Проверяет один media bytes fixture по явной MIME, hash, duration, size и reference. */
export function validateBusinessMediaSample(sample, config) {
  exactObject(sample, ['fixtureId', 'bytes', 'mimeType', 'sha256', 'durationSeconds', 'expectedText'], 'MEDIA_SAMPLE');
  uuid(sample.fixtureId, 'MEDIA_FIXTURE_ID');
  if (!BUSINESS_MEDIA_TYPES.includes(sample.mimeType)) fail('MEDIA_MIME');
  if (!(sample.bytes instanceof Uint8Array) || sample.bytes.byteLength < 1
    || sample.bytes.byteLength > Math.min(config.maxInputBytes, config.maxAudioBytes)) fail('MEDIA_SIZE');
  if (typeof sample.sha256 !== 'string' || !SHA256.test(sample.sha256)
    || createHash('sha256').update(sample.bytes).digest('hex') !== sample.sha256.toLowerCase()) fail('MEDIA_HASH');
  if (!Number.isFinite(sample.durationSeconds) || sample.durationSeconds <= 0 || sample.durationSeconds > config.maxAudioSeconds) fail('MEDIA_DURATION');
  if (typeof sample.expectedText !== 'string' || sample.expectedText.trim().length === 0) fail('MEDIA_REFERENCE');
  return sample;
}

/** Валидирует owner-provided negative bytes case без выдумывания ожидаемой ошибки. */
export function validateInvalidBusinessMediaSample(sample, config) {
  exactObject(sample, ['fixtureId', 'bytes', 'mimeType', 'sha256', 'durationSeconds', 'kind', 'expectedErrorCode', 'expectedAccepted'], 'INVALID_MEDIA_SAMPLE');
  uuid(sample.fixtureId, 'INVALID_MEDIA_FIXTURE_ID');
  if (!BUSINESS_MEDIA_TYPES.includes(sample.mimeType)) fail('INVALID_MEDIA_MIME');
  if (!(sample.bytes instanceof Uint8Array) || sample.bytes.byteLength < 1 || sample.bytes.byteLength > config.providerMaxUploadBytes
    || (sample.kind !== 'oversize' && sample.bytes.byteLength > Math.min(config.maxInputBytes, config.maxAudioBytes))) fail('INVALID_MEDIA_SIZE');
  if (typeof sample.sha256 !== 'string' || !SHA256.test(sample.sha256)
    || createHash('sha256').update(sample.bytes).digest('hex') !== sample.sha256.toLowerCase()) fail('INVALID_MEDIA_HASH');
  if (INVALID_MEDIA_KINDS.includes(sample.kind)) {
    if (sample.durationSeconds !== null || sample.expectedAccepted !== true || !MEDIA_FAILURE_CODES.has(sample.expectedErrorCode)
      || sample.expectedErrorCode === 'ENGINE_UNAVAILABLE') fail('INVALID_MEDIA_EXPECTATION');
  } else if (sample.kind === 'oversize') {
    if (!Number.isFinite(sample.durationSeconds) || sample.durationSeconds <= 0 || sample.durationSeconds > config.maxAudioSeconds
      || sample.bytes.byteLength <= Math.max(config.maxInputBytes, config.maxAudioBytes)
      || sample.expectedAccepted !== false || sample.expectedErrorCode !== 'INPUT_TOO_LARGE') fail('OVERSIZE_MEDIA_EXPECTATION');
  } else fail('INVALID_MEDIA_KIND');
  return sample;
}

/** Разрешает BUSY как runtime-очередь только при запасе transport и durable outbox. */
export function assertRuntimeBusyCapacity(config, status, concurrentInvokes) {
  positive(concurrentInvokes, 'INFLIGHT_INVOKES');
  if (config.proof.maxConcurrentRequests < concurrentInvokes + 2) fail('BUSY_CAUSE_TRANSPORT_AMBIGUOUS');
  assertBusinessStatus(status);
  const counts = status?.outboxCounts;
  if (!counts || Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0)
    || counts.permanentlyFailed > 0) fail('BUSY_CAUSE_OUTBOX_UNAVAILABLE');
  const occupied = counts.reserved + counts.pending + counts.sending + counts.permanentlyFailed;
  const free = config.proof.outboxCapacity - occupied;
  if (free < 2) fail('BUSY_CAUSE_OUTBOX_AMBIGUOUS');
  return { transportHeadroom: config.proof.maxConcurrentRequests - concurrentInvokes, freeOutboxRows: free };
}

/** Подтверждает ровно один accepted и один terminal fact для одной принятой операции. */
export function assertBusinessOperationLedger(events, operationId, expectedOutcome = null) {
  if (!Array.isArray(events)) fail('LEDGER_INVALID');
  const related = events.filter(event => event.operationId === operationId);
  const accepted = related.filter(event => event.outcome === 'accepted' && event.phase === 'accepted');
  const terminal = related.filter(event => ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(event.outcome));
  if (accepted.length !== 1 || terminal.length !== 1 || related.length !== 2
    || (expectedOutcome !== null && terminal[0].outcome !== expectedOutcome)
    || new Set(related.map(event => event.id)).size !== 2) fail('LEDGER_DUPLICATE_OR_MISSING');
  return { acceptedEventId: accepted[0].id, terminalEventId: terminal[0].id, outcome: terminal[0].outcome };
}

/** Удаляет только один доказанный terminal operation из общего artifact barrier. */
export function markArtifactOperationTerminal(entry, operationId) {
  if (!entry || !(entry.pendingOperationIds instanceof Set) || !entry.pendingOperationIds.has(operationId)) fail('ARTIFACT_OPERATION_NOT_TRACKED');
  entry.pendingOperationIds.delete(operationId);
  entry.terminalConfirmed = entry.pendingOperationIds.size === 0;
  return entry.terminalConfirmed;
}

/** Создаёт итоговый metadata-only receipt после всех bounded cleanup попыток. */
export function buildBusinessCleanupReceipt(summary, deferredIds, artifacts) {
  if (!summary || !Array.isArray(deferredIds) || !(artifacts instanceof Map)) fail('CLEANUP_RECEIPT_INVALID');
  return { ...summary, cleanupDeferredArtifactIds: [...new Set(deferredIds)],
    artifactsCleanupComplete: deferredIds.length === 0 && [...artifacts.values()].every(entry => entry.deleted) };
}

/** Ограничивает соединение по общей фазовой границе и закрывает только собственный поздний результат. */
export async function connectWithinBound(connectNats, options, deadline) {
  const attempt = Promise.resolve(connectNats(options));
  let settled = false;
  let won = false;
  attempt.then(connection => { if (settled && !won) void connection.close(); }).catch(() => {});
  try {
    const connection = await bounded(attempt, deadline, 'NATS_CONNECT_TIMEOUT');
    won = true;
    return connection;
  } finally { settled = true; }
}

/** Drains only the owned connection; on a bounded failure, invokes its synchronous close as a last resort. */
export async function drainOwnedConnection(nc, deadline) {
  try {
    await bounded(nc.drain(), deadline, 'NATS_DRAIN_TIMEOUT');
    return { drained: true, closeRequested: false };
  } catch {
    try { nc.close(); return { drained: false, closeRequested: true }; }
    catch { return { drained: false, closeRequested: false }; }
  }
}

function remaining(deadline) { return Math.max(0, deadline - Date.now()); }
function bounded(value, deadline, code) {
  const ms = remaining(deadline);
  if (ms < 1) fail(code);
  let timer;
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`LOCAL_AI_BUSINESS_${code}`)), ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
function decode(reply) {
  const codeHeader = reply.headers?.has(ServiceErrorHeader) ?? false;
  const statusHeader = reply.headers?.has(ServiceErrorCodeHeader) ?? false;
  if (codeHeader !== statusHeader) fail('ERROR_HEADERS_MISMATCH');
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.data)); } catch { fail('INVALID_REPLY'); }
  if (!codeHeader) return { value: body, error: null };
  const code = reply.headers.get(ServiceErrorHeader);
  if (!isObject(body) || body.code !== code || STATUS_BY_ERROR[code] !== reply.headers.get(ServiceErrorCodeHeader)
    || body.message !== code || typeof body.retryable !== 'boolean') fail('ERROR_BODY_MISMATCH');
  return { value: null, error: { code, retryable: body.retryable } };
}
function checkFailure(reply, expected) {
  const result = decode(reply);
  if (!result.error || result.error.code !== expected) fail(`EXPECTED_${expected}`);
  return result.error;
}
function digestBytes(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function selectorFor(config, operation) { return operation === 'embed' ? config.embeddingModel : config.transcriptionModel; }
function makeRequest(config, operation, textIndex, artifactId) {
  const model = selectorFor(config, operation);
  const request = {
    requestId: randomUUID(), operationId: randomUUID(), model, ownerId: config.ownerId,
    deadlineAt: new Date(Date.now() + config.proof.maxRequestMs - config.requestDeadlineMarginMs).toISOString(),
  };
  if (operation === 'embed') {
    request.texts = [config.texts[textIndex % config.texts.length]];
    request.purpose = config.purpose;
  } else request.audioArtifactId = artifactId;
  return request;
}

/** Выполняет строго заданную business acceptance phase через public NATS and own public artifact fixture only. */
export async function runLocalAiBusinessPeer(input, mediaInput = null, dependencies = {}) {
  const config = validateBusinessConfig(input);
  const media = config.phase === 'media' ? validateBusinessMedia(mediaInput, config) : null;
  const activitySample = config.operation === 'transcribe' && !['selectors', 'media'].includes(config.phase)
    ? validateActivitySample(mediaInput, config) : null;
  const connectNats = dependencies.connect ?? connect;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const deadline = Date.now() + config.overallTimeoutMs;
  const workDeadline = deadline - config.cleanupTimeoutMs;
  const operations = new Map();
  const artifacts = new Map();
  const evidence = [];
  let nc;
  let summary = null;
  let failureCode = null;
  let connectionCleanup = { drained: true, closeRequested: false };
  let cleanupDeferredIds = [];
  try {
    nc = await connectWithinBound(connectNats, { servers: config.nats.servers, user: config.nats.user, pass: config.nats.password,
      name: config.nats.name, inboxPrefix: config.nats.inboxPrefix, maxReconnectAttempts: 0,
      timeout: Math.min(config.timeoutMs, remaining(workDeadline)) }, workDeadline);
    const request = async (subject, value, expectedError = null) => {
      if (!validateRequest(subject, value)) fail('REQUEST_SCHEMA');
      let reply;
      try { reply = await nc.request(subject, Buffer.from(JSON.stringify(value)), { timeout: Math.min(config.timeoutMs, remaining(workDeadline)) }); }
      catch { fail('REQUEST_FAILED'); }
      const decoded = decode(reply);
      if (expectedError) {
        if (!decoded.error || decoded.error.code !== expectedError) fail(`EXPECTED_${expectedError}`);
        return { error: decoded.error };
      }
      if (decoded.error || !validateResponse(subject, decoded.value)) fail(decoded.error ? `SERVICE_${decoded.error.code}` : 'RESPONSE_SCHEMA');
      return { value: decoded.value };
    };
    const historyEvents = async operationId => readBusinessHistory(nc, config, operationId, Math.min(workDeadline, Date.now() + config.acceptanceTimeoutMs));
    const waitAccepted = async operationId => {
      const until = Math.min(workDeadline, Date.now() + config.acceptanceTimeoutMs);
      while (remaining(until) > 0) {
        const events = await historyEvents(operationId);
        const accepted = events.filter(event => event.outcome === 'accepted' && event.phase === 'accepted');
        if (accepted.length > 1) fail('DUPLICATE_ACCEPTANCE');
        if (accepted.length === 1) return accepted[0];
        await bounded(new Promise(resolve => setTimeout(resolve, Math.min(config.pollMs, remaining(until)))), until, 'ACCEPTANCE_TIMEOUT');
      }
      fail('ACCEPTANCE_NOT_OBSERVED');
    };
    const waitTerminal = async (operationId, expectedOutcome = 'succeeded') => {
      const until = Math.min(workDeadline, Date.now() + config.completionTimeoutMs);
      while (remaining(until) > 0) {
        const events = await historyEvents(operationId);
        const terminal = events.filter(event => ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(event.outcome));
        if (terminal.length === 1) {
          const ledger = assertBusinessOperationLedger(events, operationId, expectedOutcome);
          const record = operations.get(operationId);
          if (record) record.ledger = ledger;
          if (record?.artifactId) {
            const entry = artifacts.get(record.artifactId);
            markArtifactOperationTerminal(entry, operationId);
          }
          return ledger;
        }
        if (terminal.length > 1) fail('DUPLICATE_TERMINAL');
        await bounded(new Promise(resolve => setTimeout(resolve, Math.min(config.pollMs, remaining(until)))), until, 'TERMINAL_TIMEOUT');
      }
      fail('TERMINAL_NOT_OBSERVED');
    };
    const getStatus = async () => (await request(subjects.status, { ownerId: config.ownerId })).value;
    const outboxEmpty = async () => {
      const until = Math.min(workDeadline, Date.now() + config.outboxDrainTimeoutMs);
      while (remaining(until) > 0) {
        const status = await getStatus();
        assertBusinessStatus(status);
        const c = status.outboxCounts;
        if (c.permanentlyFailed > 0) fail('OUTBOX_PERMANENT_FAILURE');
        if (c.reserved === 0 && c.pending === 0 && c.sending === 0) return status;
        await bounded(new Promise(resolve => setTimeout(resolve, Math.min(config.pollMs, remaining(until)))), until, 'OUTBOX_DRAIN_TIMEOUT');
      }
      fail('OUTBOX_DRAIN_TIMEOUT');
    };
    const startInvoke = (op, index, artifactId, expectedText = activitySample?.expectedText) => {
      const subject = op === 'embed' ? subjects.invokeEmbed : subjects.invokeTranscribe;
      const dto = makeRequest(config, op, index, artifactId);
      if (!validateRequest(subject, dto)) fail('REQUEST_SCHEMA');
      let replyPromise;
      try { replyPromise = nc.request(subject, Buffer.from(JSON.stringify(dto)), { timeout: Math.min(config.timeoutMs, remaining(workDeadline)) }); }
      catch { fail('REQUEST_FAILED'); }
      const promise = Promise.resolve(replyPromise).then(reply => {
        const decoded = decode(reply);
        if (decoded.error) throw new Error(`LOCAL_AI_BUSINESS_SERVICE_${decoded.error.code}`);
        if (!validateResponse(subject, decoded.value)) fail('RESPONSE_SCHEMA');
        if (op === 'embed') assertEmbeddingResponse(decoded.value, dto, llamaProfile.encoding.dimensions);
        else assertTranscriptionResponse(decoded.value, dto, expectedText);
        return decoded.value;
      });
      let settled = false;
      const settlement = promise.then(value => ({ value }), error => ({ error: error?.message?.startsWith('LOCAL_AI_BUSINESS_') ? error.message : 'LOCAL_AI_BUSINESS_REQUEST_FAILED' }))
        .then(result => { settled = true; return result; });
      const record = { request: dto, subject, promise, settlement, isSettled: () => settled, artifactId, ledger: null };
      operations.set(dto.operationId, record);
      if (artifactId) {
        const entry = artifacts.get(artifactId);
        entry.pendingOperationIds.add(dto.operationId);
        entry.terminalConfirmed = false;
      }
      return record;
    };
    const proveNoAccepted = async operationId => {
      const events = await historyEvents(operationId);
      if (events.length !== 0) fail('REJECTED_OPERATION_HAS_HISTORY');
      const record = operations.get(operationId);
      if (record?.artifactId) {
        const entry = artifacts.get(record.artifactId);
        markArtifactOperationTerminal(entry, operationId);
      }
    };
    const configure = async (value, idleUnloadSeconds) => {
      const selectorValue = selectorFor(config, config.operation);
      const result = await request(subjects.modelsConfigure, {
        modelId: selectorValue.modelId, revision: selectorValue.revision, profileId: selectorValue.profileId,
        ownerId: config.ownerId, idleUnloadSeconds,
      });
      if (result.value.idleUnloadSeconds !== idleUnloadSeconds) fail('CONFIGURE_RESPONSE_MISMATCH');
      return result.value;
    };
    const getCard = async selectorValue => (await request(subjects.modelsGet, { modelId: selectorValue.modelId })).value;
    const load = async selectorValue => {
      const result = await request(subjects.modelsLoad, { modelId: selectorValue.modelId, revision: selectorValue.revision,
        profileId: selectorValue.profileId, ownerId: config.ownerId,
        deadlineAt: new Date(Date.now() + config.proof.maxRequestMs - config.requestDeadlineMarginMs).toISOString() });
      if (result.value.state !== 'loaded') fail('MODEL_LOAD_RESPONSE');
    };
    const unload = async selectorValue => {
      const result = await request(subjects.modelsUnload, { modelId: selectorValue.modelId, revision: selectorValue.revision,
        profileId: selectorValue.profileId, ownerId: config.ownerId,
        deadlineAt: new Date(Date.now() + config.proof.maxRequestMs - config.requestDeadlineMarginMs).toISOString() });
      if (result.value.state !== 'unloaded') fail('MODEL_UNLOAD_RESPONSE');
    };
    const prepareArtifact = async sample => {
      const entry = await createBusinessArtifact({ nc, config, sample, fetchImpl, workDeadline, timeout: config.timeoutMs,
        onPrepared: value => artifacts.set(value.artifactId, value) });
      return entry.artifactId;
    };
    const deleteArtifact = async id => {
      await deleteBusinessArtifact({ nc, config, entry: artifacts.get(id), fetchImpl, workDeadline, timeout: config.timeoutMs });
      artifacts.get(id).deleted = true;
    };

    const initialStatus = await getStatus();
    assertBusinessStatus(initialStatus);
    for (const key of ['reserved', 'pending', 'sending', 'permanentlyFailed']) {
      if (initialStatus.outboxCounts[key] !== config.proof.outboxCounts[key]) fail('OUTBOX_PROOF_STALE');
    }
    if (initialStatus.outboxCounts.reserved || initialStatus.outboxCounts.pending || initialStatus.outboxCounts.sending || initialStatus.outboxCounts.permanentlyFailed) fail('OUTBOX_NOT_CLEAN_AT_START');
    if (config.phase === 'selectors') {
      await runSelectorCases({ config, request, proveNoAccepted, getCard });
      evidence.push('typed-selector-errors', 'no-selector-fallback');
    } else if (config.phase === 'media') {
      if (config.operation !== 'transcribe') fail('MEDIA_OPERATION_MUST_TRANSCRIBE');
      for (const sample of media.valid) {
        const artifactId = await prepareArtifact(sample);
        const record = startInvoke('transcribe', 0, artifactId, sample.expectedText);
        const response = await bounded(record.promise, workDeadline, 'INVOKE_TIMEOUT');
        const ledger = await waitTerminal(record.request.operationId);
        await deleteArtifact(artifactId);
        evidence.push(`valid-${sample.mimeType}`, ledger.outcome);
        void response;
      }
      for (const sample of media.invalid) {
        const artifactId = await prepareArtifact(sample);
        const record = startInvoke('transcribe', 0, artifactId, '');
        const reply = await bounded(record.settlement, workDeadline, 'INVALID_MEDIA_REPLY_TIMEOUT');
        if (reply.error !== `LOCAL_AI_BUSINESS_SERVICE_${sample.expectedErrorCode}`) fail('INVALID_MEDIA_SAFE_ERROR');
        if (sample.expectedAccepted) {
          await waitAccepted(record.request.operationId);
          const ledger = await waitTerminal(record.request.operationId, 'failed');
          if (ledger.outcome !== 'failed') fail('INVALID_MEDIA_TERMINAL_OUTCOME');
        } else await proveNoAccepted(record.request.operationId);
        if (!artifacts.get(artifactId).terminalConfirmed) fail('INVALID_MEDIA_CLEANUP_UNCONFIRMED');
        await deleteArtifact(artifactId);
        evidence.push(`invalid-${sample.kind}-${sample.expectedErrorCode}`);
      }
      evidence.push('public-artifacts-valid-and-negative-media-cases');
    } else {
      const selectorValue = selectorFor(config, config.operation);
      const activityArtifact = activitySample ? await prepareArtifact(activitySample) : null;
      if (config.phase === 'idle') {
        await configure(selectorValue, null);
        await load(selectorValue);
        const nullStarted = Date.now();
        await bounded(new Promise(resolve => setTimeout(resolve, config.nullObservationMs)), workDeadline, 'NULL_IDLE_OBSERVATION_TIMEOUT');
        const nullCard = await getCard(selectorValue);
        if (Date.now() - nullStarted <= config.positiveIdleSeconds * 1000 || nullCard.runtimeState !== 'ready') fail('NULL_IDLE_NOT_PROVEN');
        await unload(selectorValue);
        await configure(selectorValue, config.positiveIdleSeconds);
        await load(selectorValue);
        const positiveStartedAt = Date.now();
        const activeAtBoundary = positiveStartedAt + config.positiveIdleSeconds * 1000 - config.idleBoundaryLeadMs;
        await bounded(new Promise(resolve => setTimeout(resolve, Math.max(0, activeAtBoundary - Date.now()))), workDeadline, 'IDLE_BOUNDARY_WINDOW_MISSED');
        if ((await getCard(selectorValue)).runtimeState !== 'ready') fail('IDLE_BOUNDARY_NOT_READY');
        const timerBoundaryRequest = startInvoke(config.operation, 0, activityArtifact);
        await waitAccepted(timerBoundaryRequest.request.operationId);
        if (timerBoundaryRequest.isSettled()) fail('IDLE_BOUNDARY_REQUEST_NOT_ACTIVE');
        const oldTimerBoundary = positiveStartedAt + config.positiveIdleSeconds * 1000;
        if (oldTimerBoundary >= workDeadline) fail('IDLE_BOUNDARY_WINDOW_MISSED');
        await bounded(new Promise(resolve => setTimeout(resolve, Math.max(0, oldTimerBoundary - Date.now()))), workDeadline, 'IDLE_BOUNDARY_WINDOW_MISSED');
        const activeBoundaryCard = await getCard(selectorValue);
        if (activeBoundaryCard.runtimeState !== 'ready' || timerBoundaryRequest.isSettled()) fail('IDLE_TIMER_UNLOADED_ACTIVE_REQUEST');
        const boundaryOutcome = await bounded(timerBoundaryRequest.promise, workDeadline, 'IDLE_BOUNDARY_INVOKE_TIMEOUT');
        const boundaryLedger = await waitTerminal(timerBoundaryRequest.request.operationId);
        if (boundaryLedger.outcome !== 'succeeded') fail('IDLE_BOUNDARY_TERMINAL_FAILED');
        void boundaryOutcome;
        evidence.push('null-idle-outlived-old-positive-interval');
        evidence.push('positive-idle-boundary-preserved-active-request');
      }
      const admissionStatus = await outboxEmpty();
      const busyProof = await assertRuntimeBusyCapacity(config, admissionStatus, config.phase === 'overload' ? 2 : 3);
      const acceptedRecords = await runAdmissionSequence({
        config, operation: config.operation, artifactId: activityArtifact, request: startInvoke,
        waitAccepted, historyEvents, proveNoAccepted, getStatus, getCard, workDeadline,
        acceptedLimit: config.phase === 'overload' ? 1 : 2,
      });
      for (const item of acceptedRecords) await waitTerminal(item.request.operationId);
      evidence.push(config.phase === 'overload' ? 'active-limit-one-busy' : 'active-and-queued-no-lost-work');
      if (config.phase === 'idle') {
        const afterWork = Date.now();
        const idleDeadline = Math.min(workDeadline, afterWork + config.idleTimeoutMs);
        let card;
        while (remaining(idleDeadline) > 0) {
          card = await getCard(selectorValue);
          if (card.runtimeState === 'unloading' || card.runtimeState === 'unloaded') break;
          await bounded(new Promise(resolve => setTimeout(resolve, Math.min(config.idlePollMs, remaining(idleDeadline)))), idleDeadline, 'IDLE_UNLOAD_TIMEOUT');
        }
        if (!card || !['unloading', 'unloaded'].includes(card.runtimeState)) fail('IDLE_UNLOAD_NOT_OBSERVED');
        const boundaryState = card.runtimeState;
        const boundary = startInvoke(config.operation, config.texts.length - 1, activityArtifact);
        await bounded(boundary.promise, workDeadline, 'IDLE_BOUNDARY_INVOKE_TIMEOUT');
        const boundaryLedger = await waitTerminal(boundary.request.operationId);
        evidence.push(`new-request-after-${boundaryState}`, boundaryLedger.outcome);
      } else evidence.push(`runtime-busy-margin-${busyProof.freeOutboxRows}`);
      if (activityArtifact) {
        if (!artifacts.get(activityArtifact).terminalConfirmed) fail('AUDIO_TERMINAL_NOT_CONFIRMED');
        await deleteArtifact(activityArtifact);
      }
      if (config.phase === 'idle') {
        await unload(selectorValue);
        evidence.push('public-unload-ack-after-work');
      }
    }
    const finalStatus = await outboxEmpty();
    evidence.push('outbox-drained-no-permanent-failure');
    summary = buildSafeSummary(config, evidence, operations, artifacts, finalStatus, cleanupDeferredIds);
  } catch (error) {
    failureCode = typeof error?.message === 'string' && /^LOCAL_AI_BUSINESS_[A-Z0-9_]+$/.test(error.message)
      ? error.message.slice('LOCAL_AI_BUSINESS_'.length) : 'UNEXPECTED_FAILURE';
  } finally {
    const cleanupDeadline = Math.min(deadline, Date.now() + config.cleanupTimeoutMs);
    if (nc) {
      for (const record of operations.values()) {
        if (record.isSettled()) continue;
        try {
          const result = await bounded(record.settlement, cleanupDeadline, 'CLEANUP_SETTLEMENT_TIMEOUT');
          if (!result.error) {
            const events = await readBusinessHistory(nc, config, record.request.operationId, cleanupDeadline);
            const terminal = events.some(event => ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(event.outcome));
            if (terminal && record.artifactId) {
              const entry = artifacts.get(record.artifactId);
              markArtifactOperationTerminal(entry, record.request.operationId);
            }
          }
        } catch { /* Unsettled work keeps its own artifact. */ }
      }
      for (const [id, entry] of artifacts) {
        if (entry.deleted) continue;
        if (!entry.terminalConfirmed || !entry.uploaded) { cleanupDeferredIds.push(id); continue; }
        try {
          await bounded(deleteBusinessArtifact({ nc, config, entry, fetchImpl, workDeadline: cleanupDeadline, timeout: config.timeoutMs }), cleanupDeadline, 'ARTIFACT_CLEANUP_TIMEOUT');
          entry.deleted = true;
        }
        catch { cleanupDeferredIds.push(id); }
      }
      connectionCleanup = await drainOwnedConnection(nc, cleanupDeadline);
    }
  }
  if (failureCode) {
    const failure = new Error(`LOCAL_AI_BUSINESS_${failureCode}`);
    failure.receipt = buildBusinessCleanupReceipt({ ...(summary ?? buildSafeSummary(config, evidence, operations, artifacts, null, cleanupDeferredIds)),
      connectionCleanup }, cleanupDeferredIds, artifacts);
    throw failure;
  }
  return buildBusinessCleanupReceipt({ ...summary, connectionCleanup }, cleanupDeferredIds, artifacts);
}

function validateActivitySample(sample, config) {
  return validateBusinessMediaSample(sample, config);
}

async function runAdmissionSequence(context) {
  const { config, operation, artifactId, request: start, waitAccepted, historyEvents, proveNoAccepted, getStatus, getCard, workDeadline, acceptedLimit } = context;
  const first = start(operation, 0, artifactId);
  await waitAccepted(first.request.operationId);
  if (first.isSettled()) fail('ACTIVE_REQUEST_FINISHED_BEFORE_PROOF');
  const second = start(operation, 1, artifactId);
  if (acceptedLimit === 1) {
    const secondResult = await bounded(second.settlement, workDeadline, 'OVERLOAD_REPLY_TIMEOUT');
    if (secondResult.error !== 'LOCAL_AI_BUSINESS_SERVICE_BUSY') fail('EXPECTED_RUNTIME_BUSY');
    const busyStatus = await getStatus();
    assertBusinessStatus(busyStatus);
    assertRuntimeBusyCapacity(config, busyStatus, 2);
    await proveNoAccepted(second.request.operationId);
    if (first.isSettled()) fail('OVERLOAD_WINDOW_NOT_ACTIVE');
    return [first];
  }
  await waitAccepted(second.request.operationId);
  if (first.isSettled() || second.isSettled()) fail('QUEUED_WINDOW_NOT_ACTIVE');
  const holdUntil = Math.min(workDeadline, Date.now() + config.queueObservationMs);
  while (remaining(holdUntil) > 0) {
    const card = await getCard(selectorFor(config, operation));
    if (card.runtimeState !== 'ready' || first.isSettled() || second.isSettled()) fail('ACTIVE_OR_QUEUED_RUNTIME_UNLOAD');
    await bounded(new Promise(resolve => setTimeout(resolve, Math.min(config.pollMs, remaining(holdUntil)))), holdUntil, 'QUEUE_OBSERVATION_TIMEOUT');
  }
  const third = start(operation, 2, artifactId);
  const busy = await bounded(third.settlement, workDeadline, 'QUEUE_OVERLOAD_REPLY_TIMEOUT');
  if (busy.error !== 'LOCAL_AI_BUSINESS_SERVICE_BUSY') fail('EXPECTED_RUNTIME_BUSY');
  const busyStatus = await getStatus();
  assertBusinessStatus(busyStatus);
  assertRuntimeBusyCapacity(config, busyStatus, 3);
  await proveNoAccepted(third.request.operationId);
  if (first.isSettled() || second.isSettled()) fail('QUEUED_WINDOW_NOT_ACTIVE');
  const eventsA = await historyEvents(first.request.operationId);
  const eventsB = await historyEvents(second.request.operationId);
  if (eventsA.some(event => ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(event.outcome))
    || eventsB.some(event => ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(event.outcome))) fail('QUEUE_TERMINAL_BEFORE_RELEASE');
  const results = await Promise.all([first.settlement, second.settlement].map(value => bounded(value, workDeadline, 'QUEUE_COMPLETION_TIMEOUT')));
  if (results.some(result => result.error)) fail('QUEUE_ACCEPTED_REQUEST_FAILED');
  return [first, second];
}

async function runSelectorCases({ config, request, proveNoAccepted, getCard }) {
  const before = [await getCard(config.embeddingModel), await getCard(config.transcriptionModel)].map(card => card.runtimeState);
  for (const probe of buildSelectorNegativeCases(config)) {
    const body = { ...probe.request };
    if (probe.subject === subjects.invokeEmbed) body.requestId = randomUUID();
    const reply = await request(probe.subject, body, probe.expected);
    if (probe.request.operationId) await proveNoAccepted(probe.request.operationId);
    void reply;
  }
  const after = [await getCard(config.embeddingModel), await getCard(config.transcriptionModel)].map(card => card.runtimeState);
  if (before.some((state, index) => state !== after[index])) fail('NEGATIVE_SELECTOR_CHANGED_RUNTIME');
}

function assertBusinessStatus(status) {
  if (!isObject(status) || !['ready', 'degraded', 'unavailable'].includes(status.state)
    || !isObject(status.components) || !isObject(status.outboxCounts)) fail('STATUS_INVALID');
  if (status.state !== 'ready' || Object.values(status.components).some(component => component.state !== 'ready')) fail('DEPENDENCY_NOT_READY');
  const counts = status.outboxCounts;
  for (const key of ['reserved', 'pending', 'sending', 'permanentlyFailed']) if (!Number.isSafeInteger(counts[key]) || counts[key] < 0) fail('STATUS_OUTBOX_INVALID');
  return true;
}

async function readBusinessHistory(nc, config, operationId, deadline) {
  const events = [];
  let cursor = null;
  const seen = new Set();
  do {
    if (remaining(deadline) < 1) fail('HISTORY_TIMEOUT');
    let reply;
    try {
      reply = await nc.request(HISTORY_LIST, Buffer.from(JSON.stringify({ user_id: config.ownerId,
        filters: { source: 'local_ai', object_type: 'operation', object_id: operationId }, limit: 100, cursor })),
      { timeout: Math.min(config.timeoutMs, remaining(deadline)) });
    } catch { fail('HISTORY_REQUEST_FAILED'); }
    const decoded = decode(reply);
    if (decoded.error) fail('HISTORY_SERVICE_ERROR');
    const page = decoded.value;
    if (!isObject(page) || !Array.isArray(page.items) || !(page.next_cursor === null || typeof page.next_cursor === 'string')) fail('HISTORY_PAGE_INVALID');
    for (const item of page.items) {
      const { source, recorded_at: _recordedAt, ...fact } = item;
      if (source !== 'local_ai' || !validateMetadataEvent(fact) || fact.scope_type !== 'user' || fact.scope_id !== config.ownerId
        || fact.object_type !== 'operation' || fact.object_id !== operationId || fact.data.operationId !== operationId) fail('HISTORY_FACT_INVALID');
      events.push({ id: fact.id, operationId: fact.data.operationId, outcome: fact.data.outcome, phase: fact.data.phase ?? null });
    }
    cursor = page.next_cursor;
    if (cursor !== null && seen.has(cursor)) fail('HISTORY_CURSOR_LOOP');
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null);
  return events;
}

async function createBusinessArtifact({ nc, config, sample, fetchImpl, workDeadline, timeout, onPrepared }) {
  const mimeExtension = { 'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg' }[sample.mimeType];
  const prepared = await requestJson(nc, ARTIFACT.prepare, { requestId: randomUUID(), ownerId: config.ownerId, kind: 'original',
    metadata: { title: 'Synthetic local-ai acceptance audio', filename: `synthetic-${sample.fixtureId}.${mimeExtension}`,
      extension: mimeExtension, mimeType: sample.mimeType, source: 'local-ai-business-fixture' } }, config, workDeadline);
  const artifact = prepared?.artifact;
  if (!artifact || artifact.ownerId !== config.ownerId || artifact.status !== 'pending' || !UUID.test(artifact.artifactId)) fail('ARTIFACT_PREPARE_INVALID');
  const uploadUrl = parseUploadUrl(prepared.uploadUrl, config.artifactUploadOrigin);
  const entry = { artifactId: artifact.artifactId, sample, ownerId: config.ownerId, uploadUrl: prepared.uploadUrl,
    terminalConfirmed: true, uploaded: false, deleted: false, pendingOperationIds: new Set() };
  onPrepared(entry);
  await uploadBusinessArtifact({ nc, config, entry, fetchImpl, workDeadline, timeout });
  return entry;
}

async function uploadBusinessArtifact({ nc, config, entry, fetchImpl, workDeadline, timeout }) {
  const { artifactId, sample } = entry;
  const uploadUrl = parseUploadUrl(entry.uploadUrl, config.artifactUploadOrigin);
  let uploading;
  try {
    uploading = await fetchImpl(uploadUrl, { method: 'PUT', redirect: 'manual',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(sample.bytes.byteLength) },
      body: sample.bytes, signal: AbortSignal.timeout(Math.min(timeout, remaining(workDeadline))) });
  } catch { fail('ARTIFACT_UPLOAD_FAILED'); }
  const location = uploading.headers.get('location');
  if (uploading.status !== 201 || uploading.headers.get('x-artifact-id')?.toLowerCase() !== artifactId.toLowerCase()
    || uploading.headers.get('x-artifact-state') !== 'ready' || uploading.headers.get('x-artifact-size') !== String(sample.bytes.byteLength)
    || uploading.headers.get('x-artifact-sha256') !== sample.sha256.toLowerCase() || !location) fail('ARTIFACT_UPLOAD_REPLY_INVALID');
  parseFileUrl(location, config.artifactFilesOrigin);
  if (await uploading.arrayBuffer().then(bytes => bytes.byteLength) !== 0) fail('ARTIFACT_UPLOAD_BODY_NOT_EMPTY');
  const ready = await requestJson(nc, ARTIFACT.get, { artifactId }, config, workDeadline);
  if (ready.status !== 'ready' || ready.ownerId !== config.ownerId || ready.sizeBytes !== sample.bytes.byteLength
    || ready.sha256 !== sample.sha256.toLowerCase() || ready.internalUrl !== location) fail('ARTIFACT_READY_INVALID');
  entry.uploaded = true;
}

async function deleteBusinessArtifact({ nc, config, entry, fetchImpl, workDeadline, timeout }) {
  if (!entry || entry.ownerId !== config.ownerId || !UUID.test(entry.artifactId)) fail('ARTIFACT_CLEANUP_NOT_OWNED');
  const deleted = await requestJson(nc, ARTIFACT.delete, { requestId: randomUUID(), artifactId: entry.artifactId }, config, workDeadline);
  if (deleted.status !== 'deleted') fail('ARTIFACT_DELETE_FAILED');
  const readback = await requestJson(nc, ARTIFACT.get, { artifactId: entry.artifactId }, config, workDeadline);
  if (readback.status !== 'deleted') fail('ARTIFACT_DELETE_READBACK_FAILED');
}

async function requestJson(nc, subject, body, config, deadline) {
  let reply;
  try { reply = await nc.request(subject, Buffer.from(JSON.stringify(body)), { timeout: Math.min(config.timeoutMs, remaining(deadline)) }); }
  catch { fail('ARTIFACT_REQUEST_FAILED'); }
  const result = decode(reply);
  if (result.error) fail(`ARTIFACT_${result.error.code}`);
  if (!isObject(result.value)) fail('ARTIFACT_RESPONSE_INVALID');
  return result.value;
}

function buildSafeSummary(config, evidence, operations, artifacts, status, cleanupDeferredIds) {
  const eventIds = [];
  for (const record of operations.values()) if (record.ledger) eventIds.push(record.ledger.acceptedEventId, record.ledger.terminalEventId);
  return {
    phase: config.phase, evidence, ownerId: config.ownerId,
    requestIds: [...operations.values()].map(record => record.request.requestId),
    operationIds: [...operations.keys()], artifactIds: [...artifacts.keys()], eventIds,
    cleanupDeferredArtifactIds: [...cleanupDeferredIds],
    outboxCounts: status ? { reserved: status.outboxCounts.reserved, pending: status.outboxCounts.pending,
      sending: status.outboxCounts.sending, permanentlyFailed: status.outboxCounts.permanentlyFailed } : null,
  };
}
