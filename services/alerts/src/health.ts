// ABOUTME: Проверяет readiness собственной БД и предсозданного JetStream durable.
// ABOUTME: Не меняет данные, не запускает consumer и закрывает собственные ресурсы.
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { config, type Config } from './config.js';
import { createPostgresStore } from './storage.js';
import { checkJetStream, connectNats } from './nats.js';

/** Проверяет БД и JetStream, не считая Service PING полной готовностью. */
export async function checkHealth(cfg: Config = config()): Promise<void> {
  const pools = [cfg.appDatabaseURL, cfg.webDatabaseURL].map(connectionString => new Pool({ connectionString, connectionTimeoutMillis: 3000, statement_timeout: 3000 }));
  let nc: Awaited<ReturnType<typeof connectNats>> | undefined;
  try { nc = await connectNats(cfg); await Promise.all([createPostgresStore(pools[0], pools[1]).ready(), checkJetStream(nc)]); }
  finally { await nc?.close(); await Promise.all(pools.map(pool => pool.end())); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await checkHealth(); console.log('service_alerts PostgreSQL and JetStream ready'); }
  catch { console.error('service_alerts PostgreSQL or JetStream unavailable'); process.exitCode = 1; }
}
