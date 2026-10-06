// ABOUTME: Собирает runtime, хранилище, соседние адаптеры и публичный NATS API local-ai.
// ABOUTME: Входная конфигурация явная; startup не выполняет миграции и не журналирует значения.
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, RequestStrategy, ServiceResponseType } from 'nats';
import pg from 'pg';
import llamaProfile from '../profiles/llama_cpp.json' with { type: 'json' };
import gigaProfile from '../profiles/gigaam_pytorch.json' with { type: 'json' };
import { subjects } from '../contracts/index.mjs';
import { createArtifactsAdapter } from '../dist/adapters/artifacts/index.js';
import { createHistoryDeliveryWorker } from '../dist/adapters/history/index.js';
import { createCatalog } from '../dist/catalog/index.js';
import { LocalAiError } from '../dist/errors.js';
import {
  createHuggingFaceCatalog, createModelInstaller, registerSupportedProfiles,
} from '../dist/install/huggingface.js';
import { createLifecycleManager } from '../dist/lifecycle/index.js';
import { createProfileRuntimeFactory } from '../dist/lifecycle/runtime-factory.js';
import { createPostgresStore } from '../dist/storage/postgres.js';
import { startLocalAiNats } from '../dist/transport/index.js';

const { Pool } = pg;
const CONFIG_KEYS = [
  'postgres', 'nats', 'transport', 'artifacts', 'history', 'installer', 'lifecycle', 'runtime',
];
const ALLOWED_CHILD_ENV = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'HF_HOME', 'HF_HUB_CACHE', 'TRANSFORMERS_CACHE', 'TORCH_HOME', 'HF_HUB_OFFLINE',
  'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY', 'PYTHONNOUSERSITE',
  'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'TOKENIZERS_PARALLELISM', 'LD_LIBRARY_PATH',
]);
const AUDIO_MIME_TYPES = ['audio/wav', 'audio/flac', 'audio/mpeg', 'audio/ogg'];

function invalid(field) { throw new TypeError(`LOCAL_AI_CONFIG_INVALID:${field}`); }
function object(value, field, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid(field);
  return value;
}
function string(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) invalid(field);
  return value;
}
function positive(value, field, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) invalid(field);
  return value;
}
function nonNegative(value, field, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) invalid(field);
  return value;
}
function strings(value, field) {
  if (!Array.isArray(value) || value.length === 0) invalid(field);
  return value.map((item, index) => string(item, `${field}.${index}`));
}
function env(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  for (const [key, item] of Object.entries(value)) {
    if (!ALLOWED_CHILD_ENV.has(key)) invalid(`${field}.${key}`);
    string(item, `${field}.${key}`);
  }
  return { ...value };
}

/** Проверяет конфигурацию целиком, включая конечные runtime и transport границы. */
export function validateLocalAiConfig(input) {
  const config = object(input, 'root', CONFIG_KEYS);
  const postgres = object(config.postgres, 'postgres', [
    'connectionString', 'maxConnections', 'connectionTimeoutMs', 'statementTimeoutMs', 'outboxCapacity', 'queryTimeoutMs',
  ]);
  string(postgres.connectionString, 'postgres.connectionString');
  positive(postgres.maxConnections, 'postgres.maxConnections');
  positive(postgres.connectionTimeoutMs, 'postgres.connectionTimeoutMs');
  positive(postgres.statementTimeoutMs, 'postgres.statementTimeoutMs', 2_147_483_647);
  if (positive(postgres.outboxCapacity, 'postgres.outboxCapacity') < 2) invalid('postgres.outboxCapacity');
  positive(postgres.queryTimeoutMs, 'postgres.queryTimeoutMs', 2_147_483_647);

  const nats = object(config.nats, 'nats', ['servers', 'user', 'password', 'token', 'name', 'inboxPrefix']);
  const servers = strings(nats.servers, 'nats.servers');
  for (const key of ['user', 'password', 'token']) {
    if (nats[key] !== null && nats[key] !== undefined && typeof nats[key] !== 'string') invalid(`nats.${key}`);
  }
  const hasUser = typeof nats.user === 'string' && nats.user.length > 0;
  const hasPassword = typeof nats.password === 'string' && nats.password.length > 0;
  const hasToken = typeof nats.token === 'string' && nats.token.length > 0;
  if ((hasUser !== hasPassword) || (hasToken && (hasUser || hasPassword))
    || nats.user !== 'local_ai' || hasToken) invalid('nats.authentication');
  if (hasUser) { string(nats.user, 'nats.user'); string(nats.password, 'nats.password'); }
  if (hasToken) string(nats.token, 'nats.token');
  string(nats.name, 'nats.name');
  if (nats.inboxPrefix !== '_INBOX.brai_local_ai') invalid('nats.inboxPrefix');

  const transport = object(config.transport, 'transport', [
    'maxConcurrentRequests', 'maxRequestBytes', 'maxReplyBytes', 'maxRequestMs', 'shutdownTimeoutMs', 'serviceVersion', 'serviceDescription',
  ]);
  positive(transport.maxConcurrentRequests, 'transport.maxConcurrentRequests');
  positive(transport.maxRequestBytes, 'transport.maxRequestBytes');
  positive(transport.maxReplyBytes, 'transport.maxReplyBytes');
  const safeErrorBytes = Buffer.byteLength(JSON.stringify({ code: 'DEPENDENCY_UNAVAILABLE', message: 'DEPENDENCY_UNAVAILABLE', retryable: true }));
  if (transport.maxReplyBytes < safeErrorBytes) invalid('transport.maxReplyBytes');
  positive(transport.maxRequestMs, 'transport.maxRequestMs', 2_147_483_647);
  positive(transport.shutdownTimeoutMs, 'transport.shutdownTimeoutMs', 2_147_483_647);
  string(transport.serviceVersion, 'transport.serviceVersion');
  string(transport.serviceDescription, 'transport.serviceDescription');

  const artifacts = object(config.artifacts, 'artifacts', [
    'internalBaseUrl', 'tempRoot', 'maxAudioBytes',
  ]);
  const baseUrl = string(artifacts.internalBaseUrl, 'artifacts.internalBaseUrl');
  let parsedUrl;
  try { parsedUrl = new URL(baseUrl); } catch { invalid('artifacts.internalBaseUrl'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.pathname !== '/') invalid('artifacts.internalBaseUrl');
  string(artifacts.tempRoot, 'artifacts.tempRoot');
  if (!path.isAbsolute(artifacts.tempRoot)) invalid('artifacts.tempRoot');
  positive(artifacts.maxAudioBytes, 'artifacts.maxAudioBytes');

  const history = object(config.history, 'history', [
    'batchSize', 'leaseMs', 'retryDelayMs', 'pollIntervalMs', 'requestTimeoutMs',
  ]);
  for (const key of Object.keys(history)) positive(history[key], `history.${key}`, 2_147_483_647);
  if (!Number.isSafeInteger(history.batchSize * history.requestTimeoutMs) || history.leaseMs <= history.batchSize * history.requestTimeoutMs) invalid('history.leaseMs');

  const installer = object(config.installer, 'installer', [
    'rootDirectory', 'seedDirectories', 'maxDownloadBytes', 'maxFiles', 'maxParallel', 'maxOperationMs', 'hubRequestTimeoutMs', 'maxQueryLength', 'maxPageSize',
  ]);
  string(installer.rootDirectory, 'installer.rootDirectory');
  if (!path.isAbsolute(installer.rootDirectory)) invalid('installer.rootDirectory');
  const seeds = object(installer.seedDirectories, 'installer.seedDirectories', ['llama_cpp', 'gigaam_pytorch']);
  const prepared = [llamaProfile, gigaProfile];
  for (const profile of prepared) {
    const candidate = string(seeds[profile.profileId], `installer.seedDirectories.${profile.profileId}`);
    const canonical = path.join(installer.rootDirectory, profile.modelId, profile.source.revision, profile.profileId);
    if (!path.isAbsolute(candidate) || path.resolve(candidate) !== path.resolve(canonical)) invalid(`installer.seedDirectories.${profile.profileId}`);
  }
  for (const key of Object.keys(installer).filter(key => key !== 'rootDirectory' && key !== 'seedDirectories')) positive(installer[key], `installer.${key}`, 2_147_483_647);

  const lifecycle = object(config.lifecycle, 'lifecycle', [
    'maxLoadedModels', 'maxQueuedOperations', 'maxInputBytes', 'maxEmbeddingItems', 'maxResultBytes', 'loadDeadlineMs',
  ]);
  for (const key of Object.keys(lifecycle)) positive(lifecycle[key], `lifecycle.${key}`, 2_147_483_647);

  const runtime = object(config.runtime, 'runtime', ['llama_cpp', 'gigaam_pytorch']);
  const llama = object(runtime.llama_cpp, 'runtime.llama_cpp', [
    'executable', 'cwd', 'args', 'env', 'startupTimeoutMs', 'requestTimeoutMs', 'stopGraceMs', 'maxLineBytes',
    'host', 'port', 'dimensions', 'contextTokens', 'maxBatchTokens', 'queryInstruction',
  ]);
  const giga = object(runtime.gigaam_pytorch, 'runtime.gigaam_pytorch', [
    'executable', 'cwd', 'args', 'env', 'startupTimeoutMs', 'requestTimeoutMs', 'stopGraceMs', 'maxLineBytes',
    'vadModelPath', 'vadRevision', 'threads', 'longformMaximumSeconds', 'audioDecodeTimeoutSeconds',
  ]);
  for (const [profile, values] of [['llama_cpp', llama], ['gigaam_pytorch', giga]]) {
    string(values.executable, `runtime.${profile}.executable`);
    string(values.cwd, `runtime.${profile}.cwd`);
    if (!path.isAbsolute(values.executable) || !path.isAbsolute(values.cwd)) invalid(`runtime.${profile}.paths`);
    strings(values.args, `runtime.${profile}.args`);
    env(values.env, `runtime.${profile}.env`);
    positive(values.startupTimeoutMs, `runtime.${profile}.startupTimeoutMs`, 2_147_483_647);
    positive(values.requestTimeoutMs, `runtime.${profile}.requestTimeoutMs`, 2_147_483_647);
    nonNegative(values.stopGraceMs, `runtime.${profile}.stopGraceMs`, 2_147_483_647);
    positive(values.maxLineBytes, `runtime.${profile}.maxLineBytes`);
  }
  string(llama.host, 'runtime.llama_cpp.host');
  positive(llama.port, 'runtime.llama_cpp.port', 65_535);
  positive(llama.dimensions, 'runtime.llama_cpp.dimensions');
  positive(llama.contextTokens, 'runtime.llama_cpp.contextTokens');
  positive(llama.maxBatchTokens, 'runtime.llama_cpp.maxBatchTokens');
  string(llama.queryInstruction, 'runtime.llama_cpp.queryInstruction');
  if (JSON.stringify(llama.args) !== JSON.stringify(llamaProfile.engine.args)
    || llama.dimensions !== llamaProfile.encoding.dimensions
    || llama.contextTokens !== llamaProfile.limits.contextTokens
    || llama.maxBatchTokens !== llamaProfile.limits.batchTokens
    || llama.queryInstruction !== llamaProfile.encoding.queryInstruction) invalid('runtime.llama_cpp.profile');
  if (JSON.stringify(giga.args) !== JSON.stringify(gigaProfile.engine.args)) invalid('runtime.gigaam_pytorch.args');
  string(giga.vadModelPath, 'runtime.gigaam_pytorch.vadModelPath');
  string(giga.vadRevision, 'runtime.gigaam_pytorch.vadRevision');
  positive(giga.threads, 'runtime.gigaam_pytorch.threads');
  // These values deliberately have no defaults: both require accepted runtime measurements.
  positive(giga.longformMaximumSeconds, 'runtime.gigaam_pytorch.longformMaximumSeconds');
  if (giga.longformMaximumSeconds <= 25) invalid('runtime.gigaam_pytorch.longformMaximumSeconds');
  positive(giga.audioDecodeTimeoutSeconds, 'runtime.gigaam_pytorch.audioDecodeTimeoutSeconds');

  return config;
}

function runtimeConfig(config) {
  const { llama_cpp: llama, gigaam_pytorch: giga } = config.runtime;
  return {
    profiles: {
      llama_cpp: {
        executable: llama.executable, cwd: llama.cwd, args: llama.args, env: llama.env,
        startupTimeoutMs: llama.startupTimeoutMs, requestTimeoutMs: llama.requestTimeoutMs,
        stopGraceMs: llama.stopGraceMs, maxLineBytes: llama.maxLineBytes,
        host: llama.host, port: () => llama.port, dimensions: llama.dimensions,
        contextTokens: llama.contextTokens, maxBatchTokens: llama.maxBatchTokens,
        queryInstruction: llama.queryInstruction,
      },
      gigaam_pytorch: {
        executable: giga.executable, cwd: giga.cwd, args: giga.args, env: giga.env,
        startupTimeoutMs: giga.startupTimeoutMs, requestTimeoutMs: giga.requestTimeoutMs,
        stopGraceMs: giga.stopGraceMs, maxLineBytes: giga.maxLineBytes,
        vadModelPath: giga.vadModelPath, vadRevision: giga.vadRevision, threads: giga.threads,
        longformMaximumSeconds: giga.longformMaximumSeconds,
        audioDecodeTimeoutSeconds: giga.audioDecodeTimeoutSeconds,
      },
    },
  };
}

/** Проецирует закреплённые manifest-профили в ModelRecord; не запускает runtime и не придумывает неизвестные limits. */
export function supportedProfiles(config) {
  const embedding = {
    modelId: llamaProfile.modelId, name: 'Giga Embeddings 480M Q8',
    description: 'Instruction-tuned multilingual text embeddings.', source: llamaProfile.source.repository,
    license: null, revision: llamaProfile.source.revision, profileId: llamaProfile.profileId,
    supported: true, operations: ['embed'], languages: [], inputKinds: ['text'], outputKinds: ['vector'],
    files: llamaProfile.source.files.map(file => ({ path: file.path, sizeBytes: file.bytes, sha256: file.sha256 })),
    hardwareRequirements: { cpuArchitectures: [], minMemoryBytes: null, accelerator: null },
    limits: { maxInputBytes: null, maxAudioSeconds: null, maxItems: null, maxResultBytes: null, vectorDimensions: llamaProfile.encoding.dimensions },
    parameters: { embed: { purpose: ['query', 'document', 'symmetric'] }, transcribe: null },
  };
  const transcription = {
    modelId: gigaProfile.modelId, name: 'GigaAM v3 E2E CTC',
    description: 'Russian speech recognition.', source: gigaProfile.source.repository,
    license: null, revision: gigaProfile.source.revision, profileId: gigaProfile.profileId,
    supported: true, operations: ['transcribe'], languages: ['ru'], inputKinds: ['audio_artifact'], outputKinds: ['transcription'],
    files: gigaProfile.source.files.map(file => ({ path: file.path, sizeBytes: file.bytes, sha256: file.sha256 })),
    hardwareRequirements: { cpuArchitectures: [], minMemoryBytes: null, accelerator: null },
    limits: { maxInputBytes: null, maxAudioSeconds: config.runtime.gigaam_pytorch.longformMaximumSeconds, maxItems: 1, maxResultBytes: null, vectorDimensions: null },
    parameters: { embed: null, transcribe: {} },
  };
  return [
    { profileId: llamaProfile.profileId, modelId: embedding.modelId, repository: llamaProfile.source.repository, revision: llamaProfile.source.revision, files: llamaProfile.source.files, record: embedding },
    { profileId: gigaProfile.profileId, modelId: transcription.modelId, repository: gigaProfile.source.repository, revision: gigaProfile.source.revision, files: gigaProfile.source.files, record: transcription },
  ];
}

function pageOffset(cursor) {
  if (cursor === undefined) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!/^(0|[1-9]\d*)$/.test(decoded)) throw new Error();
    const value = Number(decoded);
    if (!Number.isSafeInteger(value)) throw new Error();
    return value;
  } catch { throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_ARGUMENT'); }
}

function status(state, errorCode = null) { return { state, errorCode }; }

async function waitBounded(value, timeoutMs, name) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function combineStatus(components) {
  const values = Object.values(components);
  if (values.some(value => value.state === 'unavailable')) return 'unavailable';
  if (values.some(value => value.state === 'degraded' || value.state === 'unknown')) return 'degraded';
  return 'ready';
}

async function historyReachable(nc, timeoutMs) {
  try {
    const responses = await nc.services.client({ strategy: RequestStrategy.Count, maxWait: timeoutMs, maxMessages: 1 }).ping('service_history');
    let found = false;
    for await (const identity of responses) {
      if (identity?.type === ServiceResponseType.PING && identity.name === 'service_history'
        && typeof identity.id === 'string' && identity.id.length > 0
        && typeof identity.version === 'string' && identity.version.length > 0) found = true;
    }
    return found;
  } catch {
    return false;
  }
}

/** Запускает все local-ai ресурсы; возвращённый close ждёт остановки процессов и закрытия собственных соединений. */
export async function startLocalAi(input, dependencies = {}) {
  const config = validateLocalAiConfig(input);
  const poolFactory = dependencies.Pool ? dependencies.Pool : Pool;
  const connectNats = dependencies.connect ?? connect;
  const pool = new poolFactory({
    connectionString: config.postgres.connectionString,
    max: config.postgres.maxConnections,
    connectionTimeoutMillis: config.postgres.connectionTimeoutMs,
    statement_timeout: config.postgres.statementTimeoutMs,
  });
  let nc;
  let installer;
  let lifecycle;
  let historyWorker;
  let transport;
  let shutdownPromise;
  const close = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const deadline = Date.now() + config.transport.shutdownTimeoutMs;
      const remaining = () => Math.max(0, deadline - Date.now());
      let failed = false;
      try {
        if (transport) await waitBounded(transport.stopAdmission(), remaining(), 'ADMISSION_STOP_TIMEOUT');
      } catch { failed = true; }
      const modelClosures = await Promise.allSettled([
        installer ? Promise.resolve().then(() => waitBounded(installer.close(), remaining(), 'INSTALLER_STOP_TIMEOUT')) : undefined,
        lifecycle ? Promise.resolve().then(() => waitBounded(lifecycle.close(), remaining(), 'LIFECYCLE_STOP_TIMEOUT')) : undefined,
      ]);
      if (modelClosures.some(result => result.status === 'rejected')) failed = true;
      if (!failed && transport) {
        try { await waitBounded(transport.drainHandlers(), remaining(), 'HANDLER_DRAIN_TIMEOUT'); }
        catch { failed = true; }
      }
      try { if (historyWorker) await waitBounded(historyWorker.stop(), remaining(), 'HISTORY_STOP_TIMEOUT'); }
      catch { failed = true; }
      try { if (nc) await waitBounded(nc.drain(), remaining(), 'NATS_DRAIN_TIMEOUT'); }
      catch { failed = true; }
      try { await waitBounded(pool.end(), remaining(), 'DATABASE_CLOSE_TIMEOUT'); }
      catch { failed = true; }
      if (failed) throw new Error('LOCAL_AI_SHUTDOWN_FAILED');
    })();
    return shutdownPromise;
  };

  try {
    await pool.query('SELECT 1');
    nc = await connectNats({
      servers: config.nats.servers,
      name: config.nats.name,
      inboxPrefix: config.nats.inboxPrefix,
      ...(config.nats.user ? { user: config.nats.user, pass: config.nats.password } : {}),
      ...(config.nats.token ? { token: config.nats.token } : {}),
    });
    const factories = dependencies.factories ?? {};
    const makeStore = factories.createPostgresStore ?? createPostgresStore;
    const recover = factories.recoverInterrupted;
    const makeInstaller = factories.createModelInstaller ?? createModelInstaller;
    const makeArtifacts = factories.createArtifactsAdapter ?? createArtifactsAdapter;
    const makeLifecycle = factories.createLifecycleManager ?? createLifecycleManager;
    const makeCatalog = factories.createCatalog ?? createCatalog;
    const makeHubCatalog = factories.createHuggingFaceCatalog ?? createHuggingFaceCatalog;
    const makeHistoryWorker = factories.createHistoryDeliveryWorker ?? createHistoryDeliveryWorker;
    const makeTransport = factories.startLocalAiNats ?? startLocalAiNats;
    const store = makeStore(pool, {
      outboxCapacity: config.postgres.outboxCapacity,
      queryTimeoutMs: config.postgres.queryTimeoutMs,
    });
    await (recover ? recover(store) : store.recoverInterrupted());
    const profiles = supportedProfiles(config);
    await (factories.registerSupportedProfiles ?? registerSupportedProfiles)(store, profiles);
    installer = makeInstaller({
      store, profiles, rootDirectory: config.installer.rootDirectory,
      limits: {
        maxDownloadBytes: config.installer.maxDownloadBytes,
        maxFiles: config.installer.maxFiles,
        maxParallel: config.installer.maxParallel,
        maxOperationMs: config.installer.maxOperationMs,
      },
    });
    for (const profile of profiles) {
      const seedDirectory = config.installer.seedDirectories[profile.profileId];
      let seedExists = true;
      try { await access(seedDirectory, constants.R_OK); }
      catch (error) { if (error?.code === 'ENOENT') seedExists = false; else throw error; }
      if (seedExists) await installer.importVerified({
        modelId: profile.modelId, revision: profile.revision, profileId: profile.profileId, directory: seedDirectory,
      });
    }
    await installer.cleanupAbandonedStaging();
    const runtimeFactory = (factories.createProfileRuntimeFactory ?? createProfileRuntimeFactory)(runtimeConfig(config));
    const artifacts = makeArtifacts({
      nats: nc, internalBaseUrl: config.artifacts.internalBaseUrl,
      tempRoot: config.artifacts.tempRoot, maxAudioBytes: config.artifacts.maxAudioBytes,
      allowedMimeTypes: AUDIO_MIME_TYPES,
    });
    lifecycle = makeLifecycle({ store, runtimeFactory, artifacts, limits: config.lifecycle });
    const catalog = makeCatalog(store, lifecycle);
    const hugCatalog = makeHubCatalog({
      profiles, requestTimeoutMs: config.installer.hubRequestTimeoutMs,
      maxQueryLength: config.installer.maxQueryLength, maxPageSize: config.installer.maxPageSize,
    });
    const outbox = makeHistoryWorker({
      nats: nc, outbox: store, batchSize: config.history.batchSize,
      leaseMs: config.history.leaseMs, retryDelayMs: config.history.retryDelayMs,
      pollIntervalMs: config.history.pollIntervalMs, requestTimeoutMs: config.history.requestTimeoutMs,
    });
    historyWorker = outbox;
    historyWorker.start();
    const handlers = {
      [subjects.modelsList]: async request => {
        const filter = request.filter ?? {};
        const offset = pageOffset(request.page?.cursor);
        const items = await catalog.list(filter);
        const sorted = items.sort((left, right) => left.modelId.localeCompare(right.modelId));
        const limit = request.page?.limit ?? sorted.length;
        const page = sorted.slice(offset, offset + limit);
        return { items: page, nextCursor: offset + page.length < sorted.length ? Buffer.from(String(offset + page.length)).toString('base64url') : null };
      },
      [subjects.modelsGet]: request => catalog.get(request.modelId),
      [subjects.catalogSearch]: request => hugCatalog.search(request),
      [subjects.modelsInstall]: request => installer.start(request),
      [subjects.operationsGet]: request => installer.get(request.operationId, request.ownerId),
      [subjects.modelsConfigure]: (request, context) => catalog.configure(request, context),
      [subjects.modelsLoad]: async (request, context) => {
        const selector = { modelId: request.modelId, revision: request.revision, profileId: request.profileId };
        await lifecycle.load(selector, context);
        return { ...selector, state: 'loaded' };
      },
      [subjects.modelsUnload]: async (request, context) => {
        const selector = { modelId: request.modelId, revision: request.revision, profileId: request.profileId };
        await lifecycle.unload(selector, context);
        return { ...selector, state: 'unloaded' };
      },
      [subjects.modelsRemove]: async (request, context) => {
        const removed = await catalog.remove(request.modelId, request.revision, request.profileId, context);
        await installer.cleanupPublished(removed);
        return { modelId: removed.modelId, revision: removed.revision, profileId: removed.profileId, state: 'removed' };
      },
      [subjects.invokeEmbed]: async (request, context) => {
        const result = await lifecycle.invoke({ ...request, operation: 'embed' }, context);
        return { requestId: request.requestId, operationId: request.operationId, model: result.model, durationMs: result.durationMs, vectors: result.vectors };
      },
      [subjects.invokeTranscribe]: async (request, context) => {
        const result = await lifecycle.invoke({ ...request, operation: 'transcribe' }, context);
        return { requestId: request.requestId, operationId: request.operationId, model: result.model, durationMs: result.durationMs, text: result.text, segments: result.segments };
      },
      [subjects.cancel]: async request => {
        const result = await lifecycle.cancel(request.ownerId, request.operationId);
        if (result !== 'not_found') return { operationId: request.operationId, status: result };
        try {
          const operation = await installer.cancel(request.operationId, request.ownerId);
          return { operationId: request.operationId, status: ['accepted', 'running'].includes(operation.status) ? 'cancellation_requested' : 'already_terminal' };
        } catch (error) {
          if (error instanceof LocalAiError && error.code === 'MODEL_NOT_FOUND') return { operationId: request.operationId, status: 'not_found' };
          throw error;
        }
      },
      [subjects.status]: async () => {
        let database = status('ready');
        try { await pool.query('SELECT 1'); } catch { database = status('unavailable', 'DEPENDENCY_UNAVAILABLE'); }
        const natsStatus = transport?.connected() ? status('ready') : status('unavailable', 'DEPENDENCY_UNAVAILABLE');
        let executablesReady = true;
        for (const profile of [config.runtime.llama_cpp, config.runtime.gigaam_pytorch]) {
          try { await access(profile.executable, constants.X_OK); } catch { executablesReady = false; }
        }
        const executables = status(executablesReady ? 'ready' : 'unavailable', executablesReady ? null : 'ENGINE_UNAVAILABLE');
        let installed = [];
        let delivery = { reserved: 0, pending: 0, sending: 0, permanentlyFailed: 0, oldestCreatedAt: null, lastErrorCode: null };
        let storageReadable = database.state === 'ready';
        if (storageReadable) {
          try {
            installed = await store.transaction(async tx => Promise.all(profiles.map(profile => tx.installations.get(profile.modelId, profile.revision))));
            delivery = await store.status();
          } catch { storageReadable = false; }
        }
        let weightsReady = storageReadable && installed.every(Boolean);
        if (weightsReady) {
          for (const installation of installed) {
            for (const file of installation.files) {
              try { await access(path.join(installation.directory, file.path), constants.R_OK); } catch { weightsReady = false; }
            }
          }
        }
        const weights = status(weightsReady ? 'ready' : storageReadable ? 'degraded' : 'unknown',
          weightsReady ? null : storageReadable ? 'MODEL_NOT_INSTALLED' : 'DEPENDENCY_UNAVAILABLE');
        const historyAvailable = await historyReachable(nc, Math.min(config.history.requestTimeoutMs, config.transport.maxRequestMs));
        const historyError = delivery.lastErrorCode === 'HISTORY_REJECTED' ? 'INTERNAL'
          : delivery.lastErrorCode ? 'DEPENDENCY_UNAVAILABLE' : null;
        const history = status(historyError ? 'degraded' : historyAvailable ? 'ready' : 'unavailable',
          historyError ?? (historyAvailable ? null : 'DEPENDENCY_UNAVAILABLE'));
        const outboxFull = delivery.reserved + delivery.pending + delivery.sending >= config.postgres.outboxCapacity;
        const outboxFailed = delivery.permanentlyFailed > 0;
        const outbox = status(outboxFailed || outboxFull ? 'degraded' : storageReadable ? 'ready' : 'unknown',
          outboxFailed ? 'INTERNAL' : outboxFull ? 'BUSY' : storageReadable ? null : 'DEPENDENCY_UNAVAILABLE');
        const components = { database, nats: natsStatus, executables, weights, history, outbox };
        return {
          state: combineStatus(components), components,
          outboxCounts: {
            reserved: delivery.reserved, pending: delivery.pending, sending: delivery.sending,
            permanentlyFailed: delivery.permanentlyFailed, oldestCreatedAt: delivery.oldestCreatedAt,
          },
        };
      },
    };
    transport = await makeTransport(nc, {
      maxConcurrentRequests: config.transport.maxConcurrentRequests,
      maxRequestBytes: config.transport.maxRequestBytes,
      maxReplyBytes: config.transport.maxReplyBytes,
      maxRequestMs: config.transport.maxRequestMs,
      serviceInfo: { version: config.transport.serviceVersion, description: config.transport.serviceDescription },
    }, handlers);
    return { pool, nc, store, installer, lifecycle, transport, historyWorker, close };
  } catch {
    await close().catch(() => undefined);
    throw new Error('LOCAL_AI_STARTUP_FAILED');
  }
}

/** Останавливает экземпляр и при сигнале, пришедшем до завершения startup. */
export async function runLocalAiProcess(start, registerSignalHandlers = callback => {
  process.once('SIGTERM', callback);
  process.once('SIGINT', callback);
}) {
  let runtime;
  let stopping;
  let stopRequested = false;
  const stop = () => {
    if (!runtime) {
      stopRequested = true;
      return Promise.resolve();
    }
    if (!stopping) stopping = runtime.close();
    return stopping;
  };
  registerSignalHandlers(() => {
    void stop().catch(() => {
      console.error('local-ai shutdown failed');
      process.exitCode = 1;
    });
  });
  runtime = await start();
  if (!stopRequested) await runtime.nc.closed();
  await stop();
}

function readConfig() {
  const raw = process.env.LOCAL_AI_CONFIG_JSON;
  if (!raw) invalid('LOCAL_AI_CONFIG_JSON');
  let value;
  try { value = JSON.parse(raw); } catch { invalid('LOCAL_AI_CONFIG_JSON'); }
  return validateLocalAiConfig(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    await runLocalAiProcess(() => startLocalAi(readConfig()));
  } catch {
    console.error('local-ai process failed');
    process.exitCode = 1;
  }
}
