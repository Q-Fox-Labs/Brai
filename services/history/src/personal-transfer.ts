// ABOUTME: Выполняет операторские фазы переноса History только от владельца БД.
// ABOUTME: Назначает защищённое чтение, сохраняя исходные события, даты и JSONB-числа.
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";

type Row = { source: string; id: string; rowSha256: string; personal: boolean };
type Assignment = { source: string; id: string; scopeId: string; proofSha256: string };
type Binding = Row & { scopeId: string | null; proofSha256: string | null };
export type Inventory = { version: 1; service: "history"; sourceHash: string; rows: Row[] };
export type TransferPlan = { version: 1; service: "history"; id: string; sourceHash: string; rows: Binding[]; planHash: string };
type PlanInput = { id: string; sourceHash: string; assignments: Assignment[] };
const hex = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const scope = /^brai-personal-v1:[a-f0-9]{64}$/, source = /^[a-z][a-z0-9_]{0,63}$/;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const key = (row: { source: string; id: string }) => row.source + ":" + row.id;
function requireValue(value: unknown, code = "HISTORY_TRANSFER_INVALID"): asserts value {
  if (!value) throw new Error(code);
}
function fields(value: unknown, names: string[]): asserts value is Record<string, any> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
  requireValue(Object.keys(value).sort().join(",") === [...names].sort().join(","));
}
function validRow(value: unknown): asserts value is Row {
  fields(value, ["source", "id", "rowSha256", "personal"]);
  requireValue(typeof value.source === "string" && source.test(value.source) &&
    typeof value.id === "string" && uuid.test(value.id) &&
    typeof value.rowSha256 === "string" && hex.test(value.rowSha256) && typeof value.personal === "boolean");
}
async function snapshot(client: PoolClient): Promise<Inventory> {
  // JSONB остаётся внутри PostgreSQL. Node получает только ключи и SHA256 исходной строки.
  const rows = (await client.query<Row>("SELECT e.source,e.id::text,encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex') AS \"rowSha256\", " +
    "e.scope_id ~ '^brai-personal-v1:[a-f0-9]{64}$' AS personal FROM history.events e ORDER BY e.source COLLATE \"C\",e.id LIMIT 100001")).rows;
  requireValue(rows.length <= 100000, "HISTORY_TRANSFER_INVENTORY_LIMIT");
  rows.forEach(validRow);
  return { version: 1, service: "history", sourceHash: hash(rows), rows };
}
function validateInventory(value: Inventory) {
  fields(value, ["version", "service", "sourceHash", "rows"]);
  requireValue(value.version === 1 && value.service === "history" && Array.isArray(value.rows) && value.rows.length <= 100000);
  value.rows.forEach(validRow);
  requireValue(value.sourceHash === hash(value.rows) && new Set(value.rows.map(key)).size === value.rows.length);
}
/** Принимает только хеш уже просмотренного снимка и внешние проверенные доказательства. */
export function planTransfer(inventory: Inventory, input: PlanInput): TransferPlan {
  validateInventory(inventory);
  fields(input, ["id", "sourceHash", "assignments"]);
  requireValue(typeof input.id === "string" && uuid.test(input.id) && input.sourceHash === inventory.sourceHash &&
    Array.isArray(input.assignments) && input.assignments.length <= inventory.rows.length);
  requireValue(inventory.rows.every(row => !row.personal), "HISTORY_TRANSFER_ALREADY_PERSONAL");
  const assignments = new Map<string, Assignment>(), existing = new Set(inventory.rows.map(key));
  for (const row of input.assignments) {
    fields(row, ["source", "id", "scopeId", "proofSha256"]);
    requireValue(typeof row.source === "string" && source.test(row.source) && typeof row.id === "string" && uuid.test(row.id) &&
      typeof row.scopeId === "string" && scope.test(row.scopeId) && typeof row.proofSha256 === "string" && hex.test(row.proofSha256) &&
      existing.has(key(row)) && !assignments.has(key(row)));
    assignments.set(key(row), row);
  }
  const rows = inventory.rows.map(row => ({ ...row, scopeId: assignments.get(key(row))?.scopeId ?? null,
    proofSha256: assignments.get(key(row))?.proofSha256 ?? null }));
  const value = { version: 1 as const, service: "history" as const, id: input.id, sourceHash: inventory.sourceHash, rows };
  return { ...value, planHash: hash(value) };
}
function validatePlan(plan: TransferPlan): TransferPlan {
  fields(plan, ["version", "service", "id", "sourceHash", "rows", "planHash"]);
  requireValue(plan.version === 1 && plan.service === "history" && Array.isArray(plan.rows));
  for (const row of plan.rows) {
    fields(row, ["source", "id", "rowSha256", "personal", "scopeId", "proofSha256"]);
    requireValue((row.scopeId === null && row.proofSha256 === null) ||
      typeof row.scopeId === "string" && scope.test(row.scopeId) && typeof row.proofSha256 === "string" && hex.test(row.proofSha256));
  }
  const inventory: Inventory = { version: 1, service: "history", sourceHash: plan.sourceHash,
    rows: plan.rows.map(({ source, id, rowSha256, personal }) => ({ source, id, rowSha256, personal })) };
  const expected = planTransfer(inventory, { id: plan.id, sourceHash: plan.sourceHash,
    assignments: plan.rows.filter(row => row.scopeId !== null).map(row => ({ source: row.source, id: row.id,
      scopeId: row.scopeId!, proofSha256: row.proofSha256! })) });
  requireValue(expected.planHash === plan.planHash, "HISTORY_TRANSFER_PLAN_DRIFT");
  return plan;
}
const balance = (plan: TransferPlan) => ({ sourceRows: plan.rows.length,
  assigned: plan.rows.filter(row => row.scopeId !== null).length, archived: plan.rows.filter(row => row.scopeId === null).length });
async function verify(client: PoolClient, plan: TransferPlan, rolledBack = false) {
  requireValue((await snapshot(client)).sourceHash === plan.sourceHash, "HISTORY_TRANSFER_SOURCE_CHANGED");
  const batch = (await client.query("SELECT source_hash,plan_hash,state FROM history.personal_transfers WHERE id=$1", [plan.id])).rows[0];
  requireValue(batch?.source_hash === plan.sourceHash && batch.plan_hash === plan.planHash &&
    batch.state === (rolledBack ? "rolled_back" : "applied"), "HISTORY_TRANSFER_RECEIPT_CHANGED");
  const rows = (await client.query("SELECT source,id::text,row_sha256,scope_id,proof_sha256 FROM history.personal_event_bindings WHERE transfer_id=$1 ORDER BY source COLLATE \"C\",id", [plan.id])).rows;
  const expected = rolledBack ? [] : plan.rows.map(row => ({ source: row.source, id: row.id,
    row_sha256: row.rowSha256, scope_id: row.scopeId, proof_sha256: row.proofSha256 }));
  requireValue(JSON.stringify(rows) === JSON.stringify(expected), "HISTORY_TRANSFER_BINDINGS_CHANGED");
  return { state: rolledBack ? "rolled_back" : "verified", service: "history", id: plan.id, planHash: plan.planHash, ...balance(plan) };
}
/** DB owner вызывается оператором при закрытом входе; API/NATS/MCP эти фазы не публикуют. */
export async function runPersonalTransfer(pool: Pool, ownerRole: string,
  phase: "inventory" | "plan" | "apply" | "verify" | "rollback", input?: PlanInput | TransferPlan): Promise<unknown> {
  requireValue(["inventory", "plan", "apply", "verify", "rollback"].includes(phase));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='60000ms'; SET LOCAL TIME ZONE 'UTC'");
    const owner = (await client.query("SELECT current_user AS role,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()")).rows[0];
    requireValue(ownerRole && owner?.role === ownerRole && owner.owner === ownerRole, "HISTORY_TRANSFER_REQUIRES_DATABASE_OWNER");
    if (phase !== "inventory" && phase !== "plan") {
      await client.query("SELECT pg_advisory_xact_lock(70482318,3)");
      await client.query("LOCK TABLE history.events,history.personal_transfers,history.personal_event_bindings IN SHARE ROW EXCLUSIVE MODE");
    }
    let result: unknown;
    if (phase === "inventory" || phase === "plan") {
      const current = await snapshot(client);
      result = phase === "inventory" ? current : planTransfer(current, input as PlanInput);
    } else {
      const plan = validatePlan(input as TransferPlan);
      requireValue((await snapshot(client)).sourceHash === plan.sourceHash, "HISTORY_TRANSFER_SOURCE_CHANGED");
      const existing = (await client.query("SELECT state,plan_hash,source_hash FROM history.personal_transfers WHERE id=$1 FOR UPDATE", [plan.id])).rows[0];
      if (phase === "apply") {
        if (!existing) {
          await client.query("INSERT INTO history.personal_transfers(id,source_hash,plan_hash,state) VALUES($1,$2,$3,'applied')",
            [plan.id, plan.sourceHash, plan.planHash]);
          await client.query("INSERT INTO history.personal_event_bindings(source,id,transfer_id,row_sha256,scope_id,proof_sha256) " +
            "SELECT r.source,r.id::uuid,$1,r.\"rowSha256\",r.\"scopeId\",r.\"proofSha256\" " +
            "FROM jsonb_to_recordset($2::jsonb) AS r(source text,id text,\"rowSha256\" text,\"scopeId\" text,\"proofSha256\" text)",
            [plan.id, JSON.stringify(plan.rows)]);
        }
        result = await verify(client, plan);
      } else if (phase === "verify") {
        result = await verify(client, plan);
      } else {
        // После любой новой записи этот sourceHash уже не совпадает: возврат запрещён.
        if (existing?.state !== "rolled_back") {
          await verify(client, plan);
          await client.query("DELETE FROM history.personal_event_bindings WHERE transfer_id=$1", [plan.id]);
          await client.query("UPDATE history.personal_transfers SET state='rolled_back',rolled_back_at=clock_timestamp() WHERE id=$1", [plan.id]);
        }
        result = await verify(client, plan, true);
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error instanceof Error && /^HISTORY_TRANSFER_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error("HISTORY_TRANSFER_DATABASE_REFUSED");
  } finally { client.release(); }
}
function inputFile(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    requireValue(info.isFile() && info.nlink === 1 && info.uid === process.getuid?.() &&
      !(info.mode & 0o077) && info.size <= 32 * 1024 * 1024, "HISTORY_TRANSFER_PRIVATE_INPUT_REQUIRED");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [phase, input, output] = process.argv.slice(2);
  const url = process.env.HISTORY_OWNER_DATABASE_URL, owner = process.env.HISTORY_OWNER_ROLE;
  requireValue(url && owner && output && (phase === "inventory" || input), "HISTORY_TRANSFER_CLI_INPUT_REQUIRED");
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, max: 1 });
  try {
    const value = await runPersonalTransfer(pool, owner, phase as Parameters<typeof runPersonalTransfer>[2],
      phase === "inventory" ? undefined : inputFile(input) as PlanInput | TransferPlan);
    // Выход содержит только ключи, хеши и назначения; событие/data через Node не проходит.
    writeFileSync(output, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ state: "completed", service: "history", phase }));
  } catch (error) {
    console.error(error instanceof Error && /^HISTORY_TRANSFER_[A-Z_]+$/.test(error.message) ? error.message : "HISTORY_TRANSFER_REFUSED");
    process.exitCode = 1;
  } finally { await pool.end(); }
}
