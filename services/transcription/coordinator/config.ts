// ABOUTME: Читает явную конфигурацию координатора и отдельные allowlist окружения дочерних программ.
// ABOUTME: Секреты не передаются предметному ядру, миграционные credentials не наследуются children.
import { validateDto } from '#transcription-contracts';
import type { CoordinatorConfig } from './domain/core.js';
import type { AuthBinding } from './transport/boundary.js';

export type NatsSettings = { servers: string; inboxPrefix: string; user?: string; pass?: string; token?: string };
export type CoordinatorRuntimeConfig = {
  domain: CoordinatorConfig;
  bindings: AuthBinding[];
  http: { host: string; port: number; allowedHosts: string[]; allowedOrigins: string[]; headerBytes: number;
    requestBytes: number; responseBytes: number; requestTimeoutMs: number; maxConnections: number };
  maxPublicConcurrent: number;
  nats: NatsSettings;
  natsRequestBytes: number;
  natsResponseBytes: number;
  dependencyTimeoutMs: number;
  maxCatalogItems: number;
  catalogPageSize: number;
  rpcFrameBytes: number;
  rpcConcurrentRequests: number;
  rpcControlTimeoutMs: number;
  childShutdownTimeoutMs: number;
  children: { helper: Record<string, string>; local: Record<string, string>; external: Record<string, string> };
  localAi?: NatsSettings;
  recovery: { instanceId: string; workerId: string; recoveryMaxBatches: number; recoveryCycleTimeoutMs: number;
    recoveryPollIntervalMs: number; historyMaxDeliveries: number; historyPollIntervalMs: number; pumpPollIntervalMs: number };
};

function invalid(): never { throw new Error('Invalid transcription coordinator configuration'); }
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  return typeof value === 'string' && value.length ? value : invalid();
}
function positive(env: NodeJS.ProcessEnv, name: string, timer = false): number {
  const value = required(env, name);
  if (!/^[0-9]+$/.test(value)) invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || (timer && number > 2_147_483_647)) invalid();
  return number;
}
function jsonList(env: NodeJS.ProcessEnv, name: string): string[] {
  let values: unknown;
  try { values = JSON.parse(required(env, name)); } catch { invalid(); }
  if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !value || /\s/.test(value))) invalid();
  return [...new Set(values as string[])];
}
function natsSettings(env: NodeJS.ProcessEnv, prefix: string, optional = false): NatsSettings | undefined {
  const servers = env[`${prefix}URL`];
  const user = env[`${prefix}USER`];
  const pass = env[`${prefix}PASSWORD`];
  const token = env[`${prefix}TOKEN`];
  const inboxPrefix = env[`${prefix}INBOX_PREFIX`];
  if (optional && !servers && !user && !pass && !token && !inboxPrefix) return undefined;
  if (!servers || Boolean(user) !== Boolean(pass) || (token && (user || pass))) invalid();
  if (!inboxPrefix || !/^_INBOX\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(inboxPrefix)) invalid();
  try {
    for (const server of servers!.split(',')) {
      const url = new URL(server);
      if (!['nats:', 'tls:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
        (url.pathname && url.pathname !== '/') || url.search || url.hash) invalid();
    }
  } catch { invalid(); }
  return { servers: servers!, inboxPrefix: inboxPrefix!, ...(user ? { user, pass } : {}), ...(token ? { token } : {}) };
}

/** Все нужные пределы обязательны; ошибка конфигурации не включает имена/значения credentials. */
export function loadCoordinatorConfig(env: NodeJS.ProcessEnv = process.env): CoordinatorRuntimeConfig {
  const p = (suffix: string, timer = false) => positive(env, `TRANSCRIPTION_${suffix}`, timer);
  const instanceId = required(env, 'TRANSCRIPTION_INSTANCE_ID');
  const workerId = required(env, 'TRANSCRIPTION_WORKER_ID');
  if (!validateDto('OwnerId', instanceId) || !validateDto('OwnerId', workerId)) invalid();
  const domain: CoordinatorConfig = {
    instanceId, workerId, maxExecuteConcurrency: p('MAX_EXECUTE_CONCURRENCY'),
    leaseRenewIntervalMs: p('LEASE_RENEW_INTERVAL_MS', true), defaultExecutionTimeoutMs: p('DEFAULT_EXECUTION_TIMEOUT_MS', true),
    resultTtlMs: p('RESULT_TTL_MS', true), maxResultCount: p('MAX_RESULT_COUNT'),
    maxResultBytes: p('MAX_RESULT_BYTES'), maxTotalResultBytes: p('MAX_TOTAL_RESULT_BYTES'),
  };
  if (domain.maxResultBytes > domain.maxTotalResultBytes) invalid();
  let bindings: unknown;
  try { bindings = JSON.parse(required(env, 'TRANSCRIPTION_AUTH_BINDINGS_JSON')); } catch { invalid(); }
  if (!Array.isArray(bindings) || !bindings.length || bindings.some((binding) => !binding || typeof binding !== 'object' ||
    Object.keys(binding).some((key) => !['token', 'principal'].includes(key)) || typeof binding.token !== 'string' || !binding.token ||
    /\s/.test(binding.token) || !validateDto('TrustedPrincipal', binding.principal))) invalid();
  if (new Set(bindings.map((binding) => binding.token)).size !== bindings.length) invalid();
  const host = required(env, 'TRANSCRIPTION_HTTP_HOST');
  const port = p('HTTP_PORT');
  if (/[\s/]/.test(host) || port > 65535) invalid();
  const allowedHosts = jsonList(env, 'TRANSCRIPTION_ALLOWED_HOSTS_JSON');
  if (allowedHosts.some((host) => /[/?#@]/.test(host))) invalid();
  const allowedOrigins = jsonList(env, 'TRANSCRIPTION_ALLOWED_ORIGINS_JSON');
  for (const origin of allowedOrigins) {
    try { const parsed = new URL(origin); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) invalid(); }
    catch { invalid(); }
  }
  const rpc: Record<string, string> = {};
  for (const suffix of ['FRAME_BYTES', 'BATCH_ITEMS', 'CONCURRENT_REQUESTS', 'CONCURRENT_EXECUTE']) {
    const name = `TRANSCRIPTION_RPC_${suffix}`;
    positive(env, name);
    rpc[name] = required(env, name);
  }
  if (Number(rpc.TRANSCRIPTION_RPC_CONCURRENT_EXECUTE) >= Number(rpc.TRANSCRIPTION_RPC_CONCURRENT_REQUESTS)) invalid();
  if (domain.maxExecuteConcurrency > Number(rpc.TRANSCRIPTION_RPC_CONCURRENT_EXECUTE)) invalid();
  const helper = { ...rpc };
  for (const suffix of ['HOST', 'PORT', 'DATABASE', 'USER', 'PASSWORD']) helper[`PG${suffix}`] = required(env, `TRANSCRIPTION_HELPER_PG${suffix}`);
  if (!/^[0-9]+$/.test(helper.PGPORT) || Number(helper.PGPORT) < 1 || Number(helper.PGPORT) > 65535) invalid();
  for (const suffix of ['PG_POOL_MAX', 'HISTORY_CAPACITY', 'REQUEST_LEASE_MS', 'HISTORY_LEASE_MS', 'TRANSACTION_TIMEOUT_MS', 'RECOVERY_BATCH_SIZE']) {
    p(suffix, suffix.endsWith('_MS'));
    helper[`TRANSCRIPTION_${suffix}`] = required(env, `TRANSCRIPTION_${suffix}`);
  }
  const localAi = natsSettings(env, 'TRANSCRIPTION_LOCAL_AI_NATS_', true);
  const local = { ...rpc };
  if (localAi) {
    for (const suffix of ['URL', 'USER', 'PASSWORD', 'TOKEN', 'INBOX_PREFIX']) {
      const key = `TRANSCRIPTION_LOCAL_AI_NATS_${suffix}`;
      if (env[key]) local[key] = env[key]!;
    }
    for (const suffix of ['CONTROL_TIMEOUT_MS', 'HOP_TIMEOUT_MS', 'RESPONSE_BYTES']) {
      const key = `TRANSCRIPTION_LOCAL_AI_${suffix}`;
      positive(env, key, suffix.endsWith('_MS'));
      local[key] = required(env, key);
    }
  }
  return {
    domain, bindings: bindings as AuthBinding[],
    http: { host, port, allowedHosts: allowedHosts.map((host) => host.toLowerCase()), allowedOrigins,
      headerBytes: p('HTTP_HEADER_BYTES'), requestBytes: p('HTTP_REQUEST_BYTES'), responseBytes: p('HTTP_RESPONSE_BYTES'),
      requestTimeoutMs: p('HTTP_REQUEST_TIMEOUT_MS', true), maxConnections: p('HTTP_MAX_CONNECTIONS') },
    maxPublicConcurrent: p('HTTP_CONCURRENT_REQUESTS'), nats: natsSettings(env, 'TRANSCRIPTION_NATS_')!,
    natsRequestBytes: p('NATS_REQUEST_BYTES'), natsResponseBytes: p('NATS_RESPONSE_BYTES'),
    dependencyTimeoutMs: p('DEPENDENCY_REQUEST_TIMEOUT_MS', true), maxCatalogItems: p('MAX_CATALOG_ITEMS'), catalogPageSize: p('CATALOG_PAGE_SIZE'),
    rpcFrameBytes: Number(rpc.TRANSCRIPTION_RPC_FRAME_BYTES), rpcConcurrentRequests: Number(rpc.TRANSCRIPTION_RPC_CONCURRENT_REQUESTS),
    rpcControlTimeoutMs: p('RPC_CONTROL_TIMEOUT_MS', true), childShutdownTimeoutMs: p('CHILD_SHUTDOWN_TIMEOUT_MS', true),
    children: { helper, local, external: { ...rpc } }, ...(localAi ? { localAi } : {}),
    recovery: { instanceId, workerId, recoveryMaxBatches: p('RECOVERY_MAX_BATCHES'), recoveryCycleTimeoutMs: p('RECOVERY_CYCLE_TIMEOUT_MS', true),
      recoveryPollIntervalMs: p('RECOVERY_POLL_INTERVAL_MS', true), historyMaxDeliveries: p('HISTORY_MAX_DELIVERIES'),
      historyPollIntervalMs: p('HISTORY_POLL_INTERVAL_MS', true), pumpPollIntervalMs: p('PUMP_POLL_INTERVAL_MS', true) },
  };
}
