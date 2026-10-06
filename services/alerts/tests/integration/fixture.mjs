// ABOUTME: Подключает только явно разрешённый disposable loopback стенд alerts.
// ABOUTME: Не читает .env и запрещает адреса либо имена БД production.
import { Pool } from 'pg';
import { connect } from 'nats';
import { createAlertsHandlers } from '../../dist/domain.js';
import { createPostgresStore } from '../../dist/storage.js';
import { migrate } from '../../dist/migrate.js';

export const configured = !!process.env.ALERTS_TEST_OWNER_DATABASE_URL;
export const brokerConfigured = configured && !!process.env.ALERTS_TEST_NATS_URL;
export const roles = ['OWNER', 'APP', 'WEB'].map(name => process.env[`ALERTS_TEST_${name}_ROLE`]);
/** Разрешает тестовые подключения только в выделенную локальную БД. */
export function database(name) {
  const value = process.env[`ALERTS_TEST_${name}_DATABASE_URL`];
  if (!value) throw new Error(`MISSING_ALERTS_TEST_${name}_DATABASE_URL`);
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/brai_alerts_test' || !['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DISPOSABLE_DATABASE_REQUIRED');
  return new Pool({ connectionString: value, connectionTimeoutMillis: 2000, statement_timeout: 10_000, max: 8 });
}
/** Создаёт готовые owner и runtime пулы без автоматического создания PostgreSQL-ролей. */
export async function setup(changed) {
  const owner = database('OWNER'), app = database('APP'), web = database('WEB');
  await migrate(owner, ...roles);
  const handlers = createAlertsHandlers(createPostgresStore(app, web), { cursorKey: Buffer.alloc(32, 7), changed });
  return { owner, app, web, handlers, async cleanup() { await owner.query('TRUNCATE alerts.read_marks,alerts.notifications'); }, async close() { await Promise.all([owner.end(), app.end(), web.end()]); } };
}
/** Подключает тестовую broker identity с собственным inbox. */
export function broker(identity = 'fixture') {
  const server = process.env.ALERTS_TEST_NATS_URL;
  const url = new URL(server);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('DISPOSABLE_BROKER_REQUIRED');
  return connect({ servers: server, user: identity === 'alerts' ? (process.env.ALERTS_TEST_NATS_USER ?? 'alerts') : identity, pass: process.env.ALERTS_TEST_NATS_PASSWORD ?? 'alerts-test', inboxPrefix: identity === 'alerts' ? '_INBOX.brai_alerts' : identity === 'web' ? '_INBOX.brai_web' : identity === 'publisher' ? '_INBOX.brai_alerts_publisher' : '_INBOX.brai_alerts_fixture', timeout: 2000 });
}
/** Ожидает наблюдаемое условие, не заменяя его фиксированной задержкой. */
export async function eventually(work, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await work()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('CONDITION_NOT_REACHED');
}
