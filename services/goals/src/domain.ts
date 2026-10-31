// ABOUTME: Выполняет операции целей в транзакции владельца.
// ABOUTME: Не зависит от HTTP, MCP или NATS и сохраняет предыдущую версию.
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type Entity = "goals" | "focus" | "entries" | "resources" | "needs" | "allocations";
type Row = Record<string, unknown>;
const fields: Record<Entity, readonly string[]> = {
  goals: ["title", "meaning", "achievement", "due_on", "status", "next_step", "executor", "archived", "deleted"],
  focus: ["goal_id", "reason"],
  entries: ["goal_id", "kind", "content", "occurred_on", "pinned", "deleted"],
  resources: ["title", "purpose", "kind", "category", "state", "amount", "unit", "currency", "expires_on", "deleted"],
  needs: ["goal_id", "title", "kind", "amount", "unit", "currency", "state", "deleted"],
  allocations: ["need_id", "resource_id", "amount", "active", "deleted"],
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decimals = /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,12})?$/;

export class GoalsFault extends Error {
  constructor(public readonly code: string) { super(code); }
}

function normalize(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, value instanceof Date ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}` : value],
  ));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const object = value as Row;
    return "{" + Object.keys(object).sort().map(key => JSON.stringify(key) + ":" + stable(object[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function validateEntity(entity: string): asserts entity is Entity {
  if (!Object.hasOwn(fields, entity)) throw new GoalsFault("INVALID_ARGUMENT");
}
function validateData(entity: Entity, value: Row): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) throw new GoalsFault("INVALID_ARGUMENT");
  for (const [key, item] of Object.entries(value)) {
    if (!fields[entity].includes(key)) throw new GoalsFault("INVALID_ARGUMENT");
    if (item !== null && !["string", "boolean"].includes(typeof item)) throw new GoalsFault("INVALID_ARGUMENT");
    if (typeof item === "string" && item.length > 16_000) throw new GoalsFault("INVALID_ARGUMENT");
    if (!["archived", "pinned", "active", "deleted"].includes(key) && item !== null && typeof item !== "string") throw new GoalsFault("INVALID_ARGUMENT");
    if (["amount"].includes(key) && item !== null && (typeof item !== "string" || !decimals.test(item))) throw new GoalsFault("INVALID_ARGUMENT");
    if (["goal_id", "need_id", "resource_id"].includes(key) && item !== null && (typeof item !== "string" || !uuid.test(item))) throw new GoalsFault("INVALID_ARGUMENT");
    if (["archived", "pinned", "active", "deleted"].includes(key) && typeof item !== "boolean") throw new GoalsFault("INVALID_ARGUMENT");
    if (["occurred_on", "due_on", "expires_on"].includes(key) && item !== null && (typeof item !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item))) throw new GoalsFault("INVALID_ARGUMENT");
    if (key === "currency" && item !== null && (typeof item !== "string" || !/^[A-Z0-9]{3,12}$/.test(item))) throw new GoalsFault("INVALID_ARGUMENT");
  }
}
function fault(error: unknown): never {
  if (error instanceof GoalsFault) throw error;
  const code = (error as { code?: string }).code;
  if (code === "23503") throw new GoalsFault("NOT_FOUND");
  if (code === "23505") throw new GoalsFault("CONFLICT");
  if (["23502", "23514", "22P02", "22007", "22008", "22003"].includes(code ?? "")) throw new GoalsFault("INVALID_ARGUMENT");
  throw error;
}
async function verifyReservations(client: PoolClient, owner: string): Promise<void> {
  const invalid = await client.query(`
    SELECT 1 FROM goals.allocations a
    JOIN goals.resources r ON r.owner_id=a.owner_id AND r.id=a.resource_id
    JOIN goals.needs n ON n.owner_id=a.owner_id AND n.id=a.need_id
    WHERE a.owner_id=$1 AND a.active AND
      (a.deleted OR r.deleted OR n.deleted OR r.kind='liability' OR r.kind<>n.kind OR
       (r.kind='money' AND r.currency<>n.currency) OR
       (r.kind='quantity' AND r.unit<>n.unit) OR
       (r.kind='qualitative' AND (a.amount IS NOT NULL OR r.state<>'available')) OR
       (r.kind IN ('money','quantity') AND a.amount IS NULL))
    LIMIT 1`, [owner]);
  if (invalid.rowCount) throw new GoalsFault("CONFLICT");
  const over = await client.query(`
    SELECT 1 FROM goals.resources r JOIN goals.allocations a
      ON a.owner_id=r.owner_id AND a.resource_id=r.id AND a.active
    WHERE r.owner_id=$1 AND r.kind IN ('money','quantity')
    GROUP BY r.owner_id,r.id,r.amount HAVING r.amount IS NULL OR SUM(a.amount)>r.amount LIMIT 1`, [owner]);
  if (over.rowCount) throw new GoalsFault("CONFLICT");
  const hiddenFocus = await client.query("SELECT 1 FROM goals.focus f JOIN goals.goals g ON g.owner_id=f.owner_id AND g.id=f.goal_id WHERE f.owner_id=$1 AND g.deleted LIMIT 1",[owner]);
  if (hiddenFocus.rowCount) throw new GoalsFault("CONFLICT");
}

/** Предоставляет изолированные чтения и атомарные изменения с историей. */
export function createDomain(pool: Pool, baseCurrency = "RUB") {
  if (!/^[A-Z0-9]{3,12}$/.test(baseCurrency)) throw new Error("INVALID_GOALS_BASE_CURRENCY");
  return {
    async overview(owner: string): Promise<Row> {
      if (!owner) throw new GoalsFault("FORBIDDEN");
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const result: Row = {base_currency:baseCurrency};
        for (const entity of ["goals","focus","entries","resources","needs","allocations"] as const) {
          const rows = (await client.query(`SELECT * FROM goals.${entity} WHERE owner_id=$1 ORDER BY id`, [owner])).rows.map(normalize);
          result[entity] = entity === "focus" ? rows[0] ?? null : rows;
        }
        result.rates = (await client.query("SELECT * FROM goals.exchange_rates ORDER BY currency")).rows;
        result.need_balances = (await client.query(`
          SELECT n.id,n.kind,n.amount::text AS needed,
            CASE WHEN n.kind='qualitative' THEN NULL ELSE COALESCE(SUM(a.amount),0)::text END AS allocated,
            CASE WHEN n.kind='qualitative' OR n.amount IS NULL THEN NULL ELSE GREATEST(n.amount-COALESCE(SUM(a.amount),0),0)::text END AS shortage,
            COUNT(a.id)::int AS allocations
          FROM goals.needs n LEFT JOIN goals.allocations a ON a.owner_id=n.owner_id AND a.need_id=n.id AND a.active
          WHERE n.owner_id=$1 GROUP BY n.owner_id,n.id ORDER BY n.id`, [owner])).rows;
        result.resource_balances = (await client.query(`
          SELECT r.id,
            CASE WHEN r.kind IN ('money','quantity') THEN COALESCE(SUM(a.amount),0)::text ELSE NULL END AS reserved,
            CASE WHEN r.kind NOT IN ('money','quantity') OR r.amount IS NULL THEN NULL
              ELSE (r.amount-COALESCE(SUM(a.amount),0))::text END AS available
          FROM goals.resources r LEFT JOIN goals.allocations a ON a.owner_id=r.owner_id AND a.resource_id=r.id AND a.active
          WHERE r.owner_id=$1 GROUP BY r.owner_id,r.id ORDER BY r.id`, [owner])).rows;
        result.valuation = (await client.query(`
          WITH base AS (
            SELECT CASE WHEN $2='RUB' THEN 1::numeric
              ELSE (SELECT rate/nominal FROM goals.exchange_rates WHERE currency=$2) END AS rate
          ), valued AS (
            SELECT r.category,
              CASE WHEN r.amount IS NULL OR base.rate IS NULL THEN NULL
                WHEN r.currency='RUB' THEN r.amount/base.rate
                WHEN er.rate IS NOT NULL THEN r.amount*(er.rate/er.nominal)/base.rate
                ELSE NULL END AS estimate
            FROM goals.resources r CROSS JOIN base LEFT JOIN goals.exchange_rates er ON er.currency=r.currency
            WHERE r.owner_id=$1 AND NOT r.deleted AND r.kind IN ('money','liability')
          )
          SELECT category,SUM(estimate)::text AS estimated_total,COUNT(*)::int AS items,
            COUNT(*) FILTER (WHERE estimate IS NULL)::int AS missing
          FROM valued GROUP BY category ORDER BY category`, [owner,baseCurrency])).rows;
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {client.release();}
    },
    async list(owner: string, entity: string): Promise<Row[]> {
      validateEntity(entity);
      if (!owner) throw new GoalsFault("FORBIDDEN");
      return (await pool.query(`SELECT * FROM goals.${entity} WHERE owner_id=$1 ORDER BY id`, [owner])).rows.map(normalize);
    },
    async history(owner: string, entity: string, id: string): Promise<Row[]> {
      validateEntity(entity);
      if (!owner || !uuid.test(id)) throw new GoalsFault("INVALID_ARGUMENT");
      return (await pool.query("SELECT * FROM goals.history WHERE owner_id=$1 AND entity_type=$2 AND entity_id=$3 ORDER BY version DESC", [owner, entity, id])).rows;
    },
    async change(owner: string, actor: string, source: string, requestId: string, entity: string, id: string, expectedVersion: string | null, data: Row, intent = "change"): Promise<Row> {
      validateEntity(entity);
      if (!owner || !actor || !source || source.length > 16_000 || !uuid.test(requestId) || !uuid.test(id) || (expectedVersion !== null && !/^[1-9][0-9]*$/.test(expectedVersion))) throw new GoalsFault("INVALID_ARGUMENT");
      validateData(entity, data);
      const hash = createHash("sha256").update(stable({ actor, source, entity, id, expectedVersion, data, intent })).digest("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [owner]);
        const saved = (await client.query("SELECT request_hash,response FROM goals.requests WHERE owner_id=$1 AND request_id=$2", [owner,requestId])).rows[0];
        if (saved) {
          if (saved.request_hash !== hash) throw new GoalsFault("CONFLICT");
          await client.query("COMMIT");
          return saved.response;
        }
        const found = (await client.query(`SELECT * FROM goals.${entity} WHERE owner_id=$1 AND id=$2 FOR UPDATE`, [owner,id])).rows[0] as Row | undefined;
        const old = found && normalize(found);
        if (expectedVersion === null ? !!old : !old || old.version !== expectedVersion) throw new GoalsFault("CONFLICT");
        const keys = Object.keys(data), values = keys.map(key => data[key]);
        let current: Row;
        if (!old) {
          const columns = ["owner_id","id",...keys];
          current = (await client.query(`INSERT INTO goals.${entity} (${columns.join(",")}) VALUES (${columns.map((_, index) => "$" + (index + 1)).join(",")}) RETURNING *`, [owner,id,...values])).rows[0];
        } else {
          const assignments = keys.map((key,index) => `${key}=$${index + 3}`);
          current = (await client.query(`UPDATE goals.${entity} SET ${assignments.join(",")}, version=version+1 WHERE owner_id=$1 AND id=$2 RETURNING *`, [owner,id,...values])).rows[0];
        }
        current = normalize(current);
        await verifyReservations(client, owner);
        await client.query("INSERT INTO goals.history(owner_id,id,entity_type,entity_id,version,actor,source,previous,current) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [owner,randomUUID(),entity,id,current.version,actor,source,old ? JSON.stringify(old) : null,JSON.stringify(current)]);
        await client.query("INSERT INTO goals.requests(owner_id,request_id,request_hash,response) VALUES($1,$2,$3,$4)", [owner,requestId,hash,JSON.stringify(current)]);
        await client.query("COMMIT");
        return current;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return fault(error);
      } finally {
        client.release();
      }
    },
    async restore(owner: string, actor: string, source: string, requestId: string, entity: string, id: string, expectedVersion: string, targetVersion: string): Promise<Row> {
      validateEntity(entity);
      if (!owner || !uuid.test(id) || !/^[1-9][0-9]*$/.test(targetVersion)) throw new GoalsFault("INVALID_ARGUMENT");
      const record = (await pool.query("SELECT current FROM goals.history WHERE owner_id=$1 AND entity_type=$2 AND entity_id=$3 AND version=$4", [owner,entity,id,targetVersion])).rows[0];
      if (!record) throw new GoalsFault("NOT_FOUND");
      const data: Row = {};
      for (const field of fields[entity]) if (Object.hasOwn(record.current, field)) data[field] = record.current[field];
      return this.change(owner, actor, source, requestId, entity, id, expectedVersion, data, `restore:${targetVersion}`);
    },
  };
}
