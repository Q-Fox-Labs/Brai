// ABOUTME: Хранит состояние, интервалы и результаты команд в PostgreSQL.
// ABOUTME: Переходы сериализуются строкой владельца в state; чтения используют один снимок БД.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { decide, decideMutation, rejected, type Active, type Interval, type MutationCommand, type State } from "./domain.js";
import type { Delivery, Saved } from "./flow.js";
import { identity, parseCommand, commandType, eventSubject } from "./schema.js";
import { calculateStatistics } from "./statistics.js";
const asISO = (value: Date) => value.toISOString();
function interval(row: Record<string,any>): Interval { return {timerId:row.timer_id,startedAt:asISO(row.started_at),stoppedAt:asISO(row.stopped_at),durationMs:Number(row.duration_ms)}; }
function state(row: Record<string,any>): State { return {version:Number(row.version),active:row.active_timer_id ? {timerId:row.active_timer_id,startedAt:asISO(row.started_at)} : null}; }
const stateSQL="SELECT s.version,s.history_revision,s.active_timer_id,i.started_at FROM timer.state s LEFT JOIN timer.intervals i ON i.user_id=s.user_id AND i.timer_id=s.active_timer_id WHERE s.user_id=$1";
function encodeCursor(userId: string, historyRevision: number, item: Active): string { return Buffer.from(JSON.stringify([userId,historyRevision,item.startedAt,item.timerId])).toString("base64url"); }
function decodeCursor(userId: string, historyRevision: number, cursor: unknown): [string,string] | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("INVALID_ARGUMENT");
  try {
    const value=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));
    if (Array.isArray(value) && value[0] === userId) {
      const legacy=value.length===3,current=value.length===4;
      const revision=legacy?0:value[1],date=legacy?value[1]:value[2],timerId=legacy?value[2]:value[3];
      if((legacy||current)&&Number.isSafeInteger(revision)&&revision>=0&&typeof date==="string"&&new Date(date).toISOString()===date&&typeof timerId==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(timerId)) {
        if(revision!==historyRevision)throw new Error("HISTORY_CHANGED");
        return [date,timerId];
      }
    }
  } catch(error) { if(error instanceof Error&&error.message==="HISTORY_CHANGED")throw error; }
  throw new Error("INVALID_ARGUMENT");
}
async function page(client: PoolClient, userId: string, limit: number, historyRevision: number, cursor?: unknown) {
  const key=decodeCursor(userId,historyRevision,cursor);
  const {rows}=await client.query("SELECT * FROM timer.intervals WHERE user_id=$1 AND stopped_at IS NOT NULL AND deleted_at IS NULL AND ($2::timestamptz IS NULL OR (started_at,timer_id)<($2::timestamptz,$3::uuid)) ORDER BY started_at DESC,timer_id DESC LIMIT $4",[userId,key?.[0]??null,key?.[1]??null,limit+1]);
  const items=rows.slice(0,limit).map(interval);
  return {userId,items,nextCursor:rows.length>limit ? encodeCursor(userId,historyRevision,items.at(-1)!) : null};
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
        const ownerRow=(await client.query(stateSQL,[userId])).rows[0];
        const current=state(ownerRow),historyRevision=Number(ownerRow.history_revision);
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
        let mutation=false;
        if (!command || conflict) {
          outcome={state:current,kind:"rejected" as const,event:rejected(conflict?"COMMAND_ID_CONFLICT":"INVALID_ARGUMENT",randomUUID(),conflict?commandId:null,delivery.key,current.version,userId)};
        } else {
          const type=commandType(delivery.subject);
          if(type==="edit"||type==="delete") {
            const eventId=randomUUID();
            const row=(await client.query("SELECT * FROM timer.intervals WHERE user_id=$1 AND timer_id=$2",[userId,command.timerId])).rows[0];
            const target:Interval|null=row?.stopped_at&&!row.deleted_at?interval(row):null;
            let overlaps=false;
            if(type==="edit"&&target&&command.expectedVersion===current.version&&Date.parse(command.startedAt!)<Date.parse(command.stoppedAt!)) {
              overlaps=Boolean((await client.query("SELECT 1 FROM timer.intervals WHERE user_id=$1 AND timer_id<>$2 AND deleted_at IS NULL AND started_at<$4::timestamptz AND (stopped_at IS NULL OR stopped_at>$3::timestamptz) LIMIT 1",[userId,command.timerId,command.startedAt,command.stoppedAt])).rowCount);
            }
            outcome=decideMutation(type,command as MutationCommand,current,target,overlaps,eventId);
            mutation=outcome.kind==="edited"||outcome.kind==="deleted";
            if(mutation) {
              await client.query("INSERT INTO timer.interval_facts(user_id,timer_id,original_started_at,original_stopped_at,original_duration_ms) SELECT user_id,timer_id,started_at,stopped_at,duration_ms FROM timer.intervals WHERE user_id=$1 AND timer_id=$2 AND stopped_at IS NOT NULL AND deleted_at IS NULL ON CONFLICT (user_id,timer_id) DO NOTHING",[userId,command.timerId]);
              if(type==="edit") await client.query("UPDATE timer.intervals SET started_at=$3::timestamptz,stopped_at=$4::timestamptz,duration_ms=$5 WHERE user_id=$1 AND timer_id=$2 AND stopped_at IS NOT NULL AND deleted_at IS NULL",[userId,command.timerId,outcome.interval!.startedAt,outcome.interval!.stoppedAt,outcome.interval!.durationMs]);
              else await client.query("UPDATE timer.intervals SET deleted_at=transaction_timestamp() WHERE user_id=$1 AND timer_id=$2 AND stopped_at IS NOT NULL AND deleted_at IS NULL",[userId,command.timerId]);
            }
          } else {
            const now=asISO((await client.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now")).rows[0].now);
            // AIDEV-NOTE: Повтор чужого timerId должен завершиться отказом, а не бесконечным PK retry.
            const reused=type==="start" && command.timerId && (await client.query("SELECT 1 FROM timer.intervals WHERE user_id=$1 AND timer_id=$2",[userId,command.timerId])).rowCount;
            outcome=decide(type,command,current,now,{eventId:randomUUID(),timerId:randomUUID(),timerIdExists:Boolean(reused)});
          }
          if (outcome.state.version!==current.version) {
            if(outcome.kind==="started") await client.query("INSERT INTO timer.intervals(user_id,timer_id,started_at) VALUES($1,$2,$3)",[userId,outcome.state.active!.timerId,outcome.state.active!.startedAt]);
            else if(outcome.kind==="stopped") {
              await client.query("UPDATE timer.intervals SET stopped_at=$2,duration_ms=$3 WHERE timer_id=$1 AND user_id=$4",[outcome.interval!.timerId,outcome.interval!.stoppedAt,outcome.interval!.durationMs,userId]);
              await client.query("INSERT INTO timer.interval_facts(user_id,timer_id,original_started_at,original_stopped_at,original_duration_ms) SELECT user_id,timer_id,started_at,stopped_at,duration_ms FROM timer.intervals WHERE user_id=$1 AND timer_id=$2 ON CONFLICT (user_id,timer_id) DO NOTHING",[userId,outcome.interval!.timerId]);
            }
            await client.query("UPDATE timer.state SET version=$1,active_timer_id=$2,history_revision=$3 WHERE user_id=$4",[outcome.state.version,outcome.state.active?.timerId??null,historyRevision+(mutation?1:0),userId]);
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
        const current=row ? state(row) : {version:0,active:null},historyRevision=row?Number(row.history_revision):0;
        const history=await page(client,userId,50,historyRevision);
        const totalCompletedMs=Number((await client.query("SELECT COALESCE(SUM(duration_ms),0) AS total FROM timer.intervals WHERE user_id=$1 AND stopped_at IS NOT NULL AND deleted_at IS NULL",[userId])).rows[0].total);
        if (!Number.isSafeInteger(totalCompletedMs)) throw new Error("DURATION_EXHAUSTED");
        const serverTime=asISO((await client.query("SELECT transaction_timestamp() AS now")).rows[0].now);
        await client.query("COMMIT");
        return {userId,...current,historyRevision,serverTime,totalCompletedMs,recentCompleted:history.items,nextCursor:history.nextCursor};
      } catch(error) {await client.query("ROLLBACK").catch(()=>{});throw error;} finally {client.release();}
    },
    /** Читает страницу завершённых интервалов по устойчивому курсору. */
    async history(userId: string, limit: number, cursor?: unknown) {
      if (!Number.isInteger(limit)||limit<1||limit>100) throw new Error("INVALID_ARGUMENT");
      const client=await pool.connect();try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const row=(await client.query("SELECT history_revision FROM timer.state WHERE user_id=$1",[userId])).rows[0];
        const historyRevision=row?Number(row.history_revision):0;
        const result=await page(client,userId,limit,historyRevision,cursor);
        await client.query("COMMIT");
        return {...result,historyRevision};
      }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
    },
    /** Рассчитывает полную личную статистику из одного read-only снимка; активные и удалённые интервалы исключены. */
    async statistics(userId: string) {
      const client=await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const row=(await client.query(stateSQL,[userId])).rows[0];
        const config=(await client.query("SELECT start_date::text,end_date_exclusive::text,time_zone,days,daily_target_ms,target_ms FROM timer.sys_challenge WHERE singleton=true")).rows[0];
        if(!config)throw new Error("TIMER_CHALLENGE_REQUIRED");
        const completed=(await client.query("SELECT timer_id,started_at,stopped_at,duration_ms FROM timer.intervals WHERE user_id=$1 AND stopped_at IS NOT NULL AND deleted_at IS NULL",[userId])).rows;
        const serverTime=asISO((await client.query("SELECT transaction_timestamp() AS now")).rows[0].now);
        const result=calculateStatistics({userId,version:row?Number(row.version):0,serverTime,timeZone:config.time_zone,
          completedIntervals:completed.map(interval),challenge:{startDate:config.start_date,endDateExclusive:config.end_date_exclusive,
            timeZone:config.time_zone,days:Number(config.days),dailyTargetMs:Number(config.daily_target_ms),targetMs:Number(config.target_ms)}});
        await client.query("COMMIT");
        return result;
      }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}finally{client.release();}
    },
    /** Отсутствие результата не означает отсутствие команды в брокере. */
    async command(userId: string, commandId: string) {
      const row=(await pool.query("SELECT result FROM timer.commands WHERE user_id=$1 AND command_id=$2",[userId,commandId])).rows[0];
      if (!row) throw new Error("NOT_FOUND");
      return {userId,commandId,status:"completed",result:row.result};
    },
    /** Проверяет доступность требуемой таблицы с runtime правами. */
    async ready() {
      await pool.query("SELECT version,history_revision,user_id FROM timer.state LIMIT 1");
      await pool.query("SELECT deleted_at FROM timer.intervals LIMIT 1");
      await pool.query("SELECT original_duration_ms FROM timer.interval_facts LIMIT 1");
      if(!(await pool.query("SELECT singleton FROM timer.sys_challenge WHERE singleton=true")).rowCount)throw new Error("TIMER_CHALLENGE_REQUIRED");
    },
  };
}
export type Store = ReturnType<typeof createStore>;
