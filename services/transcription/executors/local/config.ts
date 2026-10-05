// ABOUTME: Проверяет изолированную конфигурацию local executor до открытия NATS.
// ABOUTME: Не читает общие NATS переменные и не выводит URL или credentials.
import type { RpcServerLimits } from '../../runtime/stdio-rpc.js';

const maxTimerDelayMs = 2_147_483_647;

export type LocalAiNatsConfig = {
  servers: string[];
  inboxPrefix: string;
  user?: string;
  password?: string;
  token?: string;
};

export type LocalExecutorConfig = {
  rpc: RpcServerLimits;
  nats?: LocalAiNatsConfig;
  controlTimeoutMs?: number;
  hopTimeoutMs?: number;
  responseBytes?: number;
};

function invalidConfig(): never {
  throw new Error('INVALID_LOCAL_EXECUTOR_CONFIG');
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[key];
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) return invalidConfig();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) return invalidConfig();
  return value;
}

function parseServers(raw: string): string[] {
  const servers = raw.split(',').map((value) => value.trim());
  if (servers.some((value) => value.length === 0)) return invalidConfig();
  for (const server of servers) {
    let parsed: URL;
    try { parsed = new URL(server); } catch { return invalidConfig(); }
    if (!['nats:', 'tls:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password ||
      !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) return invalidConfig();
  }
  return servers;
}

function parseInboxPrefix(raw: string | undefined): string {
  if (!raw || /[\s*>\u0000-\u001f\u007f]/.test(raw) || raw.split('.').some((part) => part.length === 0)) return invalidConfig();
  return raw;
}

/** Читает только переменные local executor и проверяет конечные пределы до запуска RPC. */
export function loadLocalExecutorConfig(env: NodeJS.ProcessEnv = process.env): LocalExecutorConfig {
  const frameBytes = positiveInteger(env, 'TRANSCRIPTION_RPC_FRAME_BYTES');
  const batchItems = positiveInteger(env, 'TRANSCRIPTION_RPC_BATCH_ITEMS');
  const concurrentRequests = positiveInteger(env, 'TRANSCRIPTION_RPC_CONCURRENT_REQUESTS');
  const concurrentExecute = positiveInteger(env, 'TRANSCRIPTION_RPC_CONCURRENT_EXECUTE');
  if (concurrentExecute >= concurrentRequests) return invalidConfig();

  const url = env.TRANSCRIPTION_LOCAL_AI_NATS_URL;
  const user = env.TRANSCRIPTION_LOCAL_AI_NATS_USER;
  const password = env.TRANSCRIPTION_LOCAL_AI_NATS_PASSWORD;
  const token = env.TRANSCRIPTION_LOCAL_AI_NATS_TOKEN;
  const inboxPrefix = env.TRANSCRIPTION_LOCAL_AI_NATS_INBOX_PREFIX;
  const timeoutRaw = env.TRANSCRIPTION_LOCAL_AI_CONTROL_TIMEOUT_MS;
  if (url === '') return invalidConfig();
  if ((user !== undefined && user.length === 0) || (password !== undefined && password.length === 0) ||
    (token !== undefined && token.length === 0) || ((user === undefined) !== (password === undefined)) ||
    (token !== undefined && (user !== undefined || password !== undefined))) return invalidConfig();
  let nats: LocalAiNatsConfig | undefined;
  let controlTimeoutMs: number | undefined;
  let hopTimeoutMs: number | undefined;
  let responseBytes: number | undefined;
  if (url !== undefined) {
    nats = { servers: parseServers(url), inboxPrefix: parseInboxPrefix(inboxPrefix),
      ...(user !== undefined ? { user, password } : {}), ...(token !== undefined ? { token } : {}) };
    controlTimeoutMs = positiveInteger(env, 'TRANSCRIPTION_LOCAL_AI_CONTROL_TIMEOUT_MS', maxTimerDelayMs);
    hopTimeoutMs = positiveInteger(env, 'TRANSCRIPTION_LOCAL_AI_HOP_TIMEOUT_MS', maxTimerDelayMs);
    responseBytes = positiveInteger(env, 'TRANSCRIPTION_LOCAL_AI_RESPONSE_BYTES');
  } else if (user !== undefined || password !== undefined || token !== undefined || inboxPrefix !== undefined) {
    return invalidConfig();
  } else if (timeoutRaw !== undefined) {
    controlTimeoutMs = positiveInteger(env, 'TRANSCRIPTION_LOCAL_AI_CONTROL_TIMEOUT_MS', maxTimerDelayMs);
  }

  return {
    rpc: { frameBytes, batchItems, concurrentRequests, concurrentExecute },
    ...(nats ? { nats } : {}),
    ...(controlTimeoutMs !== undefined ? { controlTimeoutMs } : {}),
    ...(hopTimeoutMs !== undefined ? { hopTimeoutMs } : {}),
    ...(responseBytes !== undefined ? { responseBytes } : {}),
  };
}
