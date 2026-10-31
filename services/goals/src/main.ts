// ABOUTME: Собирает базу, NATS Service и локальный MCP сервиса целей.
// ABOUTME: Миграции и операторская подготовка запускаются отдельно.
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { createDomain } from "./domain.js";
import { startMcp } from "./mcp.js";
import { startNats } from "./nats.js";
import { startRates } from "./rates.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}
function list(name: string): string[] {
  const values = required(name).split(",").map(value => value.trim());
  if (values.some(value => !value) || new Set(values).size !== values.length) throw new Error(`INVALID_${name}`);
  return values;
}
function port(name: string): number {
  const value = required(name);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`INVALID_${name}`);
  return Number(value);
}
const config = {
  database:required("GOALS_DATABASE_URL"), servers:list("NATS_URL"), user:required("NATS_USER"), password:required("NATS_PASSWORD"),
  inbox:required("NATS_INBOX_PREFIX"), host:required("GOALS_MCP_HOST"), port:port("GOALS_MCP_PORT"), owner:required("GOALS_MCP_OWNER_ID"),
  hosts:list("GOALS_MCP_ALLOWED_HOSTS"), origins:list("GOALS_MCP_ALLOWED_ORIGINS"), token:readFileSync(required("GOALS_MCP_TOKEN_FILE"),"utf8").trim(),
};
const databaseUrl = new URL(config.database);
if (!["postgres:","postgresql:"].includes(databaseUrl.protocol)) throw new Error("INVALID_GOALS_DATABASE_URL");
for (const origin of config.origins) {const url = new URL(origin);if (!["http:","https:"].includes(url.protocol) || url.origin !== origin) throw new Error("INVALID_GOALS_MCP_ALLOWED_ORIGINS");}
for (const server of config.servers) if (!["nats:","tls:"].includes(new URL(server).protocol)) throw new Error("INVALID_NATS_URL");
if (!/^_INBOX(?:\.[A-Za-z0-9_-]+)+$/.test(config.inbox)) throw new Error("INVALID_NATS_INBOX_PREFIX");
const pool = new Pool({connectionString:config.database,max:8,connectionTimeoutMillis:3_000,statement_timeout:10_000});
pool.on("error",() => console.error(JSON.stringify({service:"service_goals",result:"database_client_error"})));
let nats: Awaited<ReturnType<typeof startNats>> | undefined;
let mcp: Awaited<ReturnType<typeof startMcp>> | undefined;
try {
  if (!(await pool.query("SELECT 1 FROM goals.migrations WHERE version=1")).rowCount) throw new Error("MIGRATION_REQUIRED");
  const domain = createDomain(pool,process.env.GOALS_BASE_CURRENCY?.trim() || "RUB");
  nats = await startNats(domain,config);
  mcp = await startMcp(domain,config);
} catch {
  await nats?.close().catch(() => {});
  await pool.end();
  console.error(JSON.stringify({service:"service_goals",result:"startup_failed"}));
  process.exit(1);
}
const stopRates = startRates(pool);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await mcp?.close(); await nats?.close(); await stopRates(); await pool.end();
}
process.once("SIGTERM",() => {void stop();});
process.once("SIGINT",() => {void stop();});
