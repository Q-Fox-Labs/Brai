// ABOUTME: Читает явные параметры runtime уведомлений без адресов экземпляра по умолчанию.
// ABOUTME: Owner-реквизиты отсутствуют в runtime, секреты не выводятся.
import { readFileSync } from 'node:fs';

export interface Config { appDatabaseURL: string; webDatabaseURL: string; cursorKey: Buffer; natsServers: string[]; natsUser: string; natsPassword: string; natsInboxPrefix: string; elementsEventsEnabled: boolean }
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}
function databaseURL(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!['postgres:', 'postgresql:'].includes(new URL(value).protocol)) throw new Error(`INVALID_${name}`);
  return value;
}
function flag(env: NodeJS.ProcessEnv, name: string): boolean { const value = (env[name] ?? "false").trim().toLowerCase(); if (!["true", "false"].includes(value)) throw new Error(`INVALID_${name}`); return value === "true"; }
/** Проверяет параметры и ключ до подключения к БД и брокеру. */
export function config(env: NodeJS.ProcessEnv = process.env, readSecret: (path: string) => Buffer = readFileSync): Config {
  const natsServers = required(env, 'NATS_URL').split(',').map(s => s.trim());
  if (natsServers.some(s => !s || !['nats:', 'tls:'].includes(new URL(s).protocol))) throw new Error('INVALID_NATS_URL');
  const natsInboxPrefix = required(env, 'NATS_INBOX_PREFIX');
  if (!/^_INBOX(?:\.[A-Za-z0-9_-]+)+$/.test(natsInboxPrefix)) throw new Error('INVALID_NATS_INBOX_PREFIX');
  const cursorKey = readSecret(required(env, 'ALERTS_CURSOR_HMAC_KEY_FILE'));
  if (cursorKey.length < 32) throw new Error('ALERTS_CURSOR_KEY_TOO_SHORT');
  const appDatabaseURL = databaseURL(env, 'ALERTS_APP_DATABASE_URL'), webDatabaseURL = databaseURL(env, 'ALERTS_WEB_DATABASE_URL');
  if (decodeURIComponent(new URL(appDatabaseURL).username) === decodeURIComponent(new URL(webDatabaseURL).username)) throw new Error('ALERTS_RUNTIME_ROLES_MUST_DIFFER');
  return { appDatabaseURL, webDatabaseURL, cursorKey, natsServers, natsUser: required(env, 'NATS_USER'), natsPassword: required(env, 'NATS_PASSWORD'), natsInboxPrefix, elementsEventsEnabled: flag(env, 'ALERTS_ELEMENTS_EVENTS_ENABLED') };
}
