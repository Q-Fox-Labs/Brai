// ABOUTME: Хранит состояние, интервалы и результаты команд в PostgreSQL.
// ABOUTME: Переходы сериализуются строкой владельца в state; чтения используют один снимок БД.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { decide, rejected, type Active, type Interval, type State } from "./domain.js";
import type { Delivery, Saved } from "./flow.js";
import { identity, parseCommand, commandType, eventSubject } from "./schema.js";
const asISO = (value: Date) => value.toISOString();
function interval(row: Record<string,any>): Interval { return {timerId:row.timer_id,startedAt:asISO(row.started_at),stoppedAt:asISO(row.stopped_at),durationMs:Number(row.duration_ms)}; }
function state(row: Record<string,any>): State { return {version:Number(row.version),active:row.active_timer_id ? {timerId:row.active_timer_id,startedAt:asISO(row.started_at)} : null}; }
const stateSQL="SELECT s.version,s.active_timer_id,i.started_at FROM timer.state s LEFT JOIN timer.intervals i ON i.user_id=s.user_id AND i.timer_id=s.active_timer_id WHERE s.user_id=$1";
function encodeCursor(userId: string, item: Active): string { return Buffer.from(JSON.stringify([userId,item.startedAt,item.timerId])).toString("base64url"); }
function decodeCursor(userId: string, cursor: unknown): [string,string] | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("INVALID_ARGUMENT");
  try {
    const value=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 3 && value[0] === userId && typeof value[1] === "string" && new Date(value[1]).toISOString() === value[1] && typeof value[2] === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value[2])) return [value[1],value[2]];
  } catch { /* Любая ошибка декодирования — неверный аргумент. */ }
  throw new Error("INVALID_ARGUMENT");
}
async function page(client: PoolClient, userId: string, limit: number, cursor?: unknown) {
  const key=decodeCursor(userId,cursor);
  const {rows}=await client.query("SELECT * FROM timer.intervals WHERE user_id=$1 AND stopped_at IS NOT NULL AND ($2::timestamptz IS NULL OR (started_at,timer_id)<($2::timestamptz,$3::uuid)) ORDER BY started_at DESC,timer_id DESC LIMIT $4",[userId,key?.[0]??null,key?.[1]??null,limit+1]);
  const items=rows.slice(0,limit).map(interval);
  return {userId,items,nextCursor:rows.length>limit ? encodeCursor(userId,items.at(-1)!) : null};
}
/** Создаёт адаптер; pool должен подключаться только с прикладной ролью без DDL. */
export function createStore(pool: Pool) {
  return {
    /** Фиксирует один эффект и исходный event; возвращает прежний event при повторе. */
    async process(delivery: Delivery): Promise<Saved> {
      const {userId,commandId,content}=identity(delivery.data);
      if (!userId) throw new Error("INVALID_OWNER");
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        // AIDEV-NOTE: Блокировка до любого ledger lookup закрывает гонку двух первых доставок.
        await client.query("INSERT INTO timer.state(user_id) VALUES($1) ON CONFLICT DO NOTHING",[userId]);
        await client.query("SELECT user_id FROM timer.state WHERE user_id=$1 FOR UPDATE",[userId]);
        const current=state((await client.query(stateSQL,[userId])).rows[0]);
        const command=parseCommand(delivery.subject,delivery.data);
        const byDelivery=(await client.query("SELECT event_subject,result FROM timer.commands WHERE user_id=$1 AND delivery_key=$2",[userId,delivery.key])).rows[0];
        let saved=byDelivery;
        let conflict=false;
        if (!saved && commandId) {
          const original=(await client.query("SELECT subject,content,event_subject,result FROM timer.commands WHERE user_id=$1 AND command_id=$2",[userId,commandId])).rows[0];
          if (original && original.subject===delivery.subject && original.content===content) saved=original;
          else if (original) conflict=true;
        }
        if (saved) {
          await client.query("COMMIT");
          return {subject:saved.event_subject,event:saved.result,duplicate:true};
        }
        let outcome;
        if (!command || conflict) {
          outcome={state:current,kind:"rejected" as const,event:rejected(conflict?"COMMAND_ID_CONFLICT":"INVALID_ARGUMENT",randomUUID(),conflict?commandId:null,delivery.key,current.version,userId)};
        } else {
          const now=asISO((await client.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now);
          const type=commandType(delivery.subject);
          // AIDEV-NOTE: Повтор чужого timerId должен завершиться отказом, а не бесконечным PK retry.
          const reused=type==="start" && command.timerId && (await client.query("SELECT 1 FROM timer.intervals WHERE user_id=$1 AND timer_id=$2",[userId,command.timerId])).rowCount;
          outcome=decide(type,command,current,now,{eventId:randomUUID(),timerId:randomUUID(),timerIdExists:Boolean(reused)});
          if (outcome.state.version!==current.version) {
            if (outcome.state.active) await client.query("INSERT INTO timer.intervals(user_id,timer_id,started_at) VALUES($1,$2,$3)",[userId,outcome.state.active.timerId,outcome.state.active.startedAt]);
            else await client.query("UPDATE timer.intervals SET stopped_at=$2,duration_ms=$3 WHERE timer_id=$1 AND user_id=$4",[outcome.interval!.timerId,outcome.interval!.stoppedAt,outcome.interval!.durationMs,userId]);
            await client.query("UPDATE timer.state SET version=$1,active_timer_id=$2 WHERE user_id=$3",[outcome.state.version,outcome.state.active?.timerId??null,userId]);
          }
        }
        await client.query("INSERT INTO timer.commands(user_id,command_id,delivery_key,subject,content,event_subject,result) VALUES($1,$2,$3,$4,$5,$6,$7)",[userId,command&&!conflict?command.commandId:null,delivery.key,delivery.subject,content,eventSubject(outcome.kind),outcome.event]);
        await client.query("COMMIT");
        return {subject:eventSubject(outcome.kind),event:outcome.event,duplicate:false};
      } catch (error) { await client.query("ROLLBACK").catch(()=>{}); throw error; }
      finally {client.release();}
    },
    /** Читает state, всю завершённую сумму в миллисекундах, history и часы из одной транзакции. */
    async snapshot(userId: string) {
      const client=await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const row=(await client.query(stateSQL,[userId])).rows[0];
        const current=row ? state(row) : {version:0,active:null};
        const history=await page(client,userId,50);
        const totalCompletedMs=Number((await client.query("SELECT COALESCE(SUM(duration_ms),0) AS total FROM timer.intervals WHERE user_id=$1 AND stopped_at IS NOT NULL",[userId])).rows[0].total);
        if (!Number.isSafeInteger(totalCompletedMs)) throw new Error("DURATION_EXHAUSTED");
        const serverTime=asISO((await client.query("SELECT transaction_timestamp() AS now")).rows[0].now);
        await client.query("COMMIT");
        return {userId,...current,serverTime,totalCompletedMs,recentCompleted:history.items,nextCursor:history.nextCursor};
      } catch(error) {await client.query("ROLLBACK").catch(()=>{});throw error;} finally {client.release();}
    },
    /** Читает страницу завершённых интервалов по устойчивому курсору. */
    async history(userId: string, limit: number, cursor?: unknown) {
      if (!Number.isInteger(limit)||limit<1||limit>100) throw new Error("INVALID_ARGUMENT");
      const client=await pool.connect();try{return await page(client,userId,limit,cursor);}finally{client.release();}
    },
    /** Отсутствие результата не означает отсутствие команды в брокере. */
    async command(userId: string, commandId: string) {
      const row=(await pool.query("SELECT result FROM timer.commands WHERE user_id=$1 AND command_id=$2",[userId,commandId])).rows[0];
      if (!row) throw new Error("NOT_FOUND");
      return {userId,commandId,status:"completed",result:row.result};
    },
    /** Проверяет доступность требуемой таблицы с runtime правами. */
    async ready() {await pool.query("SELECT version,user_id FROM timer.state LIMIT 1");},
  };
}
export type Store = ReturnType<typeof createStore>;
