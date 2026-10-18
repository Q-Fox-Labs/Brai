// ABOUTME: Реализует atomic journal providers на собственной PostgreSQL БД.
// ABOUTME: Один session advisory lock исключает второй runtime, не является lease.
import pg from "pg";
import { readFileSync } from "node:fs";
import { Failure } from "./core.js";
import { V1_LIMITS, type Operation, type OperationStore, type Phase, type Json } from "./operations.js";
const {Pool}=pg;
function decode(row:Record<string,unknown>):Operation {
  return {ownerId:row.owner_id as string,operationId:row.operation_id as string,inputHash:row.input_hash as string,phase:row.phase as Phase,cancelRequested:row.cancel_requested as boolean,createdAt:Number(row.created_at),finishedAt:row.finished_at===null?null:Number(row.finished_at),keyExpiresAt:Number(row.key_expires_at),resultExpiresAt:row.result_expires_at===null?null:Number(row.result_expires_at),route:row.route as Operation['route'],result:row.result as Json|null,errorCode:row.error_code as string|null};
}
/** Создаёт bounded pool; runtime обязан получить exclusive lock до recover/register. */
export function postgresStore(connectionString:string) {
  const pool=new Pool({connectionString,max:10,connectionTimeoutMillis:3000,idleTimeoutMillis:10000,query_timeout:4000,statement_timeout:3000,application_name:"brai_providers"});
  let lock:pg.PoolClient|undefined;
  pool.on("error",()=>{/* Без payload; следующий SQL вернёт безопасный отказ. */});
  const find:OperationStore['find']=async(owner,id,now)=>{const r=await pool.query("SELECT * FROM providers_operations WHERE owner_id=$1 AND operation_id=$2 AND key_expires_at>$3",[owner,id,now]);return r.rows[0]?decode(r.rows[0]):null;};
  const store:OperationStore={
    find,
    async accept(op) {
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        // AIDEV-NOTE: Короткий lock ограничивает число сохранённых ключей, не держится при inference.
        await client.query("LOCK TABLE providers_operations IN SHARE ROW EXCLUSIVE MODE");
        await client.query("DELETE FROM providers_operations WHERE key_expires_at<=$1",[op.createdAt]);
        const old=await client.query("SELECT * FROM providers_operations WHERE owner_id=$1 AND operation_id=$2",[op.ownerId,op.operationId]);
        if(old.rows[0]){await client.query("COMMIT");return {operation:decode(old.rows[0]),inserted:false};}
        const count=await client.query("SELECT count(*)::int AS total FROM providers_operations");
        if(count.rows[0].total>=V1_LIMITS.maxRows)throw new Failure("OVERLOADED","not_sent");
        await client.query("INSERT INTO providers_operations(owner_id,operation_id,input_hash,phase,created_at,key_expires_at,route) VALUES($1,$2,$3,'accepted',$4,$5,$6)",[op.ownerId,op.operationId,op.inputHash,op.createdAt,op.keyExpiresAt,op.route]);
        await client.query("COMMIT");return {operation:op,inserted:true};
      } catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
    },
    async claim(owner,id,hash){const r=await pool.query("UPDATE providers_operations SET phase='dispatching' WHERE owner_id=$1 AND operation_id=$2 AND phase='accepted' AND NOT cancel_requested AND input_hash=$3",[owner,id,hash]);return r.rowCount===1;},
    async finish(owner,id,phase,result,error,now,hash){await pool.query("UPDATE providers_operations SET phase=$3,result=$4,error_code=$5,finished_at=$6,result_expires_at=$7 WHERE owner_id=$1 AND operation_id=$2 AND phase IN ('accepted','dispatching') AND input_hash=$8",[owner,id,phase,result,error,now,now+V1_LIMITS.resultTtlMs,hash]);},
    async cancel(owner,id,now){const r=await pool.query("UPDATE providers_operations SET cancel_requested=true,phase=CASE WHEN phase='accepted' THEN 'cancelled' ELSE phase END,finished_at=CASE WHEN phase='accepted' THEN $3 ELSE finished_at END,result_expires_at=CASE WHEN phase='accepted' THEN $4 ELSE result_expires_at END,error_code=CASE WHEN phase='accepted' THEN 'CANCELLED' ELSE error_code END WHERE owner_id=$1 AND operation_id=$2 AND key_expires_at>$3 RETURNING *",[owner,id,now,now+V1_LIMITS.resultTtlMs]);return r.rows[0]?decode(r.rows[0]):null;},
    async recover(now){await pool.query("UPDATE providers_operations SET phase=CASE WHEN phase='accepted' THEN 'cancelled' ELSE 'outcome_unknown' END,error_code=CASE WHEN phase='accepted' THEN 'RESTART_BEFORE_DISPATCH' ELSE 'OUTCOME_UNKNOWN' END,finished_at=$1,result_expires_at=$2 WHERE phase IN ('accepted','dispatching')",[now,now+V1_LIMITS.resultTtlMs]);},
    async sweep(now){await pool.query("UPDATE providers_operations SET result=NULL WHERE result_expires_at<=$1 AND result IS NOT NULL",[now]);await pool.query("DELETE FROM providers_operations WHERE key_expires_at<=$1",[now]);}
  };
  return {...store,
    /** Вызывать явно при выпуске от роли-владельца, никогда не через shared DB. */
    async migrate(){await pool.query(readFileSync(new URL("../migrations/001_operations.sql",import.meta.url),"utf8"));},
    /** Блокировка живёт на выделенной сессии; её потеря немедленно останавливает runtime. */
    async exclusive(onLost:()=>void){lock=await pool.connect();const r=await lock.query("SELECT pg_try_advisory_lock(18401,1) AS acquired");if(!r.rows[0].acquired){lock.release();lock=undefined;throw new Error("PROVIDERS_INSTANCE_ALREADY_RUNNING");}lock.on("error",onLost);lock.on("end",onLost);},
    async close(){if(lock){lock.removeAllListeners("error");lock.removeAllListeners("end");await lock.query("SELECT pg_advisory_unlock(18401,1)").catch(()=>{});lock.release();lock=undefined;}await pool.end();}
  };
}
