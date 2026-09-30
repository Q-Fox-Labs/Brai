// ABOUTME: Хранит состояние, интервалы и результаты команд в PostgreSQL.
// ABOUTME: Все переходы сериализуются строкой state; чтения используют один снимок БД.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { decide, rejected, type Active, type Interval, type State } from "./domain.js";
import type { Delivery, Saved } from "./flow.js";
import { identity, parseCommand, commandType, eventSubject } from "./schema.js";
const asISO = (value: Date) => value.toISOString();
function interval(row: Record<string,any>): Interval { return {timerId:row.timer_id,startedAt:asISO(row.started_at),stoppedAt:asISO(row.stopped_at),durationMs:Number(row.duration_ms)}; }
function state(row: Record<string,any>): State { return {version:Number(row.version),active:row.active_timer_id ? {timerId:row.active_timer_id,startedAt:asISO(row.started_at)} : null}; }
const stateSQL="SELECT s.version,s.active_timer_id,i.started_at FROM timer.state s LEFT JOIN timer.intervals i ON i.timer_id=s.active_timer_id WHERE s.singleton=true";
function encodeCursor(item: Active): string { return Buffer.from(JSON.stringify([item.startedAt,item.timerId])).toString("base64url"); }
function decodeCursor(cursor: unknown): [string,string] | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("INVALID_ARGUMENT");
  try {
    const value=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && new Date(value[0]).toISOString() === value[0] && typeof value[1] === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value[1])) return [value[0],value[1]];
  } catch { /* Любая ошибка декодирования — неверный аргумент. */ }
  throw new Error("INVALID_ARGUMENT");
}
async function page(client: PoolClient, limit: number, cursor?: unknown) {
  const key=decodeCursor(cursor);
  const {rows}=await client.query("SELECT * FROM timer.intervals WHERE stopped_at IS NOT NULL AND ($1::timestamptz IS NULL OR (started_at,timer_id)<($1::timestamptz,$2::uuid)) ORDER BY started_at DESC,timer_id DESC LIMIT $3",[key?.[0]??null,key?.[1]??null,limit+1]);
  const items=rows.slice(0,limit).map(interval);
  return {items,nextCursor:rows.length>limit ? encodeCursor(items.at(-1)!) : null};
}
/** Создаёт адаптер; pool должен подключаться только с прикладной ролью без DDL. */
export function createStore(pool: Pool) {
  return {
    /** Фиксирует один эффект и исходный event; возвращает прежний event при повторе. */
    async process(delivery: Delivery): Promise<Saved> {
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        // AIDEV-NOTE: Блокировка до любого ledger lookup закрывает гонку двух первых доставок.
        await client.query("SELECT singleton FROM timer.state WHERE singleton=true FOR UPDATE");
        const current=state((await client.query(stateSQL)).rows[0]);
        const command=parseCommand(delivery.subject,delivery.data);
        const {commandId,content}=identity(delivery.data);
        const byDelivery=(await client.query("SELECT event_subject,result FROM timer.commands WHERE delivery_key=$1",[delivery.key])).rows[0];
        let saved=byDelivery;
        let conflict=false;
        if (!saved && commandId) {
          const original=(await client.query("SELECT subject,content,event_subject,result FROM timer.commands WHERE command_id=$1",[commandId])).rows[0];
          if (original && original.subject===delivery.subject && original.content===content) saved=original;
          else if (original) conflict=true;
        }
        if (saved) {
          await client.query("COMMIT");
          return {subject:saved.event_subject,event:saved.result,duplicate:true};
        }
        let outcome;
        if (!command || conflict) {
          outcome={state:current,kind:"rejected" as const,event:rejected(conflict?"COMMAND_ID_CONFLICT":"INVALID_ARGUMENT",randomUUID(),conflict?commandId:null,delivery.key,current.version)};
        } else {
          const now=asISO((await client.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now);
          const type=commandType(delivery.subject);
          // AIDEV-NOTE: Повтор чужого timerId должен завершиться отказом, а не бесконечным PK retry.
          const reused=type==="start" && command.timerId && (await client.query("SELECT 1 FROM timer.intervals WHERE timer_id=$1",[command.timerId])).rowCount;
          outcome=decide(type,command,current,now,{eventId:randomUUID(),timerId:randomUUID(),timerIdExists:Boolean(reused)});
          if (outcome.state.version!==current.version) {
            if (outcome.state.active) await client.query("INSERT INTO timer.intervals(timer_id,started_at) VALUES($1,$2)",[outcome.state.active.timerId,outcome.state.active.startedAt]);
            else await client.query("UPDATE timer.intervals SET stopped_at=$2,duration_ms=$3 WHERE timer_id=$1",[outcome.interval!.timerId,outcome.interval!.stoppedAt,outcome.interval!.durationMs]);
            await client.query("UPDATE timer.state SET version=$1,active_timer_id=$2 WHERE singleton=true",[outcome.state.version,outcome.state.active?.timerId??null]);
          }
        }
        await client.query("INSERT INTO timer.commands(command_id,delivery_key,subject,content,event_subject,result) VALUES($1,$2,$3,$4,$5,$6)",[command&&!conflict?command.commandId:null,delivery.key,delivery.subject,content,eventSubject(outcome.kind),outcome.event]);
        await client.query("COMMIT");
        return {subject:eventSubject(outcome.kind),event:outcome.event,duplicate:false};
      } catch (error) { await client.query("ROLLBACK").catch(()=>{}); throw error; }
      finally {client.release();}
    },
    /** Читает согласованные state/history/serverTime из repeatable-read транзакции. */
    async snapshot() {
      const client=await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const current=state((await client.query(stateSQL)).rows[0]);
        const history=await page(client,50);
        const serverTime=asISO((await client.query("SELECT transaction_timestamp() AS now")).rows[0].now);
        await client.query("COMMIT");
        return {...current,serverTime,recentCompleted:history.items,nextCursor:history.nextCursor};
      } catch(error) {await client.query("ROLLBACK").catch(()=>{});throw error;} finally {client.release();}
    },
    /** Читает страницу завершённых интервалов по устойчивому курсору. */
    async history(limit: number, cursor?: unknown) {
      if (!Number.isInteger(limit)||limit<1||limit>100) throw new Error("INVALID_ARGUMENT");
      const client=await pool.connect();try{return await page(client,limit,cursor);}finally{client.release();}
    },
    /** Отсутствие результата не означает отсутствие команды в брокере. */
    async command(commandId: string) {
      const row=(await pool.query("SELECT result FROM timer.commands WHERE command_id=$1",[commandId])).rows[0];
      if (!row) throw new Error("NOT_FOUND");
      return {commandId,status:"completed",result:row.result};
    },
    /** Проверяет доступность требуемой таблицы с runtime правами. */
    async ready() {await pool.query("SELECT version FROM timer.state WHERE singleton=true");},
  };
}
export type Store = ReturnType<typeof createStore>;
