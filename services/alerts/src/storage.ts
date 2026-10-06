// ABOUTME: Реализует транзакционный порт alerts в собственной PostgreSQL-БД.
// ABOUTME: Доверенные web-операции используют отдельную роль и локальный RLS-контекст.
import type { Pool, PoolClient } from 'pg';
import { AlertsFault, checkContext, type AlertsStore, type AlertsTransaction, type OperationContext } from './domain.js';
import type { Notification, Summary } from '../contracts/index.mjs';

const fields = `n.id,n.service_id,n.type_id,n.scope_type,n.scope_id,n.title,n.text,n.data,
 to_char(n.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
 to_char(n.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at,
 to_jsonb(c) AS category,to_jsonb(t) AS type,
 to_char(r.read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS read_at`;
const joins = `FROM alerts.notifications n JOIN alerts.sys_types t ON t.id=n.type_id JOIN alerts.sys_categories c ON c.id=t.category_id
 LEFT JOIN alerts.read_marks r ON r.service_id=n.service_id AND r.id=n.id AND r.user_id=NULLIF(current_setting('app.user_id',true),'')`;
function failure(error: unknown): Error {
  if (error instanceof AlertsFault) return error;
  const code = (error as { code?: string })?.code ?? '';
  if (code === '57014') return new AlertsFault('DEADLINE_EXCEEDED');
  if (code === '23503' && (error as { constraint?: string }).constraint === 'notifications_type_id_fkey') return new AlertsFault('UNKNOWN_TYPE');
  if (code.startsWith('22') || ['23502', '23503', '23505', '23514'].includes(code)) return new AlertsFault('INVALID_ARGUMENT');
  if (code.startsWith('08') || code.startsWith('ECONN') || ['57P01', '57P02', '57P03', '53300', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', '40001', '40P01'].includes(code) || /connection|connect|timeout exceeded when trying to connect/i.test((error as Error)?.message ?? '')) return new AlertsFault('DATABASE_UNAVAILABLE');
  return new AlertsFault('INTERNAL');
}
function port(client: PoolClient, context: OperationContext, userId: string | null): AlertsTransaction {
  async function query(sql: string, values: unknown[] = []) {
    checkContext(context);
    await client.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.max(1, Math.floor(context.deadlineAt - performance.now())))]);
    checkContext(context);
    return client.query(sql, values);
  }
  return {
    async insert(input) {
      return !!(await query(`INSERT INTO alerts.notifications(id,service_id,type_id,scope_type,scope_id,title,text,data,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(service_id,id) DO NOTHING RETURNING id`,
      [input.id, input.service_id, input.type_id, input.scope_type, input.scope_id, input.title, input.text, JSON.stringify(input.data), input.occurred_at])).rowCount;
    },
    async get(serviceId, id) {
      return (await query(`SELECT ${fields} ${joins} WHERE n.service_id=$1 AND n.id=$2`, [serviceId, id])).rows[0] as Notification ?? null;
    },
    async list(after, count) {
      return (await query(`SELECT ${fields} ${joins} ${after ? 'WHERE (n.recorded_at,n.service_id,n.id)<($2::timestamptz,$3::text,$4::uuid)' : ''}
        ORDER BY n.recorded_at DESC,n.service_id DESC,n.id DESC LIMIT $1`, [count, ...(after ?? [])])).rows as Notification[];
    },
    async summary() {
      // AIDEV-NOTE: count и цвет получают один statement snapshot; отдельные SELECT могли бы дать несовместимый итог при ingestion.
      const row = (await query(`WITH unread AS MATERIALIZED (
        SELECT n.recorded_at,n.service_id,n.id,c.id AS category_id,c.code,c.name,c.color,c.importance ${joins} WHERE r.id IS NULL
      ) SELECT (SELECT count(*)::text FROM unread) AS count,
        (SELECT jsonb_build_object('id',category_id,'code',code,'name',name,'color',color,'importance',importance)
         FROM unread ORDER BY importance DESC,recorded_at DESC,service_id DESC,id DESC LIMIT 1) AS category`)).rows[0];
      const unread_count = Number(row.count);
      if (!Number.isSafeInteger(unread_count)) throw new AlertsFault('RESULT_TOO_LARGE');
      return { unread_count, category: row.category } as Summary;
    },
    async read(serviceId, id) {
      if (userId === null) throw new AlertsFault('INVALID_ARGUMENT');
      return !!(await query(`INSERT INTO alerts.read_marks(user_id,service_id,id)
        SELECT $1,n.service_id,n.id FROM alerts.notifications n WHERE n.service_id=$2 AND n.id=$3
        ON CONFLICT(user_id,service_id,id) DO NOTHING RETURNING id`, [userId, serviceId, id])).rowCount;
    },
    async readAll() {
      if (userId === null) throw new AlertsFault('INVALID_ARGUMENT');
      // AIDEV-NOTE: INSERT SELECT захватывает доступные строки на начале оператора; watermark по timestamp ошибочно включал бы поздний commit.
      return !!(await query(`INSERT INTO alerts.read_marks(user_id,service_id,id)
        SELECT $1,n.service_id,n.id FROM alerts.notifications n
        WHERE NOT EXISTS(SELECT 1 FROM alerts.read_marks r WHERE r.user_id=$1 AND r.service_id=n.service_id AND r.id=n.id)
        ORDER BY n.service_id,n.id ON CONFLICT(user_id,service_id,id) DO NOTHING`, [userId])).rowCount;
    },
  };
}
/** Подключает готовые отдельные пулы; runtime владеет их закрытием. */
export function createPostgresStore(appPool: Pool, webPool: Pool): AlertsStore {
  return {
    async transaction<T>(userId: string | null, supplied: OperationContext | undefined, run: (tx: AlertsTransaction) => Promise<T>): Promise<T> {
      const context = supplied ?? { deadlineAt: performance.now() + 10_000, signal: new AbortController().signal };
      let client: PoolClient | undefined;
      let begun = false;
      let destroy = false;
      try {
        checkContext(context);
        client = await (userId === null ? appPool : webPool).connect();
        checkContext(context);
        await client.query('BEGIN'); begun = true;
        await client.query("SELECT set_config('statement_timeout',$1,true),set_config('app.user_id',$2,true)", [String(Math.max(1, Math.floor(context.deadlineAt - performance.now()))), userId ?? '']);
        const result = await run(port(client, context, userId));
        checkContext(context);
        await client.query('COMMIT'); begun = false;
        return result;
      } catch (error) {
        if (begun && client) try { await client.query('ROLLBACK'); } catch { destroy = true; }
        throw failure(error);
      } finally { client?.release(destroy); }
    },
    async ready() {
      try { await Promise.all([appPool.query('SELECT 1 FROM alerts.sys_types LIMIT 1'), webPool.query('SELECT 1 FROM alerts.notifications LIMIT 1'), webPool.query('SELECT 1 FROM alerts.read_marks LIMIT 1')]); }
      catch (error) { throw failure(error); }
    },
  };
}
