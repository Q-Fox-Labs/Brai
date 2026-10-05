// ABOUTME: Вызывает local-ai через публичные NATS subjects на изолированном fixture.
// ABOUTME: Принимает только синтетические inputs и не выводит ответы, credentials или адреса.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'nats';
import { subjects, validateError, validateRequest, validateResponse } from '../../contracts/index.mjs';

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
function positive(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) invalid(field);
  return value;
}
export function validatePeerConfig(input) {
  const config = object(input, 'root', [
    'verifiedIsolated', 'servers', 'inboxPrefix', 'user', 'password', 'token', 'name', 'timeoutMs', 'ownerId',
    'embeddingModel', 'transcriptionModel', 'audioArtifactId', 'embeddingTexts', 'purpose', 'searchQuery',
  ]);
  if (config.verifiedIsolated !== true) invalid('verifiedIsolated');
  if (!Array.isArray(config.servers) || config.servers.length !== 1 || config.servers[0] !== 'nats://127.0.0.1:19473') invalid('servers');
  config.servers.forEach((value, index) => nonEmpty(value, `servers.${index}`));
  if (config.inboxPrefix !== '_INBOX.brai_fixture') invalid('inboxPrefix');
  for (const key of ['user', 'password', 'token']) if (config[key] !== null && typeof config[key] !== 'string') invalid(key);
  if (config.user !== 'fixture' || !config.password || config.token) invalid('authentication');
  nonEmpty(config.name, 'name');
  positive(config.timeoutMs, 'timeoutMs');
  nonEmpty(config.ownerId, 'ownerId');
  config.embeddingModel = object(config.embeddingModel, 'embeddingModel', ['modelId', 'revision', 'profileId']);
  config.transcriptionModel = object(config.transcriptionModel, 'transcriptionModel', ['modelId', 'revision', 'profileId']);
  for (const [name, value] of [['embeddingModel', config.embeddingModel], ['transcriptionModel', config.transcriptionModel]]) {
    for (const [key, item] of Object.entries(value)) nonEmpty(item, `${name}.${key}`);
  }
  nonEmpty(config.audioArtifactId, 'audioArtifactId');
  if (!Array.isArray(config.embeddingTexts) || config.embeddingTexts.length === 0 || config.embeddingTexts.some(value => typeof value !== 'string' || value.length === 0)) invalid('embeddingTexts');
  if (!['query', 'document', 'symmetric'].includes(config.purpose)) invalid('purpose');
  nonEmpty(config.searchQuery, 'searchQuery');
  return config;
}

function assertUuid(value, field) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`LOCAL_AI_PEER_INVALID_${field}`);
  }
}

export async function runLocalAiPeer(input) {
  const config = validatePeerConfig(input);
  const nc = await connect({
    servers: config.servers, name: config.name,
    inboxPrefix: config.inboxPrefix,
    ...(config.user ? { user: config.user, pass: config.password } : {}),
    ...(config.token ? { token: config.token } : {}),
  });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  async function request(subject, value, expectedError) {
    if (!validateRequest(subject, value)) throw new Error('LOCAL_AI_PEER_INVALID_REQUEST');
    const response = await nc.request(subject, encoder.encode(JSON.stringify(value)), { timeout: config.timeoutMs });
    const hasCode = response.headers?.has('Nats-Service-Error') ?? false;
    const hasStatus = response.headers?.has('Nats-Service-Error-Code') ?? false;
    if (hasCode !== hasStatus) throw new Error('LOCAL_AI_PEER_MALFORMED_ERROR_HEADERS');
    const errorCode = hasCode ? response.headers.get('Nats-Service-Error') : null;
    const errorStatus = hasStatus ? response.headers.get('Nats-Service-Error-Code') : null;
    let result;
    try { result = JSON.parse(decoder.decode(response.data)); } catch { throw new Error('LOCAL_AI_PEER_INVALID_REPLY'); }
    if (expectedError) {
      if (errorCode !== expectedError || errorStatus !== '404' || !validateError(result) || result.code !== errorCode) {
        throw new Error('LOCAL_AI_PEER_EXPECTED_ERROR_MISSING');
      }
      return null;
    }
    if (errorCode) throw new Error(`LOCAL_AI_PEER_SERVICE_ERROR:${errorCode}`);
    if (!validateResponse(subject, result)) throw new Error('LOCAL_AI_PEER_INVALID_REPLY');
    return result;
  }
  const verified = [];
  try {
    const listed = await request(subjects.modelsList, { filter: { installed: true }, page: { limit: 100 } });
    if (!Array.isArray(listed.items) || ![config.embeddingModel, config.transcriptionModel].every(selector =>
      listed.items.some(item => item.modelId === selector.modelId && item.revision === selector.revision && item.profileId === selector.profileId && item.installationState === 'installed'))) {
      throw new Error('LOCAL_AI_PEER_CATALOG_EMPTY');
    }
    verified.push('catalog-list');
    const card = await request(subjects.modelsGet, { modelId: config.embeddingModel.modelId });
    if (card.revision !== config.embeddingModel.revision || card.profileId !== config.embeddingModel.profileId) throw new Error('LOCAL_AI_PEER_MODEL_MISMATCH');
    verified.push('catalog-get');
    await request(subjects.catalogSearch, { query: config.searchQuery, filter: { operation: 'transcribe' }, page: { limit: 5 } });
    verified.push('catalog-search');
    const health = await request(subjects.status, { ownerId: config.ownerId });
    if (health.state !== 'ready' || Object.values(health.components).some(component => component.state !== 'ready')) {
      throw new Error('LOCAL_AI_PEER_SERVICE_NOT_READY');
    }
    verified.push('status');

    const now = Date.now();
    const embedRequest = {
      requestId: randomUUID(), operationId: randomUUID(), model: config.embeddingModel,
      ownerId: config.ownerId, deadlineAt: new Date(now + config.timeoutMs).toISOString(),
      texts: config.embeddingTexts, purpose: config.purpose,
    };
    const embedded = await request(subjects.invokeEmbed, embedRequest);
    assertUuid(embedded.requestId, 'REQUEST_ID');
    if (embedded.requestId !== embedRequest.requestId || embedded.operationId !== embedRequest.operationId
      || embedded.model.modelId !== config.embeddingModel.modelId || embedded.vectors.length !== config.embeddingTexts.length
      || embedded.vectors.some(vector => vector.length !== 1024 || vector.some(value => !Number.isFinite(value)))) {
      throw new Error('LOCAL_AI_PEER_EMBED_INVALID');
    }
    verified.push('embedding');

    const transcribeRequest = {
      requestId: randomUUID(), operationId: randomUUID(), model: config.transcriptionModel,
      ownerId: config.ownerId, deadlineAt: new Date(Date.now() + config.timeoutMs).toISOString(),
      audioArtifactId: config.audioArtifactId,
    };
    const transcribed = await request(subjects.invokeTranscribe, transcribeRequest);
    assertUuid(transcribed.requestId, 'REQUEST_ID');
    if (transcribed.requestId !== transcribeRequest.requestId || transcribed.operationId !== transcribeRequest.operationId
      || transcribed.model.modelId !== config.transcriptionModel.modelId || transcribed.text.trim().length === 0
      || (transcribed.segments !== null && transcribed.segments.some(segment =>
        !Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds) || segment.endSeconds < segment.startSeconds))) {
      throw new Error('LOCAL_AI_PEER_TRANSCRIPTION_INVALID');
    }
    verified.push('transcription');

    const missing = { modelId: `missing-${randomUUID()}` };
    await request(subjects.modelsGet, missing, 'MODEL_NOT_FOUND');
    verified.push('safe-model-error');
    return { verified };
  } finally {
    await nc.drain();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const raw = process.env.LOCAL_AI_PEER_CONFIG_JSON;
    if (!raw) invalid('LOCAL_AI_PEER_CONFIG_JSON');
    const summary = await runLocalAiPeer(JSON.parse(raw));
    console.log(JSON.stringify(summary));
  } catch {
    console.error('local-ai integration peer failed');
    process.exitCode = 1;
  }
}
