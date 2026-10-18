// ABOUTME: Собирает PostgreSQL, чистое ядро, NATS Services, MCP и outbox publisher.
// ABOUTME: Runtime не выполняет миграции и останавливает приём до закрытия ресурсов.
import { Pool } from "pg";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { ElementsFault } from "./domain.js";
import { createGameHandlers } from "./game.js";
import { createLoadGate } from "./load.js";
import { startMcp } from "./mcp.js";
import { connectNats, runNats } from "./nats.js";
import { createPostgresStore } from "./storage.js";
const cfg = config();
const pool = new Pool({ connectionString: cfg.databaseURL, max: 8, connectionTimeoutMillis: 3_000, statement_timeout: 10_000 });
pool.on("error", () => console.error(JSON.stringify({ service: "service_elements", result: "database_client_error" })));
const gate = createLoadGate(); const store = createPostgresStore(pool); const nc = await connectNats(cfg);
const handlers = createGameHandlers(pool, store, async (owner, id) => {
 const reply = await nc.request("brai.artifacts.v1.get", Buffer.from(JSON.stringify({artifactId:id})), {timeout:5000});
 if(reply.headers?.has("Nats-Service-Error"))throw new ElementsFault("NOT_FOUND");
 const artifact=JSON.parse(new TextDecoder().decode(reply.data));
 if(artifact.ownerId!==owner||artifact.status!=="ready")throw new ElementsFault("FORBIDDEN");
}, cfg.devStatusEnabled === true);
let runtime: Awaited<ReturnType<typeof runNats>> | undefined; let mcp: Awaited<ReturnType<typeof startMcp>> | undefined; let stopping = false;
try { runtime = await runNats(nc, handlers, store, cfg, gate); mcp = await startMcp(cfg, handlers, gate); console.log(JSON.stringify({ service: "service_elements", instance: runtime.service.info().id, mcp: mcp.url, result: "ready" })); } catch (error) { gate.stopAccepting(); await mcp?.close().catch(() => {}); await runtime?.stop().catch(() => {}); await gate.drain(); await nc.close(); await pool.end(); console.error(JSON.stringify({ service: "service_elements", result: "startup_failed", error: error instanceof Error ? error.name : "UNKNOWN" })); process.exitCode = 1; }
if (runtime && mcp) {
  const stop = async () => { if (stopping) return; stopping = true; gate.stopAccepting(); await mcp!.close(); await runtime!.stop(); await gate.drain(); await nc.drain(); await pool.end(); };
  process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
  await Promise.race([nc.closed(), runtime.finished]); await stop();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { /* импортируемый runtime запускается сразу по соглашению сервисов Brai */ }
