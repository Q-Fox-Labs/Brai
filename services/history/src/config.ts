// ABOUTME: Загружает явные параметры запуска service_history.
// ABOUTME: Не подставляет адреса экземпляра и не выводит содержимое секретов.
import { readFileSync } from "node:fs";

export interface Config {
  appDatabaseURL: string;
  webDatabaseURL: string;
  cursorKey: Buffer;
  natsServers: string[];
  natsUser: string;
  natsPassword: string;
  natsInboxPrefix: string;
  mcpHost: string;
  mcpPort: number;
  mcpAllowedHosts: string[];
  mcpAllowedOrigins: string[];
  mcpMaxSessions: number;
  mcpSessionIdleMs: number;
}

type SecretReader = (path: string) => Buffer;

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const raw = required(env, name);
  if (!/^[0-9]+$/.test(raw)) throw new Error(`INVALID_${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`INVALID_${name}`);
  return value;
}

function list(env: NodeJS.ProcessEnv, name: string): string[] {
  const values = required(env, name).split(",").map(value => value.trim());
  if (values.some(value => !value) || new Set(values).size !== values.length) throw new Error(`INVALID_${name}`);
  return values;
}

function databaseURL(env: NodeJS.ProcessEnv, name: string): string {
  const raw = required(env, name);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`INVALID_${name}`); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error(`INVALID_${name}`);
  return raw;
}

/** Читает явные адреса и пределы MCP; проверяет HMAC-ключ до запуска слушателя. */
export function config(env: NodeJS.ProcessEnv = process.env, readSecret: SecretReader = path => readFileSync(path)): Config {
  const servers = list(env, "NATS_URL");
  for (const server of servers) {
    let url: URL;
    try { url = new URL(server); } catch { throw new Error("INVALID_NATS_URL"); }
    if (url.protocol !== "nats:" && url.protocol !== "tls:") throw new Error("INVALID_NATS_URL");
  }

  const inboxPrefix = required(env, "NATS_INBOX_PREFIX");
  if (!/^_INBOX(?:\.[A-Za-z0-9_-]+)+$/.test(inboxPrefix)) throw new Error("INVALID_NATS_INBOX_PREFIX");

  const cursorKeyPath = required(env, "HISTORY_CURSOR_HMAC_KEY_FILE");
  const cursorKey = readSecret(cursorKeyPath);
  if (cursorKey.byteLength < 32) throw new Error("HISTORY_CURSOR_KEY_TOO_SHORT");

  const mcpAllowedHosts = list(env, "HISTORY_MCP_ALLOWED_HOSTS");
  const mcpAllowedOrigins = list(env, "HISTORY_MCP_ALLOWED_ORIGINS");
  for (const origin of mcpAllowedOrigins) {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error("INVALID_HISTORY_MCP_ALLOWED_ORIGINS"); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) {
      throw new Error("INVALID_HISTORY_MCP_ALLOWED_ORIGINS");
    }
  }

  const mcpPort = positiveInteger(env, "HISTORY_MCP_PORT");
  if (mcpPort > 65_535) throw new Error("INVALID_HISTORY_MCP_PORT");

  return {
    appDatabaseURL: databaseURL(env, "HISTORY_APP_DATABASE_URL"),
    webDatabaseURL: databaseURL(env, "HISTORY_WEB_DATABASE_URL"),
    cursorKey,
    natsServers: servers,
    natsUser: required(env, "NATS_USER"),
    natsPassword: required(env, "NATS_PASSWORD"),
    natsInboxPrefix: inboxPrefix,
    mcpHost: required(env, "HISTORY_MCP_HOST"),
    mcpPort,
    mcpAllowedHosts,
    mcpAllowedOrigins,
    mcpMaxSessions: positiveInteger(env, "HISTORY_MCP_MAX_SESSIONS"),
    mcpSessionIdleMs: positiveInteger(env, "HISTORY_MCP_SESSION_IDLE_MS"),
  };
}
