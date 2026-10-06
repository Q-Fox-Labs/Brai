// ABOUTME: Проверяет изоляцию входов при защищённой приёмке установки.
// ABOUTME: Наблюдатель ENOSPC только перехватывает и повторно выбрасывает исходную ошибку записи.
import { AsyncLocalStorage } from 'node:async_hooks';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { validateMetadataEvent } from '../../contracts/index.mjs';

const REQUIRED_ENV = 'BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_REQUIRED';
const BASE_DIRECTORY = '/var/lib/brai-local-ai-installation-acceptance';
const EXPECTED_DATABASE = 'brai_local_ai_acceptance_installation';
const EXPECTED_APP_ROLE = 'laa_install_app';
const PHASES = new Set(['hash', 'enospc', 'public', 'inspect']);
const FORBIDDEN_ENVIRONMENT = [
  'HF_TOKEN', 'HUGGINGFACE_HUB_TOKEN', 'NATS_PASSWORD', 'NATS_TOKEN',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];
const writeScope = new AsyncLocalStorage();
let witnessActive = false;

/** @typedef {{phase: string, runId: string, databaseUrl: string, rootDirectory: string, maxOperationMs: number, cleanupGraceMs: number, watchdogMs: number, publicReserveBytes: number}} InstallAcceptanceConfig */
/** @typedef {{code: string|null, errno: number|null, syscall: string|null, writeCalls: number}} NativeWriteWitness */

/** Возвращает bounded inputs; ошибка валидации не раскрывает URL подключения. @param {NodeJS.ProcessEnv} env @returns {Readonly<InstallAcceptanceConfig>} */
export function readInstallAcceptanceConfig(env) {
  if (env?.[REQUIRED_ENV] !== '1') throw new Error('protected install acceptance requires REQUIRED=1');
  if (FORBIDDEN_ENVIRONMENT.some(name => env[name] !== undefined && env[name] !== '')) {
    throw new Error('protected install acceptance received a forbidden inherited credential or proxy');
  }
  const phase = env.BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_PHASE;
  const runId = env.BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_RUN_ID;
  const databaseUrl = env.BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_DATABASE_URL;
  const rootDirectory = env.BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_ROOT;
  const maxOperationMs = boundedInteger(env.BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_MAX_OPERATION_MS, 1, 600_000);
  const cleanupGraceMs = boundedInteger(env.BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_CLEANUP_GRACE_MS, 1_000, 120_000);
  const watchdogMs = boundedInteger(env.BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_WATCHDOG_MS, 900_000, 900_000);
  const publicReserveBytes = boundedInteger(env.BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_PUBLIC_RESERVE_BYTES, 1, 2_147_483_648);
  if (!PHASES.has(phase) || !isUuid(runId) || !isPostgresUrl(databaseUrl)
    || env.BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_DATABASE !== EXPECTED_DATABASE
    || env.BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_APP_ROLE !== EXPECTED_APP_ROLE
    || rootDirectory !== path.join(BASE_DIRECTORY, runId)
    || watchdogMs <= maxOperationMs + cleanupGraceMs) {
    throw new Error('protected install acceptance configuration is incomplete or outside its fixed bounds');
  }
  return Object.freeze({ phase, runId, databaseUrl, rootDirectory, maxOperationMs, cleanupGraceMs, watchdogMs, publicReserveBytes });
}

/** Проверяет фактическую БД и роль до создания installer или файловых операций. @param {{database: string, role: string}} identity */
export function assertInstallDatabaseIdentity(identity) {
  if (!identity || identity.database !== EXPECTED_DATABASE || identity.role !== EXPECTED_APP_ROLE) {
    throw new Error('protected install acceptance database identity mismatch');
  }
}

/** Отказывается продолжать, если в выделенном acceptance namespace уже есть записи. @param {{models: number, installations: number, operations: number, settings: number, outbox: number}} counts */
export function assertFreshInstallNamespace(counts) {
  if (!counts || !['models', 'installations', 'operations', 'settings', 'outbox'].every(key => counts[key] === 0)) {
    throw new Error('protected install acceptance namespace is not empty; inspect only and do not reset it');
  }
}

/** Читает строки каталога через фактический контракт LocalAiTx с обязательными пустыми фильтрами.
 * @param {{transaction: (run: (tx: {models: {list: (filter: {}) => Promise<unknown[]>}, installations: {list: (filter: {}) => Promise<unknown[]>}}) => Promise<unknown[]>) => Promise<unknown[]>}} store
 * @returns {Promise<{models: unknown[], installations: unknown[]}>}
 */
export async function readAcceptanceStoreRows(store) {
  const models = await store.transaction(tx => tx.models.list({}));
  const installations = await store.transaction(tx => tx.installations.list({}));
  return { models, installations };
}

/** Принимает только пустой hash namespace или неизменённую регистрацию закреплённого профиля.
 * @param {{models: unknown[], installations: unknown[], operations: unknown[], settings: number, events: Array<{event_id: string, state: string, event: Record<string, unknown>}>, status: {reserved: number, pending: number, sending: number, permanentlyFailed: number}}} state
 * @param {{modelId: string, revision: string, profileId: string, record: Record<string, unknown>}} profile
 * @returns {'empty'|'registered'}
 */
export function classifyHashNamespaceState(state, profile) {
  const status = state?.status;
  const empty = state?.models?.length === 0 && state?.installations?.length === 0
    && state?.operations?.length === 0 && state?.settings === 0 && state?.events?.length === 0
    && status?.reserved === 0 && status?.pending === 0 && status?.sending === 0 && status?.permanentlyFailed === 0
    && status?.oldestCreatedAt === null && status?.lastErrorCode === null;
  if (empty) return 'empty';

  const model = state?.models?.[0];
  const row = state?.events?.[0];
  const event = row?.event;
  const data = event?.data;
  const eventDataKeys = ['modelId', 'operation', 'operationId', 'outcome', 'phase', 'profileId', 'revision'];
  const exactEventData = data && isDeepStrictEqual(Object.keys(data).sort(), eventDataKeys);
  const registered = state?.models?.length === 1 && isDeepStrictEqual(model, profile.record)
    && state?.installations?.length === 0 && state?.operations?.length === 0 && state?.settings === 0
    && state?.events?.length === 1 && row?.state === 'pending'
    && isUuid(row?.event_id) && event?.id === row?.event_id && event?.type_id === 1301
    && validateMetadataEvent(event)
    && event?.actor_id === null && event?.scope_type === 'system' && event?.scope_id === 'local_ai'
    && event?.object_type === 'model' && event?.object_id === profile.modelId && exactEventData
    && data?.operation === 'configure' && data?.modelId === profile.modelId
    && data?.revision === profile.revision && data?.profileId === profile.profileId
    && isUuid(data?.operationId) && data?.outcome === 'succeeded' && data?.phase === 'configure'
    && status?.reserved === 0 && status?.pending === 1 && status?.sending === 0 && status?.permanentlyFailed === 0
    && status?.oldestCreatedAt !== null && status?.lastErrorCode === null;
  if (registered) return 'registered';
  throw Object.assign(new Error('protected hash namespace is neither empty nor the pinned registration'), { safeCode: 'HASH_NAMESPACE_INVALID' });
}

/** Требует ровно одно изменение хеша именно в первом закреплённом файле.
 * @param {{files: Array<{path: string}>}} profile
 * @param {string[]} mismatchPaths
 */
export function assertExpectedHashMismatch(profile, mismatchPaths) {
  const expectedPath = profile?.files?.[0]?.path;
  if (typeof expectedPath !== 'string' || !expectedPath || !Array.isArray(mismatchPaths)
    || mismatchPaths.length !== 1 || mismatchPaths[0] !== expectedPath) {
    throw Object.assign(new Error('protected hash candidate mismatch does not match the pinned first file'), { safeCode: 'HASH_CANDIDATE_MISMATCH_NOT_EXPECTED' });
  }
}

/** Проверяет настоящую ошибку ENOSPC, увиденную при FileHandle.writeFile. @param {NativeWriteWitness} witness */
export function isNativeEnospcWitness(witness) {
  return witness?.code === 'ENOSPC' && Number.isInteger(witness.errno) && witness.syscall === 'write';
}

/** Наблюдает native writes только под заданным каталогом и всегда повторно выбрасывает исходную ошибку. @param {string} targetRoot @param {() => Promise<unknown>} run */
export async function withNativeEnospcWitness(targetRoot, run) {
  if (typeof run !== 'function' || !path.isAbsolute(targetRoot) || witnessActive) throw new Error('invalid or concurrent native ENOSPC witness');
  const realTargetRoot = path.resolve(targetRoot);
  if (realTargetRoot !== targetRoot) throw new Error('invalid native ENOSPC witness root');
  /** @type {NativeWriteWitness} */
  const witness = { code: null, errno: null, syscall: null, writeCalls: 0 };
  const originalOpen = fsPromises.open;
  const observingOpen = async function (...args) {
    const handle = await Reflect.apply(originalOpen, fsPromises, args);
    const target = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
    if (writeScope.getStore() !== witness || !isWithin(realTargetRoot, target)) return handle;
    const originalWriteFile = handle.writeFile.bind(handle);
    handle.writeFile = async function (...writeArgs) {
      witness.writeCalls += 1;
      try {
        return await Reflect.apply(originalWriteFile, undefined, writeArgs);
      } catch (error) {
        if (error?.code === 'ENOSPC') {
          witness.code = error.code;
          witness.errno = error.errno;
          witness.syscall = error.syscall;
        }
        throw error;
      }
    };
    return handle;
  };
  witnessActive = true;
  fsPromises.open = observingOpen;
  syncBuiltinESMExports();
  try {
    let value;
    let thrown;
    try { value = await writeScope.run(witness, run); }
    catch (error) { thrown = error; }
    return Object.freeze({
      value,
      thrown,
      observed: Object.freeze({ code: witness.code, errno: witness.errno, syscall: witness.syscall, writeCalls: witness.writeCalls }),
    });
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
    witnessActive = false;
  }
}

/** Возвращает пути собственных cases, не принимая пути production roots. @param {InstallAcceptanceConfig} config */
export function installAcceptanceCaseDirectories(config) {
  const root = path.resolve(config.rootDirectory);
  if (root !== config.rootDirectory || !root.startsWith(`${BASE_DIRECTORY}/`)) {
    throw new Error('protected install acceptance root is outside its fixed base');
  }
  return Object.freeze({
    root,
    publicDirectory: path.join(root, 'public'),
    hashCandidateDirectory: path.join(root, 'hash-candidate'),
    enospcDirectory: path.join(root, 'enospc'),
  });
}

function isUuid(value) {
  return typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value);
}

function isPostgresUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return ['postgres:', 'postgresql:'].includes(url.protocol)
      && url.hostname === '127.0.0.1'
      && url.port === '19472'
      && url.username === EXPECTED_APP_ROLE
      && url.password.length > 0
      && url.pathname === `/${EXPECTED_DATABASE}`
      && url.search === ''
      && url.hash === '';
  }
  catch { return false; }
}

function boundedInteger(value, min, max) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('protected install acceptance bound is invalid');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('protected install acceptance bound is invalid');
  return number;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
