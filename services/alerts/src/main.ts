// ABOUTME: Собирает PostgreSQL, чистое ядро, JetStream и Services API уведомлений.
// ABOUTME: Runtime не выполняет DDL и завершает активные SQL операции до закрытия ресурсов.
import { Pool } from 'pg';
import { pathToFileURL } from 'node:url';
import { config, type Config } from './config.js';
import { limits, subjects } from '../contracts/index.mjs';
import { createAlertsHandlers } from './domain.js';
import { createPostgresStore } from './storage.js';
import { createLoadGate } from './load.js';
import { connectNats, runNats } from './nats.js';

/** Запускает runtime только с готовыми миграциями и предсозданным JetStream durable. */
export async function startAlertsRuntime(cfg: Config = config()) {
  const pools = [cfg.appDatabaseURL, cfg.webDatabaseURL].map(connectionString => new Pool({ connectionString, max: limits.active, connectionTimeoutMillis: 3000, statement_timeout: limits.deadlineMs }));
  for (const pool of pools) pool.on('error', () => console.error(JSON.stringify({ service: 'service_alerts', result: 'database_client_error' })));
  const gate = createLoadGate();
  let nc: Awaited<ReturnType<typeof connectNats>> | undefined;
  let runtime: Awaited<ReturnType<typeof runNats>> | undefined;
  const handlers = createAlertsHandlers(createPostgresStore(pools[0], pools[1]), { cursorKey: cfg.cursorKey, changed(user_id) { nc!.publish(subjects.changed, Buffer.from(JSON.stringify({ user_id }))); } });
  const closePools = () => Promise.all(pools.map(pool => pool.end()));
  try { nc = await connectNats(cfg); runtime = await runNats(nc, handlers, gate); }
  catch (error) { gate.stopAccepting(); await runtime?.stop().catch(() => {}); await gate.drain(); await nc?.close().catch(() => {}); await closePools(); throw error; }
  let stopping: Promise<void> | undefined;
  return { handlers, gate, connection: nc, service: runtime.service, finished: runtime.finished,
    stop() { return stopping ??= (async () => { gate.stopAccepting(); try { await runtime!.stop(); } finally { await gate.drain(); try { await nc!.drain(); } finally { await closePools(); } } })(); },
  };
}
async function runProcess(): Promise<void> {
  const runtime = await startAlertsRuntime();
  console.log(JSON.stringify({ service: 'service_alerts', instance: runtime.service.info().id, result: 'ready' }));
  const signaled = new Promise<void>(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  try { await Promise.race([runtime.connection.closed(), runtime.finished, signaled]); }
  finally { await runtime.stop(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runProcess(); }
  catch { console.error(JSON.stringify({ service: 'service_alerts', result: 'runtime_failed' })); process.exitCode = 1; }
}
