// ABOUTME: Собирает пулы, хранилище, ядро, NATS Service и MCP в один процесс.
// ABOUTME: Останавливает оба адаптера до drain и закрывает только ресурсы процесса.
import { Pool } from "pg";
import { pathToFileURL } from "node:url";
import { config, type Config } from "./config.js";
import { limits } from "./contracts.js";
import { createHistoryHandlers, type HistoryHandlers } from "./domain.js";
import { createLoadGate, type LoadGate } from "./load.js";
import { connectNats, runElementsEvents, runNats } from "./nats.js";
import { createPostgresStore } from "./storage.js";
import { startMcp, type McpRuntime } from "./mcp.js";
import type { NatsConnection, Service } from "nats";

/** Общий runtime обоих транспортов поверх одного ядра, gate и пары пулов. */
export interface HistoryRuntime {
  /** Прикладные операции, общие для NATS Services и MCP. */
  handlers: HistoryHandlers;
  /** Единая очередь и предел активных операций для обоих адаптеров. */
  gate: LoadGate;
  /** NATS connection, закрываемый только после остановки приёма и drain. */
  connection: NatsConnection;
  /** NATS Service, обслуживающий запись и web-чтение. */
  service: Service;
  /** MCP listener и его сессии; не владеет ядром или пулами. */
  mcp: McpRuntime;
  /** Закрывает приём обоих адаптеров, ожидает drain и освобождает пулы. */
  stop(): Promise<void>;
}

/** Проверяет БД, запускает NATS и MCP, затем возвращает общее управление runtime. */
export async function startHistoryRuntime(cfg: Config = config()): Promise<HistoryRuntime> {
  const appPool = new Pool({ connectionString: cfg.appDatabaseURL, max: limits.active, connectionTimeoutMillis: 3_000, statement_timeout: limits.deadlineMs });
  const webPool = new Pool({ connectionString: cfg.webDatabaseURL, max: limits.active, connectionTimeoutMillis: 3_000, statement_timeout: limits.deadlineMs });
  appPool.on("error", () => console.error("history app database client error"));
  webPool.on("error", () => console.error("history web database client error"));

  const gate = createLoadGate();
  const store = createPostgresStore(appPool, webPool);
  const handlers = createHistoryHandlers(store, { cursorKey: cfg.cursorKey });
  let connection: NatsConnection | undefined;
  let service: Service | undefined;
  let mcp: McpRuntime | undefined;
  let elementsEvents: Awaited<ReturnType<typeof runElementsEvents>> | undefined;
  let stopping: Promise<void> | undefined;

  const closePools = () => Promise.all([appPool.end(), webPool.end()]).then(() => undefined);
  try {
    connection = await connectNats(cfg);
    const runtime = await runNats(connection, handlers, gate);
    service = runtime.service;
    if (cfg.elementsEventsEnabled) elementsEvents = await runElementsEvents(connection, handlers, gate);
    mcp = await startMcp(cfg, handlers, gate);
  } catch (error) {
    gate.stopAccepting();
    try { await mcp?.close(); } catch {}
    try { await service?.stop(); } catch {}
    try { await elementsEvents?.stop(); } catch {}
    try { await connection?.drain(); } catch {}
    await gate.drain();
    await closePools();
    throw error;
  }

  return {
    handlers,
    gate,
    connection,
    service,
    mcp,
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        gate.stopAccepting();
        try {
          await Promise.all([service?.stop(), mcp?.close()]);
          await elementsEvents?.stop();
        }
        finally {
          await gate.drain();
          try { await connection?.drain(); }
          finally { await closePools(); }
        }
      })();
      return stopping;
    },
  };
}

async function runProcess(): Promise<void> {
  const runtime = await startHistoryRuntime();
  console.log(JSON.stringify({ service: "service_history", instance: runtime.service.info().id, result: "ready" }));
  let signalStop = false;
  const stoppedBySignal = new Promise<void>(resolve => {
    const stop = () => { signalStop = true; resolve(); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await Promise.race([runtime.connection.closed(), stoppedBySignal]);
  if (signalStop) console.log(JSON.stringify({ service: "service_history", result: "stopping" }));
  await runtime.stop();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runProcess();
  } catch (error) {
    console.error(JSON.stringify({ service: "service_history", result: "startup_failed", error: error instanceof Error ? error.name : "UNKNOWN" }));
    process.exitCode = 1;
  }
}
