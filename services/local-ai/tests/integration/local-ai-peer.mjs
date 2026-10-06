// ABOUTME: Вызывает local-ai через публичный NATS API и артефакты только с переданными fixture inputs.
// ABOUTME: Импорт не читает окружение и не запускает сеть; отчёт содержит только безопасные статусы.
import { createHash, randomUUID } from 'node:crypto';
import { connect, ServiceErrorCodeHeader, ServiceErrorHeader } from 'nats';
import llamaProfile from '../../profiles/llama_cpp.json' with { type: 'json' };
import gigaProfile from '../../profiles/gigaam_pytorch.json' with { type: 'json' };
import { subjects, validateError, validateMetadataEvent, validateRequest, validateResponse } from '../../contracts/index.mjs';

export const LOCAL_AI_PEER_PHASES = Object.freeze([
  'baseline', 'cancel', 'deadline', 'idle', 'pre_restart', 'post_restart',
]);

const MODEL_FIELDS = ['modelId', 'revision', 'profileId'];
const ARTIFACT_UPLOAD_ORIGIN = 'http://172.31.247.1:19470/';
const ARTIFACT_FILES_ORIGIN = 'http://172.31.247.1:19474/';
const ARTIFACT_UPLOAD_HOST = new URL(ARTIFACT_UPLOAD_ORIGIN).origin;
const ARTIFACT_FILES_HOST = new URL(ARTIFACT_FILES_ORIGIN).origin;
const AUDIO_MIME_EXTENSIONS = Object.freeze({
  'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg',
});
const ERROR_STATUS = Object.freeze({
  INVALID_ARGUMENT: '400', MODEL_NOT_FOUND: '404', MODEL_NOT_INSTALLED: '409', UNSUPPORTED_OPERATION: '400',
  MODEL_IN_USE: '409', INPUT_TOO_LARGE: '413', RESULT_TOO_LARGE: '413', BUSY: '429',
  MODEL_LOAD_FAILED: '503', ENGINE_UNAVAILABLE: '503', DEADLINE_EXCEEDED: '504', CANCELLED: '409',
  ARTIFACT_NOT_AVAILABLE: '404', DEPENDENCY_UNAVAILABLE: '503', INSTALLATION_FAILED: '500',
  REVISION_CONFLICT: '409', NOT_SUPPORTED: '400', INTERNAL: '500',
});
const PUBLIC_ARTIFACT_SUBJECTS = Object.freeze({
  prepare: 'brai.artifacts.v1.prepare', get: 'brai.artifacts.v1.get', delete: 'brai.artifacts.v1.delete',
});

function invalid(field) { throw new TypeError(`LOCAL_AI_PEER_CONFIG_INVALID:${field}`); }
function object(value, field, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid(field);
  return value;
}
function nonEmpty(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) invalid(field);
  return value;
}
function positive(value, field, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) invalid(field);
  return value;
}
function uuid(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) invalid(field);
  return value;
}
function selector(value, field) {
  const result = object(value, field, MODEL_FIELDS);
  for (const key of MODEL_FIELDS) nonEmpty(result[key], `${field}.${key}`);
  if (!/^[0-9a-f]{40}$/i.test(result.revision)) invalid(`${field}.revision`);
  return result;
}
function httpOrigin(value, expected, field) {
  let parsed;
  try { parsed = new URL(value); } catch { invalid(field); }
  if (parsed.href !== expected || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) invalid(field);
  return parsed.origin;
}

/** Валидирует закрытый input; все временные и профильные границы задаёт fixture owner. */
export function validatePeerConfig(input) {
  const config = object(input, 'root', [
    'verifiedIsolated', 'phase', 'servers', 'inboxPrefix', 'user', 'password', 'token', 'name',
    'timeoutMs', 'maxRequestMs', 'overallTimeoutMs', 'cleanupTimeoutMs', 'outboxPollMs', 'outboxDrainTimeoutMs',
    'acceptancePollMs', 'acceptanceTimeoutMs',
    'embeddingComparisonTolerance', 'artifactUploadOrigin', 'artifactFilesOrigin',
    'ownerId', 'foreignOwnerId', 'embeddingModel', 'transcriptionModel', 'embeddingTexts', 'purpose', 'searchQuery',
    'shortTranscript', 'longTranscript', 'maxAudioBytes', 'cancelAfterMs', 'deadlineAfterMs',
    'idleUnloadSeconds', 'idleDisabledObservationMs', 'idlePollMs', 'idleTimeoutMs', 'restartVerified', 'checkpoint',
  ]);
  if (config.verifiedIsolated !== true) invalid('verifiedIsolated');
  if (!LOCAL_AI_PEER_PHASES.includes(config.phase)) invalid('phase');
  if (!Array.isArray(config.servers) || config.servers.length !== 1 || config.servers[0] !== 'nats://127.0.0.1:19473') invalid('servers');
  if (config.inboxPrefix !== '_INBOX.brai_fixture') invalid('inboxPrefix');
  if (config.user !== 'fixture' || typeof config.password !== 'string' || !config.password || config.token !== null) invalid('authentication');
  nonEmpty(config.name, 'name');
  positive(config.timeoutMs, 'timeoutMs', 2_147_483_647);
  positive(config.maxRequestMs, 'maxRequestMs', 2_147_483_647);
  positive(config.overallTimeoutMs, 'overallTimeoutMs', 2_147_483_647);
  positive(config.cleanupTimeoutMs, 'cleanupTimeoutMs', 2_147_483_647);
  positive(config.outboxPollMs, 'outboxPollMs', 2_147_483_647);
  positive(config.outboxDrainTimeoutMs, 'outboxDrainTimeoutMs', 2_147_483_647);
  positive(config.acceptancePollMs, 'acceptancePollMs', 2_147_483_647);
  positive(config.acceptanceTimeoutMs, 'acceptanceTimeoutMs', 2_147_483_647);
  if (!Number.isFinite(config.embeddingComparisonTolerance) || config.embeddingComparisonTolerance <= 0) invalid('embeddingComparisonTolerance');
  if (config.cleanupTimeoutMs > config.overallTimeoutMs) invalid('cleanupTimeoutMs');
  if (config.timeoutMs <= config.maxRequestMs || config.overallTimeoutMs <= config.maxRequestMs + config.cleanupTimeoutMs) invalid('overallTimeoutMs');
  httpOrigin(config.artifactUploadOrigin, ARTIFACT_UPLOAD_ORIGIN, 'artifactUploadOrigin');
  httpOrigin(config.artifactFilesOrigin, ARTIFACT_FILES_ORIGIN, 'artifactFilesOrigin');
  uuid(config.ownerId, 'ownerId');
  uuid(config.foreignOwnerId, 'foreignOwnerId');
  if (config.ownerId === config.foreignOwnerId) invalid('foreignOwnerId');
  config.embeddingModel = selector(config.embeddingModel, 'embeddingModel');
  config.transcriptionModel = selector(config.transcriptionModel, 'transcriptionModel');
  const fixedSelectors = [
    [config.embeddingModel, { modelId: llamaProfile.modelId, revision: llamaProfile.source.revision, profileId: llamaProfile.profileId }],
    [config.transcriptionModel, { modelId: gigaProfile.modelId, revision: gigaProfile.source.revision, profileId: gigaProfile.profileId }],
  ];
  if (fixedSelectors.some(([actual, expected]) => MODEL_FIELDS.some(key => actual[key] !== expected[key]))) invalid('modelSelectors');
  if (!Array.isArray(config.embeddingTexts) || config.embeddingTexts.length < 2
    || config.embeddingTexts.some(value => typeof value !== 'string' || !value.length)
    || new Set(config.embeddingTexts).size !== config.embeddingTexts.length) invalid('embeddingTexts');
  if (!['query', 'document', 'symmetric'].includes(config.purpose)) invalid('purpose');
  nonEmpty(config.searchQuery, 'searchQuery');
  nonEmpty(config.shortTranscript, 'shortTranscript');
  nonEmpty(config.longTranscript, 'longTranscript');
  positive(config.maxAudioBytes, 'maxAudioBytes');
  for (const key of ['cancelAfterMs', 'deadlineAfterMs', 'idleUnloadSeconds', 'idleDisabledObservationMs', 'idlePollMs', 'idleTimeoutMs']) {
    if (config[key] !== null) positive(config[key], key, 2_147_483_647);
  }
  if (config.phase === 'cancel') {
    if (config.cancelAfterMs === null || config.deadlineAfterMs === null
      || config.cancelAfterMs >= config.deadlineAfterMs || config.deadlineAfterMs > config.maxRequestMs) invalid('cancelAfterMs');
  }
  if (config.phase === 'deadline'
    && (config.deadlineAfterMs === null || config.deadlineAfterMs > config.maxRequestMs)) invalid('deadlineAfterMs');
  if (config.phase === 'idle'
    && (config.idleUnloadSeconds === null || config.idleDisabledObservationMs === null || config.idlePollMs === null || config.idleTimeoutMs === null)) invalid('idleTimeoutMs');
  if (config.phase === 'idle' && (!Number.isSafeInteger(config.idleUnloadSeconds * 1000)
    || config.idleTimeoutMs < config.idleUnloadSeconds * 1000 + config.idleDisabledObservationMs)) invalid('idleTimeoutMs');
  if (['pre_restart', 'post_restart'].includes(config.phase) && config.restartVerified !== true) invalid('restartVerified');
  if (!['pre_restart', 'post_restart'].includes(config.phase) && config.restartVerified !== false) invalid('restartVerified');
  if (config.phase === 'post_restart') {
    const checkpoint = object(config.checkpoint, 'checkpoint', ['runId', 'ownerId', 'requestIds', 'operationIds', 'artifactIds', 'eventIds']);
    uuid(checkpoint.runId, 'checkpoint.runId');
    if (checkpoint.ownerId !== config.ownerId) invalid('checkpoint.ownerId');
    for (const key of ['requestIds', 'operationIds', 'artifactIds', 'eventIds']) {
      if (!Array.isArray(checkpoint[key])) invalid(`checkpoint.${key}`);
      checkpoint[key].forEach((item, index) => uuid(item, `checkpoint.${key}.${index}`));
    }
  } else if (config.checkpoint !== null) invalid('checkpoint');
  return config;
}

export function validatePeerMedia(media, config) {
  const input = object(media, 'media', ['short', 'long']);
  const result = {};
  for (const name of ['short', 'long']) {
    const audio = object(input[name], `media.${name}`, ['bytes', 'mimeType']);
    if (!(audio.bytes instanceof Uint8Array) || audio.bytes.byteLength < 1 || audio.bytes.byteLength > config.maxAudioBytes) invalid(`media.${name}.bytes`);
    if (!Object.hasOwn(AUDIO_MIME_EXTENSIONS, audio.mimeType)) invalid(`media.${name}.mimeType`);
    result[name] = { bytes: audio.bytes, mimeType: audio.mimeType };
  }
  return result;
}

export function buildLocalAiAcceptancePlan() {
  return Object.freeze([
    Object.freeze({ phase: 'baseline', requiredEvidence: ['catalog', 'configure-null', 'embedding', 'short-asr', 'long-asr', 'artifact-error-parity', 'empty-outbox'] }),
    Object.freeze({ phase: 'cancel', requiredEvidence: ['history-accepted-observed', 'cancel-response', 'invoke-cancelled', 'runtime-exit-before-artifact-cleanup'] }),
    Object.freeze({ phase: 'deadline', requiredEvidence: ['deadline-response', 'runtime-exit-before-artifact-cleanup'] }),
    Object.freeze({ phase: 'idle', requiredEvidence: ['configure-null', 'configure-idle', 'idle-unload', 'empty-outbox'] }),
    Object.freeze({ phase: 'pre_restart', requiredEvidence: ['ready-and-unloaded', 'empty-outbox', 'checkpoint-event-ids', 'external-own-container-restart-pending'] }),
    Object.freeze({ phase: 'post_restart', requiredEvidence: ['cold-ready-without-autoload', 'recovery-metadata-pending-external', 'empty-outbox', 'external-no-content-audit-pending'] }),
  ]);
}

function safeFailure(code) { throw new Error(`LOCAL_AI_PEER_${code}`); }
function remaining(deadline) { return Math.max(0, deadline - Date.now()); }
function assertTime(deadline) { if (remaining(deadline) < 1) safeFailure('OVERALL_TIMEOUT'); }
function decodeMessage(message) {
  const hasCode = message.headers?.has(ServiceErrorHeader) ?? false;
  const hasStatus = message.headers?.has(ServiceErrorCodeHeader) ?? false;
  if (hasCode !== hasStatus) safeFailure('MALFORMED_ERROR_HEADERS');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message.data)); }
  catch { safeFailure('INVALID_REPLY'); }
  if (!hasCode) return { value, error: null };
  const code = message.headers.get(ServiceErrorHeader);
  const status = message.headers.get(ServiceErrorCodeHeader);
  if (!validateError(value) || value.code !== code || ERROR_STATUS[code] !== status) safeFailure('MALFORMED_ERROR_BODY');
  return { value: null, error: { code, status, message: value.message, retryable: value.retryable } };
}

function checkError(actual, expected) {
  if (!actual.error || actual.error.code !== expected || actual.error.status !== ERROR_STATUS[expected]) safeFailure('EXPECTED_ERROR_MISSING');
  return actual.error;
}

async function bounded(promise, deadline) {
  const left = remaining(deadline);
  if (left < 1) safeFailure('OVERALL_TIMEOUT');
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('LOCAL_AI_PEER_OVERALL_TIMEOUT')), left); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function assertSelector(actual, expected) {
  if (!actual || MODEL_FIELDS.some(key => actual[key] !== expected[key])) safeFailure('MODEL_MISMATCH');
}

export function assertArtifactErrorParity(errors) {
  const keys = ['wrong-owner', 'missing', 'pending', 'deleted'];
  if (!Array.isArray(errors) || errors.length !== keys.length) safeFailure('ARTIFACT_ERROR_PARITY');
  const normalized = errors.map((entry, index) => {
    if (entry.name !== keys[index] || entry.code !== 'ARTIFACT_NOT_AVAILABLE' || entry.status !== '404'
      || typeof entry.message !== 'string' || typeof entry.retryable !== 'boolean') safeFailure('ARTIFACT_ERROR_PARITY');
    return JSON.stringify({ code: entry.code, status: entry.status, message: entry.message, retryable: entry.retryable });
  });
  if (!normalized.every(value => value === normalized[0])) safeFailure('ARTIFACT_ERROR_PARITY');
  return true;
}

export function assertEmbeddingResponse(result, request, dimension) {
  if (!Number.isSafeInteger(dimension) || dimension < 1
    || result.requestId !== request.requestId || result.operationId !== request.operationId) safeFailure('EMBED_IDENTITY');
  assertSelector(result.model, request.model);
  if (!Array.isArray(result.vectors) || result.vectors.length !== request.texts.length) safeFailure('EMBED_COUNT');
  for (const vector of result.vectors) {
    if (!Array.isArray(vector) || vector.length !== dimension || vector.some(value => !Number.isFinite(value))) safeFailure('EMBED_VECTOR');
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (Math.abs(norm - 1) > 1e-4) safeFailure('EMBED_NORM');
  }
  return true;
}

export function assertEmbeddingOrder(batch, singles, tolerance) {
  if (!Array.isArray(batch) || !Array.isArray(singles) || batch.length !== singles.length
    || !Number.isFinite(tolerance) || tolerance <= 0) safeFailure('EMBED_ORDER');
  for (let left = 0; left < singles.length; left++) {
    for (let right = left + 1; right < singles.length; right++) {
      if (!Array.isArray(singles[left]) || !Array.isArray(singles[right]) || singles[left].length !== singles[right].length) safeFailure('EMBED_ORDER');
      const distance = Math.sqrt(singles[left].reduce((sum, value, index) => {
        const other = singles[right][index];
        if (!Number.isFinite(value) || !Number.isFinite(other)) safeFailure('EMBED_ORDER');
        return sum + (value - other) ** 2;
      }, 0));
      if (distance <= 2 * tolerance) safeFailure('EMBED_ORDER_UNDISTINGUISHABLE');
    }
  }
  for (let index = 0; index < batch.length; index++) {
    if (!Array.isArray(batch[index]) || !Array.isArray(singles[index]) || batch[index].length !== singles[index].length
      || batch[index].some((value, offset) => !Number.isFinite(value) || !Number.isFinite(singles[index][offset])
        || Math.abs(value - singles[index][offset]) > tolerance)) safeFailure('EMBED_ORDER');
  }
  return true;
}

export function assertTranscriptionResponse(result, request, expectedText) {
  if (result.requestId !== request.requestId || result.operationId !== request.operationId) safeFailure('TRANSCRIBE_IDENTITY');
  assertSelector(result.model, request.model);
  if (typeof result.text !== 'string' || !result.text.trim() || !result.text.includes(expectedText)) safeFailure('TRANSCRIPTION_TEXT');
  if (result.segments !== null && (!Array.isArray(result.segments) || result.segments.some(segment =>
    !Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds)
    || segment.startSeconds < 0 || segment.endSeconds < segment.startSeconds || typeof segment.text !== 'string'))) safeFailure('TRANSCRIPTION_SEGMENTS');
  return true;
}

function validateHealth(value) {
  if (value.state !== 'ready' || Object.values(value.components).some(component => component.state !== 'ready')) safeFailure('NOT_READY');
  const outbox = value.outboxCounts;
  if (outbox.reserved !== 0 || outbox.pending !== 0 || outbox.sending !== 0 || outbox.permanentlyFailed !== 0) safeFailure('OUTBOX_NOT_EMPTY');
  return true;
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function parseUploadUrl(value, uploadOrigin) {
  let parsed;
  try { parsed = new URL(value); } catch { safeFailure('UPLOAD_URL_REJECTED'); }
  if (uploadOrigin !== ARTIFACT_UPLOAD_ORIGIN || parsed.origin !== ARTIFACT_UPLOAD_HOST || parsed.protocol !== 'http:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || value.includes('%') || value.includes('\\')
    || !/^\/upload\/[A-Za-z0-9._~-]+$/.test(parsed.pathname)) safeFailure('UPLOAD_URL_REJECTED');
  return parsed;
}
export function parseFileUrl(value, filesOrigin) {
  let parsed;
  try { parsed = new URL(value); } catch { safeFailure('FILE_URL_REJECTED'); }
  if (filesOrigin !== ARTIFACT_FILES_ORIGIN || parsed.origin !== ARTIFACT_FILES_HOST || parsed.protocol !== 'http:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || value.includes('%') || value.includes('\\')
    || !/^\/files\/[A-Za-z0-9._~-]+$/.test(parsed.pathname)) safeFailure('FILE_URL_REJECTED');
  return parsed;
}

/** Запускает ровно один явно выбранный acceptance phase; сеть открывается только после прямого вызова. */
export async function runLocalAiPeer(input, mediaInput, dependencies = {}) {
  const config = validatePeerConfig(input);
  const media = ['baseline', 'cancel', 'deadline'].includes(config.phase) ? validatePeerMedia(mediaInput, config) : null;
  const connectNats = dependencies.connect ?? connect;
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const deadline = Date.now() + config.overallTimeoutMs;
  const workDeadline = deadline - config.cleanupTimeoutMs;
  const ownedArtifacts = new Map();
  const evidence = [];
  const requestIds = [];
  const operationIds = [];
  const eventIds = [];
  const runId = config.checkpoint?.runId ?? randomUUID();
  let nc;
  let runtimeSafeForArtifactCleanup = true;

  const timeout = () => {
    assertTime(workDeadline);
    return Math.max(1, Math.min(config.timeoutMs, remaining(workDeadline)));
  };
  const connectOptions = {
    servers: config.servers, name: config.name, inboxPrefix: config.inboxPrefix,
    user: config.user, pass: config.password, maxReconnectAttempts: 0, timeout: timeout(),
  };
  try {
    nc = await connectNats(connectOptions);
    const call = async (subject, value, expectedError = null, requestTimeout = timeout()) => {
      assertTime(workDeadline);
      if (!validateRequest(subject, value)) safeFailure('INVALID_REQUEST');
      if (typeof value.requestId === 'string') requestIds.push(value.requestId);
      if (typeof value.operationId === 'string') operationIds.push(value.operationId);
      let reply;
      try { reply = await nc.request(subject, Buffer.from(JSON.stringify(value)), { timeout: Math.min(requestTimeout, timeout()) }); }
      catch { safeFailure('REQUEST_FAILED'); }
      const decoded = decodeMessage(reply);
      if (expectedError) { checkError(decoded, expectedError); return decoded; }
      if (decoded.error) safeFailure(`SERVICE_ERROR:${decoded.error.code}`);
      if (!validateResponse(subject, decoded.value)) safeFailure('INVALID_RESPONSE');
      return decoded;
    };
    const artifactCall = async (subject, value, expectedError = null) => {
      if (typeof value.requestId === 'string') requestIds.push(value.requestId);
      let reply;
      try { reply = await nc.request(subject, Buffer.from(JSON.stringify(value)), { timeout: timeout() }); }
      catch { safeFailure('ARTIFACT_REQUEST_FAILED'); }
      const decoded = decodeMessage(reply);
      if (expectedError) { checkError(decoded, expectedError); return decoded; }
      if (decoded.error || !decoded.value || typeof decoded.value !== 'object') safeFailure('ARTIFACT_RESPONSE_INVALID');
      return decoded.value;
    };
    const newRequest = (selectorValue, operation) => ({
      requestId: randomUUID(), operationId: randomUUID(), model: selectorValue, ownerId: config.ownerId,
      deadlineAt: new Date(Date.now() + config.maxRequestMs).toISOString(), ...operation,
    });
    const invokeTranscript = (artifactId, ownerId, operationId = randomUUID(), expiresAt = Date.now() + config.maxRequestMs) => {
      const request = {
        requestId: randomUUID(), operationId, model: config.transcriptionModel, ownerId,
        deadlineAt: new Date(expiresAt).toISOString(), audioArtifactId: artifactId,
      };
      const promise = call(subjects.invokeTranscribe, request);
      const settled = promise.then(value => ({ value }), error => ({ error }));
      return { request, promise, settled };
    };
    const getCards = async () => {
      const listed = (await call(subjects.modelsList, { filter: { installed: true }, page: { limit: 100 } })).value;
      if (!Array.isArray(listed.items)) safeFailure('CATALOG_INVALID');
      for (const expected of [config.embeddingModel, config.transcriptionModel]) {
        const card = listed.items.find(item => MODEL_FIELDS.every(key => item[key] === expected[key]));
        if (!card || card.installationState !== 'installed' || !card.supported) safeFailure('MODEL_NOT_INSTALLED');
      }
      const embeddingCard = (await call(subjects.modelsGet, { modelId: config.embeddingModel.modelId })).value;
      assertSelector(embeddingCard, config.embeddingModel);
      const transcriptionCard = (await call(subjects.modelsGet, { modelId: config.transcriptionModel.modelId })).value;
      assertSelector(transcriptionCard, config.transcriptionModel);
      if (embeddingCard.limits.vectorDimensions !== llamaProfile.encoding.dimensions) safeFailure('MODEL_DIMENSION_MISMATCH');
      return { items: listed.items, dimension: llamaProfile.encoding.dimensions };
    };
    const status = async () => {
      const drainDeadline = Math.min(workDeadline, Date.now() + config.outboxDrainTimeoutMs);
      let health;
      while (remaining(drainDeadline) > 0) {
        health = (await call(subjects.status, { ownerId: config.ownerId })).value;
        const counts = health.outboxCounts;
        if (!counts || ['reserved', 'pending', 'sending', 'permanentlyFailed'].some(key => !Number.isSafeInteger(counts[key]) || counts[key] < 0)) safeFailure('OUTBOX_STATUS_INVALID');
        if (counts.permanentlyFailed > 0) safeFailure('OUTBOX_PERMANENT_FAILURE');
        if (counts.reserved === 0 && counts.pending === 0 && counts.sending === 0) {
          validateHealth(health);
          return health;
        }
        await bounded(new Promise(resolve => setTimeout(resolve, Math.min(config.outboxPollMs, remaining(drainDeadline)))), drainDeadline);
      }
      safeFailure('OUTBOX_DRAIN_TIMEOUT');
    };
    const historyEvents = async (operationId, requestDeadline = workDeadline) => {
      const events = [];
      let cursor = null;
      const seenCursors = new Set();
      do {
        const body = {
          user_id: config.ownerId,
          filters: { source: 'local_ai', object_type: 'operation', object_id: operationId },
          limit: 100, cursor,
        };
        let reply;
        try {
          reply = await nc.request('brai.history.v1.query.list', Buffer.from(JSON.stringify(body)), { timeout: Math.min(timeout(), remaining(requestDeadline)) });
        } catch { safeFailure('HISTORY_QUERY_FAILED'); }
        const hasCode = reply.headers?.has(ServiceErrorHeader) ?? false;
        const hasStatus = reply.headers?.has(ServiceErrorCodeHeader) ?? false;
        if (hasCode !== hasStatus || hasCode) safeFailure('HISTORY_QUERY_FAILED');
        let page;
        try { page = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.data)); }
        catch { safeFailure('HISTORY_REPLY_INVALID'); }
        if (!Array.isArray(page.items) || !(page.next_cursor === null || typeof page.next_cursor === 'string')) safeFailure('HISTORY_REPLY_INVALID');
        for (const event of page.items) {
          const { source, recorded_at: _recordedAt, ...fact } = event;
          if (source !== 'local_ai' || !validateMetadataEvent(fact)
            || fact.scope_type !== 'user' || fact.scope_id !== config.ownerId
            || fact.object_type !== 'operation' || fact.object_id !== operationId
            || fact.data.operationId !== operationId) safeFailure('HISTORY_METADATA_INVALID');
          events.push({ id: fact.id, outcome: fact.data.outcome, phase: fact.data.phase ?? null });
        }
        cursor = page.next_cursor;
        if (cursor !== null && seenCursors.has(cursor)) safeFailure('HISTORY_CURSOR_LOOP');
        if (cursor !== null) seenCursors.add(cursor);
      } while (cursor !== null);
      return events;
    };
    const waitForAccepted = async (operationId, cutoff = workDeadline) => {
      const end = Math.min(workDeadline, Date.now() + config.acceptanceTimeoutMs, cutoff);
      while (remaining(end) > 0) {
        const events = await historyEvents(operationId, end);
        const accepted = events.filter(event => event.outcome === 'accepted' && event.phase === 'accepted');
        if (accepted.length > 1) safeFailure('DUPLICATE_ACCEPTED_EVENT');
        if (accepted.length === 1) {
          if (events.some(event => event.outcome !== 'accepted')) safeFailure('OPERATION_FINISHED_BEFORE_CONTROL');
          return accepted[0].id;
        }
        await bounded(new Promise(resolve => setTimeout(resolve, Math.min(config.acceptancePollMs, remaining(end)))), end);
      }
      safeFailure('ACCEPTANCE_EVENT_NOT_OBSERVED');
    };
    const configure = async (selectorValue, idleUnloadSeconds) => {
      const request = {
        modelId: selectorValue.modelId, revision: selectorValue.revision,
        profileId: selectorValue.profileId, ownerId: config.ownerId, idleUnloadSeconds,
      };
      const value = (await call(subjects.modelsConfigure, request)).value;
      if (value.idleUnloadSeconds !== idleUnloadSeconds) safeFailure('CONFIGURE_MISMATCH');
      assertSelector(value, selectorValue);
      return value;
    };
    const embed = async dimension => {
      const request = newRequest(config.embeddingModel, { texts: config.embeddingTexts, purpose: config.purpose });
      const result = (await call(subjects.invokeEmbed, request)).value;
      assertEmbeddingResponse(result, request, dimension);
      const singles = [];
      for (const text of config.embeddingTexts) {
        const singleRequest = newRequest(config.embeddingModel, { texts: [text], purpose: config.purpose });
        const singleResult = (await call(subjects.invokeEmbed, singleRequest)).value;
        assertEmbeddingResponse(singleResult, singleRequest, dimension);
        singles.push(singleResult.vectors[0]);
      }
      assertEmbeddingOrder(result.vectors, singles, config.embeddingComparisonTolerance);
      return result;
    };
    const prepareAudio = async (name, ownerId = config.ownerId) => {
      const audio = media[name];
      const extension = AUDIO_MIME_EXTENSIONS[audio.mimeType];
      const prepared = await artifactCall(PUBLIC_ARTIFACT_SUBJECTS.prepare, {
        requestId: randomUUID(), ownerId, kind: 'original',
        metadata: {
          title: `Synthetic local-ai ${name} speech`, filename: `synthetic-${name}.${extension}`,
          extension, mimeType: audio.mimeType, source: 'local-ai-acceptance-fixture',
        },
      });
      const artifact = prepared.artifact;
      if (artifact && typeof artifact.artifactId === 'string'
        && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(artifact.artifactId)
        && typeof prepared.uploadUrl === 'string') {
        if (artifact.ownerId === ownerId && artifact.status === 'pending') {
          parseUploadUrl(prepared.uploadUrl, config.artifactUploadOrigin);
          ownedArtifacts.set(artifact.artifactId, { ownerId, bytes: audio.bytes, mimeType: audio.mimeType, uploadUrl: prepared.uploadUrl, uploaded: false, deleted: false });
        }
      }
      if (!artifact || artifact.ownerId !== ownerId || artifact.status !== 'pending'
        || !ownedArtifacts.has(artifact.artifactId) || typeof prepared.uploadUrl !== 'string') safeFailure('ARTIFACT_PREPARE_INVALID');
      parseUploadUrl(prepared.uploadUrl, config.artifactUploadOrigin);
      return artifact.artifactId;
    };
    const uploadAudio = async artifactId => {
      const entry = ownedArtifacts.get(artifactId);
      if (!entry) safeFailure('ARTIFACT_NOT_OWNED');
      let response;
      try {
        response = await fetchImpl(parseUploadUrl(entry.uploadUrl, config.artifactUploadOrigin), {
          method: 'PUT', redirect: 'manual',
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(entry.bytes.byteLength) },
          body: entry.bytes, signal: AbortSignal.timeout(timeout()),
        });
      } catch { safeFailure('UPLOAD_FAILED'); }
      const expectedHash = sha256(entry.bytes);
      const location = response.headers.get('location');
      if (response.status !== 201 || response.headers.get('x-artifact-id')?.toLowerCase() !== artifactId.toLowerCase()
        || response.headers.get('x-artifact-state') !== 'ready'
        || response.headers.get('x-artifact-size') !== String(entry.bytes.byteLength)
        || response.headers.get('x-artifact-sha256') !== expectedHash || !location) safeFailure('UPLOAD_REPLY_INVALID');
      parseFileUrl(location, config.artifactFilesOrigin);
      if (await response.arrayBuffer().then(bytes => bytes.byteLength) !== 0) safeFailure('UPLOAD_BODY_NOT_EMPTY');
      const ready = await artifactCall(PUBLIC_ARTIFACT_SUBJECTS.get, { artifactId });
      if (ready.status !== 'ready' || ready.ownerId !== entry.ownerId
        || ready.sizeBytes !== entry.bytes.byteLength || ready.sha256 !== expectedHash || ready.internalUrl !== location) safeFailure('ARTIFACT_READY_INVALID');
      entry.uploaded = true;
      return artifactId;
    };
    const deleteArtifact = async artifactId => {
      const entry = ownedArtifacts.get(artifactId);
      if (!entry) safeFailure('ARTIFACT_NOT_OWNED');
      if (!entry.uploaded) await uploadAudio(artifactId);
      const deleted = await artifactCall(PUBLIC_ARTIFACT_SUBJECTS.delete, { requestId: randomUUID(), artifactId });
      if (deleted.status !== 'deleted') safeFailure('ARTIFACT_DELETE_FAILED');
      const readback = await artifactCall(PUBLIC_ARTIFACT_SUBJECTS.get, { artifactId });
      if (readback.status !== 'deleted') safeFailure('ARTIFACT_DELETE_READBACK_FAILED');
      entry.uploaded = false;
      entry.deleted = true;
    };
    const transcribe = async (artifactId, expectedText) => {
      runtimeSafeForArtifactCleanup = false;
      const { request, settled } = invokeTranscript(artifactId, config.ownerId);
      const completion = await settled;
      if (completion.error) throw completion.error;
      runtimeSafeForArtifactCleanup = true;
      const response = completion.value.value;
      assertTranscriptionResponse(response, request, expectedText);
      return response;
    };
    const assertArtifactError = async (artifactId, ownerId) => {
      const request = {
        requestId: randomUUID(), operationId: randomUUID(), model: config.transcriptionModel,
        ownerId, deadlineAt: new Date(Date.now() + config.maxRequestMs).toISOString(), audioArtifactId: artifactId,
      };
      const response = await call(subjects.invokeTranscribe, request, 'ARTIFACT_NOT_AVAILABLE');
      return response.error;
    };

    if (config.phase === 'baseline') {
      const catalog = await getCards();
      const search = (await call(subjects.catalogSearch, { query: config.searchQuery, filter: { operation: 'transcribe' }, page: { limit: 10 } })).value;
      if (!Array.isArray(search.items) || !search.items.some(item => MODEL_FIELDS.every(key => item[key] === config.transcriptionModel[key]))) safeFailure('CATALOG_SEARCH_MISSING_PROFILE');
      await configure(config.embeddingModel, null);
      await embed(catalog.dimension);
      const shortId = await prepareAudio('short');
      const longId = await prepareAudio('long');
      const pendingId = await prepareAudio('short');
      await uploadAudio(shortId);
      await uploadAudio(longId);
      await transcribe(shortId, config.shortTranscript);
      await transcribe(longId, config.longTranscript);
      const missingId = randomUUID();
      const invalidArtifactErrors = [
        { name: 'wrong-owner', ...(await assertArtifactError(shortId, config.foreignOwnerId)) },
        { name: 'missing', ...(await assertArtifactError(missingId, config.ownerId)) },
        { name: 'pending', ...(await assertArtifactError(pendingId, config.ownerId)) },
      ];
      await deleteArtifact(longId);
      invalidArtifactErrors.push({ name: 'deleted', ...(await assertArtifactError(longId, config.ownerId)) });
      assertArtifactErrorParity(invalidArtifactErrors);
      evidence.push('catalog', 'configure-null', 'embedding', 'short-asr', 'long-asr', 'artifact-error-parity');
    } else if (config.phase === 'cancel' || config.phase === 'deadline') {
      const catalog = await getCards();
      const longId = await prepareAudio('long');
      await uploadAudio(longId);
      const expireAfter = config.deadlineAfterMs;
      const operationId = randomUUID();
      const startedAt = Date.now();
      const operationLimit = config.phase === 'cancel' ? config.cancelAfterMs : config.deadlineAfterMs;
      const cancelAt = startedAt + operationLimit;
      const { settled } = invokeTranscript(longId, config.ownerId, operationId, startedAt + expireAfter);
      runtimeSafeForArtifactCleanup = false;
      const acceptedEventId = await waitForAccepted(operationId, cancelAt);
      eventIds.push(acceptedEventId);
      if (config.phase === 'cancel') {
        await bounded(new Promise(resolve => setTimeout(resolve, remaining(cancelAt))), cancelAt);
        const cancelled = (await call(subjects.cancel, { requestId: randomUUID(), operationId, ownerId: config.ownerId })).value;
        if (cancelled.operationId !== operationId || cancelled.status !== 'cancellation_requested') safeFailure('CANCEL_NOT_ACCEPTED');
        const completion = await bounded(settled, workDeadline);
        if (!completion.error || completion.error.message !== 'LOCAL_AI_PEER_SERVICE_ERROR:CANCELLED') safeFailure('CANCELLED_INVOKE_RETURNED_SUCCESS');
        evidence.push('cancel-response', 'invoke-cancelled');
      } else {
        const completion = await bounded(settled, workDeadline);
        if (!completion.error || completion.error.message !== 'LOCAL_AI_PEER_SERVICE_ERROR:DEADLINE_EXCEEDED') safeFailure('DEADLINE_INVOKE_RETURNED_SUCCESS');
        evidence.push('deadline-response');
      }
      const unload = {
        modelId: config.transcriptionModel.modelId, revision: config.transcriptionModel.revision,
        profileId: config.transcriptionModel.profileId, ownerId: config.ownerId,
        deadlineAt: new Date(Date.now() + config.maxRequestMs).toISOString(),
      };
      await call(subjects.modelsUnload, unload);
      runtimeSafeForArtifactCleanup = true;
      evidence.push('runtime-exit-before-artifact-cleanup');
    } else if (config.phase === 'idle') {
      const catalog = await getCards();
      await configure(config.embeddingModel, null);
      const selectorRequest = {
        modelId: config.embeddingModel.modelId, revision: config.embeddingModel.revision,
        profileId: config.embeddingModel.profileId, ownerId: config.ownerId,
        deadlineAt: new Date(Date.now() + config.maxRequestMs).toISOString(),
      };
      await call(subjects.modelsLoad, selectorRequest);
      const request = newRequest(config.embeddingModel, { texts: config.embeddingTexts, purpose: config.purpose });
      const embedded = (await call(subjects.invokeEmbed, request)).value;
      assertEmbeddingResponse(embedded, request, catalog.dimension);
      await bounded(new Promise(resolve => setTimeout(resolve, config.idleDisabledObservationMs)), workDeadline);
      let disabledCard = (await call(subjects.modelsGet, { modelId: config.embeddingModel.modelId })).value;
      if (disabledCard.runtimeState !== 'ready') safeFailure('NULL_IDLE_TIMER_UNEXPECTED_UNLOAD');
      await configure(config.embeddingModel, config.idleUnloadSeconds);
      const zeroIdle = {
        modelId: config.embeddingModel.modelId, revision: config.embeddingModel.revision,
        profileId: config.embeddingModel.profileId, ownerId: config.ownerId, idleUnloadSeconds: 0,
      };
      if (validateRequest(subjects.modelsConfigure, zeroIdle)) safeFailure('ZERO_IDLE_SCHEMA_ACCEPTED');
      let zeroReply;
      try { zeroReply = await nc.request(subjects.modelsConfigure, Buffer.from(JSON.stringify(zeroIdle)), { timeout: timeout() }); }
      catch { safeFailure('ZERO_IDLE_REQUEST_FAILED'); }
      checkError(decodeMessage(zeroReply), 'INVALID_ARGUMENT');
      const end = Math.min(workDeadline, Date.now() + config.idleTimeoutMs);
      let card;
      do {
        assertTime(end);
        card = (await call(subjects.modelsGet, { modelId: config.embeddingModel.modelId })).value;
        if (card.runtimeState === 'unloaded') break;
        await bounded(new Promise(resolve => setTimeout(resolve, Math.min(config.idlePollMs, remaining(end)))), end);
      } while (remaining(end) > 0);
      if (card?.runtimeState !== 'unloaded') safeFailure('IDLE_UNLOAD_NOT_OBSERVED');
      evidence.push('configure-null-remained-loaded', 'configure-idle', 'idle-unload', 'zero-idle-rejected');
    } else if (config.phase === 'pre_restart') {
      const cards = await getCards();
      await embed(cards.dimension);
      for (const selectorValue of [config.embeddingModel, config.transcriptionModel]) {
        await call(subjects.modelsUnload, {
          modelId: selectorValue.modelId, revision: selectorValue.revision, profileId: selectorValue.profileId,
          ownerId: config.ownerId, deadlineAt: new Date(Date.now() + config.maxRequestMs).toISOString(),
        });
      }
      evidence.push('pre-restart-ready', 'pre-restart-models-unloaded');
    } else if (config.phase === 'post_restart') {
      const cards = await getCards();
      const current = (await call(subjects.modelsList, { filter: { installed: true }, page: { limit: 100 } })).value;
      for (const selectorValue of [config.embeddingModel, config.transcriptionModel]) {
        const card = current.items.find(item => MODEL_FIELDS.every(key => item[key] === selectorValue[key]));
        if (!card || card.runtimeState !== 'unloaded') safeFailure('COLD_RESTART_AUTOLOAD');
      }
      await embed(cards.dimension);
      evidence.push('cold-ready-without-autoload', 'post-restart-operation-complete');
    }
    const health = await status();
    if (config.phase === 'pre_restart') {
      for (const operationId of [...new Set(operationIds)]) {
        const events = await historyEvents(operationId);
        const accepted = events.filter(event => event.outcome === 'accepted' && event.phase === 'accepted');
        const terminal = events.filter(event => ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(event.outcome));
        if (accepted.length !== 1 || terminal.length !== 1 || events.length !== 2) safeFailure('RESTART_CHECKPOINT_HISTORY_INVALID');
        eventIds.push(...events.map(event => event.id));
      }
      if (!operationIds.length) safeFailure('RESTART_CHECKPOINT_EMPTY');
      evidence.push('checkpoint-event-ids');
    } else if (config.phase === 'post_restart') {
      const actualEventIds = [];
      for (const operationId of config.checkpoint.operationIds) {
        const events = await historyEvents(operationId);
        const accepted = events.filter(event => event.outcome === 'accepted' && event.phase === 'accepted');
        const terminal = events.filter(event => ['succeeded', 'failed', 'cancelled', 'interrupted', 'unknown'].includes(event.outcome));
        if (accepted.length !== 1 || terminal.length !== 1 || events.length !== 2) safeFailure('RESTART_HISTORY_DUPLICATED_OR_MISSING');
        actualEventIds.push(...events.map(event => event.id));
      }
      const before = [...config.checkpoint.eventIds].sort();
      const after = [...actualEventIds].sort();
      if (JSON.stringify(before) !== JSON.stringify(after)) safeFailure('RESTART_HISTORY_CHANGED');
      eventIds.push(...actualEventIds);
      evidence.push('restart-event-ids-unchanged');
    }
    evidence.push('empty-outbox');
    return {
      phase: config.phase, verified: evidence,
      runId, ownerId: config.ownerId, requestIds: [...requestIds], operationIds: [...operationIds],
      artifactIds: [...ownedArtifacts.keys()], eventIds: [...eventIds], checkpoint: {
        runId, ownerId: config.ownerId,
        requestIds: [...new Set([...(config.checkpoint?.requestIds ?? []), ...requestIds])],
        operationIds: [...new Set([...(config.checkpoint?.operationIds ?? []), ...operationIds])],
        artifactIds: [...new Set([...(config.checkpoint?.artifactIds ?? []), ...ownedArtifacts.keys()])],
        eventIds: [...new Set([...(config.checkpoint?.eventIds ?? []), ...eventIds])],
      },
      externalChecksPending: ['protected own-container restart evidence', 'interrupted-operation recovery evidence', 'protected own-service no-content log/storage audit'],
      outboxCounts: { ...health.outboxCounts },
      createdArtifactCount: ownedArtifacts.size,
    };
  } finally {
    let cleanupFailed = false;
    const cleanupDeadline = Math.min(deadline, Date.now() + config.cleanupTimeoutMs);
    if (nc) {
      if (!runtimeSafeForArtifactCleanup) cleanupFailed = true;
      for (const [artifactId, entry] of runtimeSafeForArtifactCleanup ? ownedArtifacts : []) {
        try {
          if (entry.deleted) continue;
          if (!entry.uploaded) await uploadAudioForCleanup(nc, artifactId, entry, config, fetchImpl, cleanupDeadline);
          if (remaining(cleanupDeadline) < 1) throw new Error();
          await natsArtifactCall(nc, PUBLIC_ARTIFACT_SUBJECTS.delete, { requestId: randomUUID(), artifactId }, config, cleanupDeadline);
        } catch { cleanupFailed = true; }
      }
      try { await bounded(nc.drain(), cleanupDeadline); }
      catch {
        cleanupFailed = true;
        if (typeof nc.close === 'function' && remaining(cleanupDeadline) > 0) {
          try { await bounded(nc.close(), cleanupDeadline); } catch { cleanupFailed = true; }
        }
      }
    }
    if (cleanupFailed) safeFailure('CLEANUP_FAILED');
  }
}

async function natsArtifactCall(nc, subject, body, config, deadline) {
  if (remaining(deadline) < 1) throw new Error('cleanup timeout');
  const response = await nc.request(subject, Buffer.from(JSON.stringify(body)), { timeout: Math.min(config.cleanupTimeoutMs, remaining(deadline)) });
  const decoded = decodeMessage(response);
  if (decoded.error) throw new Error('cleanup service error');
  return decoded.value;
}

async function uploadAudioForCleanup(nc, artifactId, entry, config, fetchImpl, deadline) {
  if (remaining(deadline) < 1) throw new Error('cleanup deadline');
  parseUploadUrl(entry.uploadUrl, config.artifactUploadOrigin);
  const response = await fetchImpl(entry.uploadUrl, {
    method: 'PUT', redirect: 'manual',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(entry.bytes.byteLength) },
    body: entry.bytes, signal: AbortSignal.timeout(Math.min(config.cleanupTimeoutMs, remaining(deadline))),
  });
  if (response.status !== 201 || response.headers.get('x-artifact-id')?.toLowerCase() !== artifactId.toLowerCase()
    || response.headers.get('x-artifact-state') !== 'ready' || response.headers.get('x-artifact-size') !== String(entry.bytes.byteLength)
    || response.headers.get('x-artifact-sha256') !== sha256(entry.bytes)) throw new Error('cleanup upload failed');
  entry.uploaded = true;
  const ready = await natsArtifactCall(nc, PUBLIC_ARTIFACT_SUBJECTS.get, { artifactId }, config, deadline);
  if (ready.status !== 'ready') throw new Error('cleanup artifact unavailable');
}
