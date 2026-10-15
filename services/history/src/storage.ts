// ABOUTME: Реализует транзакционный порт истории в PostgreSQL.
// ABOUTME: Веб-чтения используют отдельный пул и только локальный RLS-контекст.
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { checkContext, HistoryFault, type HistoryStore, type HistoryTransaction, type OperationContext, type CatalogRow, type EventInput, type EventKey, type Filters, type EventType } from "./domain.js";
import type { HistoryEvent } from "./contracts.js";

const eventFields = `e.id,e.source,e.type_id,
 to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
 to_char(e.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at,
 e.actor_id,e.scope_type,e.scope_id,e.object_type,e.object_id,e.data`;
function failure(error: unknown): Error {
  if (error instanceof HistoryFault) return error;
  const code = (error as { code?: string })?.code ?? "";
  if (code === "57014") return new HistoryFault("DEADLINE_EXCEEDED");
  if (code.startsWith("22") || ["23502", "23503", "23505", "23514"].includes(code)) return new HistoryFault("INVALID_ARGUMENT");
  if (code.startsWith("08") || code.startsWith("ECONN") || ["57P01", "57P02", "57P03", "53300", "ETIMEDOUT", "ENOTFOUND", "EPIPE"].includes(code) || /connection|connect|timeout exceeded when trying to connect/i.test((error as Error)?.message ?? "")) return new HistoryFault("DATABASE_UNAVAILABLE");
  return new HistoryFault("INTERNAL");
}
function transactionPort(client: PoolClient, context: OperationContext) {
  async function query<R extends QueryResultRow = any>(sql: string, values: unknown[] = []): Promise<QueryResult<R>> {
    checkContext(context);
    // AIDEV-NOTE: pg не принимает AbortSignal; SQL сам прекращается по оставшемуся сроку, затем transaction ждёт rollback.
    await client.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.max(1, Math.floor(context.deadlineAt - performance.now())))]);
    checkContext(context);
    return client.query<R>(sql, values);
  }
  const tx: HistoryTransaction = {
    async lockEvent(source, id) {
      await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 70482318))", [source + ":" + id]);
    },
    async event(source, id) {
      return (await query<HistoryEvent>(`SELECT ${eventFields} FROM history.events e WHERE e.source=$1 AND e.id=$2`, [source, id])).rows[0] ?? null;
    },
    async insertEvent(input: EventInput) {
      const result = await query<{ source: string; id: string }>(`INSERT INTO history.events(id,source,type_id,occurred_at,actor_id,scope_type,scope_id,object_type,object_id,data)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(source,id) DO NOTHING RETURNING source,id`,
      [input.id, input.source, input.type_id, input.occurred_at, input.actor_id, input.scope_type, input.scope_id, input.object_type, input.object_id, JSON.stringify(input.data)]);
      if (!result.rowCount) return null;
      return tx.event(input.source, input.id);
    },
    async events(filters: Filters, after: EventKey | null, count: number) {
      const values: unknown[] = [];
      const clauses: string[] = [];
      const eq = (column: string, value: unknown) => { values.push(value); clauses.push(`${column}=$${values.length}`); };
      for (const name of ["source", "type_id", "actor_id", "object_type", "object_id", "scope_type", "scope_id"] as const) if (filters[name] !== undefined) eq("e." + name, filters[name]);
      if (filters.category_id !== undefined) eq("t.category_id", filters.category_id);
      for (const [name, operator] of [["occurred_from", ">="], ["occurred_to", "<="]] as const) if (filters[name] !== undefined) {
        values.push(filters[name]); clauses.push(`e.occurred_at${operator}$${values.length}::timestamptz`);
      }
      if (after) {
        values.push(...after);
        clauses.push(`(e.recorded_at,e.source,e.id)<($${values.length - 2}::timestamptz,$${values.length - 1}::text,$${values.length}::uuid)`);
      }
      values.push(count);
      return (await query<HistoryEvent>(`SELECT ${eventFields} FROM history.events e JOIN history.sys_types t ON t.id=e.type_id ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
 ORDER BY e.recorded_at DESC,e.source DESC,e.id DESC LIMIT $${values.length}`, values)).rows;
    },
    async catalog(table, id, lock = false) {
      return (await query<CatalogRow>(`SELECT * FROM history.${table} WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0] ?? null;
    },
    async typeByCode(categoryCode, typeCode) {
      return (await query<EventType>(`SELECT t.* FROM history.sys_types t JOIN history.sys_categories c ON c.id=t.category_id WHERE c.code=$1 AND t.code=$2`, [categoryCode, typeCode])).rows[0] ?? null;
    },
    async catalogList(table, categoryId, after, count) {
      const values: unknown[] = [];
      const clauses: string[] = [];
      if (categoryId !== undefined) { values.push(categoryId); clauses.push(`category_id=$${values.length}`); }
      if (after !== null) { values.push(after); clauses.push(`id>$${values.length}`); }
      values.push(count);
      return (await query<CatalogRow>(`SELECT * FROM history.${table} ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY id ASC LIMIT $${values.length}`, values)).rows;
    },
    async catalogInsert(table, request) {
      const type = table === "sys_types";
      return (await query<CatalogRow>(`INSERT INTO history.${table}(${type ? "category_id," : ""}code,name,description) VALUES(${type ? "$4," : ""}$1,$2,$3) RETURNING *`,
        [request.code, request.name, request.description, ...(type ? [request.category_id] : [])])).rows[0];
    },
    async catalogUpdate(table, request) {
      return (await query<CatalogRow>(`UPDATE history.${table} SET name=$2,description=$3 WHERE id=$1 RETURNING *`, [request.id, request.name, request.description])).rows[0];
    }
  };
  return tx;
}
/** Подключает готовые пулы; вызывающий владеет их настройкой и закрытием. */
export function createPostgresStore(appPool: Pool, webPool: Pool): HistoryStore {
  return {
    async transaction<T>(userId: string | null, supplied: OperationContext | undefined, run: (tx: HistoryTransaction) => Promise<T>): Promise<T> {
      const context = supplied ?? { deadlineAt: performance.now() + 10_000, signal: new AbortController().signal };
      checkContext(context);
      let client: PoolClient | undefined;
      let begun = false;
      let destroy = false;
      try {
        client = await (userId === null ? appPool : webPool).connect();
        checkContext(context);
        await client.query("BEGIN"); begun = true;
        await client.query("SELECT set_config('statement_timeout',$1,true),set_config('app.user_id',$2,true)", [String(Math.max(1, Math.floor(context.deadlineAt - performance.now()))), userId ?? ""]);
        const result = await run(transactionPort(client, context));
        checkContext(context);
        await client.query("COMMIT"); begun = false;
        return result;
      } catch (error) {
        if (begun && client) {
          try { await client.query("ROLLBACK"); } catch { destroy = true; }
        }
        throw failure(error);
      } finally { client?.release(destroy); }
    },
    async ready() {
      try {
        await Promise.all([appPool.query("SELECT 1 FROM history.sys_types LIMIT 1"), webPool.query("SELECT 1 FROM history.events LIMIT 1")]);
      } catch (error) { throw failure(error); }
    }
  };
}
