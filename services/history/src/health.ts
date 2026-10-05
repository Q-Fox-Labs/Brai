// ABOUTME: Проверяет оба PostgreSQL-пула и подключение к NATS.
// ABOUTME: Не меняет данные и не раскрывает адреса или секреты.
import { Pool } from "pg";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { limits } from "./contracts.js";
import { connectNats } from "./nats.js";
import { createPostgresStore } from "./storage.js";

/** Проверяет PostgreSQL и ответившее на PING NATS-соединение, закрывая свои ресурсы. */
export async function checkHealth(cfg = config()): Promise<void> {
  const appPool = new Pool({ connectionString: cfg.appDatabaseURL, max: limits.active, connectionTimeoutMillis: 3_000, statement_timeout: 3_000 });
  const webPool = new Pool({ connectionString: cfg.webDatabaseURL, max: limits.active, connectionTimeoutMillis: 3_000, statement_timeout: 3_000 });
  let connection: Awaited<ReturnType<typeof connectNats>> | undefined;
  try {
    connection = await connectNats(cfg);
    await Promise.all([createPostgresStore(appPool, webPool).ready(), connection.flush()]);
  } finally {
    try { await connection?.close(); } finally { await Promise.all([appPool.end(), webPool.end()]); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkHealth();
    console.log("service_history PostgreSQL and NATS ready");
  } catch {
    console.error("service_history PostgreSQL or NATS unavailable");
    process.exitCode = 1;
  }
}
