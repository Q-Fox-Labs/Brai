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
    async markOutputSaveFailed(owner,id,hash){await pool.query("UPDATE providers_operations SET observation_pending=true,observation_at=COALESCE(observation_at,$4) WHERE owner_id=$1 AND operation_id=$2 AND input_hash=$3 AND phase='output_pending'",[owner,id,hash,Date.now()]);},
    async reserveOutput(owner,id,hash,requestId,expiresAt){
      const client=await pool.connect();try{await client.query('BEGIN');await client.query('LOCK TABLE providers_pending_outputs IN SHARE ROW EXCLUSIVE MODE');
        const count=await client.query('SELECT count(*)::int AS total FROM providers_pending_outputs');if(count.rows[0].total>=2)throw new Failure('OUTPUT_STORAGE_FULL','not_sent');
        await client.query('INSERT INTO providers_pending_outputs(owner_id,operation_id,input_hash,request_id,expires_at) VALUES($1,$2,$3,$4,$5)',[owner,id,hash,requestId,expiresAt]);await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    },
    async stageOutput(output,metadata){
      const client=await pool.connect();try{await client.query('BEGIN');
        const updated=await client.query('UPDATE providers_pending_outputs SET bytes=$4,sha256=$5,metadata=$6,expires_at=$7 WHERE owner_id=$1 AND operation_id=$2 AND input_hash=$3 AND bytes IS NULL',[output.ownerId,output.operationId,output.inputHash,output.bytes,output.sha256,metadata,output.expiresAt]);if(updated.rowCount!==1)throw new Error('OUTPUT_BYTES_LOST');
        const phase=await client.query("UPDATE providers_operations SET phase='output_pending',error_code='OUTPUT_SAVE_PENDING' WHERE owner_id=$1 AND operation_id=$2 AND input_hash=$3 AND phase='dispatching'",[output.ownerId,output.operationId,output.inputHash]);if(phase.rowCount!==1)throw new Error('OUTPUT_BYTES_LOST');await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    },
    async pendingOutputs(owner,id){const result=await pool.query('SELECT * FROM providers_pending_outputs WHERE bytes IS NOT NULL AND ($1::text IS NULL OR owner_id=$1) AND ($2::uuid IS NULL OR operation_id=$2) ORDER BY expires_at LIMIT 2',[owner??null,id??null]);return result.rows.map(row=>({ownerId:row.owner_id,operationId:row.operation_id,inputHash:row.input_hash,requestId:row.request_id,bytes:row.bytes,sha256:row.sha256,metadata:row.metadata,expiresAt:Number(row.expires_at)}));},
    async dropOutput(owner,id,hash){await pool.query('DELETE FROM providers_pending_outputs WHERE owner_id=$1 AND operation_id=$2 AND input_hash=$3',[owner,id,hash]);},
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
    async finish(owner,id,phase,result,error,now,hash){await pool.query("UPDATE providers_operations SET phase=$3,result=$4,error_code=$5,finished_at=$6,result_expires_at=$7 WHERE owner_id=$1 AND operation_id=$2 AND phase IN ('accepted','dispatching','output_pending') AND input_hash=$8",[owner,id,phase,result,error,now,now+V1_LIMITS.resultTtlMs,hash]);},
    async cancel(owner,id,now){const r=await pool.query("UPDATE providers_operations SET cancel_requested=true,phase=CASE WHEN phase='accepted' THEN 'cancelled' ELSE phase END,finished_at=CASE WHEN phase='accepted' THEN $3 ELSE finished_at END,result_expires_at=CASE WHEN phase='accepted' THEN $4 ELSE result_expires_at END,error_code=CASE WHEN phase='accepted' THEN 'CANCELLED' ELSE error_code END WHERE owner_id=$1 AND operation_id=$2 AND key_expires_at>$3 RETURNING *",[owner,id,now,now+V1_LIMITS.resultTtlMs]);return r.rows[0]?decode(r.rows[0]):null;},
    async recover(now){await pool.query("UPDATE providers_operations o SET phase='failed',error_code='OUTPUT_BYTES_LOST',finished_at=$1,result_expires_at=$2 WHERE phase='output_pending' AND NOT EXISTS(SELECT 1 FROM providers_pending_outputs p WHERE p.owner_id=o.owner_id AND p.operation_id=o.operation_id AND p.bytes IS NOT NULL)",[now,now+V1_LIMITS.resultTtlMs]);await pool.query("UPDATE providers_operations SET phase=CASE WHEN phase='accepted' THEN 'cancelled' ELSE 'outcome_unknown' END,error_code=CASE WHEN phase='accepted' THEN 'RESTART_BEFORE_DISPATCH' ELSE 'OUTCOME_UNKNOWN' END,finished_at=$1,result_expires_at=$2 WHERE phase IN ('accepted','dispatching')",[now,now+V1_LIMITS.resultTtlMs]);},
    async sweep(now){await pool.query("UPDATE providers_operations o SET phase='failed',error_code='OUTPUT_BYTES_EXPIRED',finished_at=$1,result_expires_at=$2 WHERE phase='output_pending' AND EXISTS(SELECT 1 FROM providers_pending_outputs p WHERE p.owner_id=o.owner_id AND p.operation_id=o.operation_id AND p.expires_at<=$1)",[now,now+V1_LIMITS.resultTtlMs]);await pool.query("DELETE FROM providers_pending_outputs p WHERE expires_at<=$1 OR EXISTS(SELECT 1 FROM providers_operations o WHERE o.owner_id=p.owner_id AND o.operation_id=p.operation_id AND o.phase NOT IN ('accepted','dispatching','output_pending'))",[now]);await pool.query("UPDATE providers_operations SET result=NULL WHERE result_expires_at<=$1 AND result IS NOT NULL",[now]);await pool.query("DELETE FROM providers_operations WHERE key_expires_at<=$1",[now]);}
  };
  return {...store,
    /** Вызывать явно при выпуске от роли-владельца, никогда не через shared DB. */
    async migrate(){for(const name of ["001_operations.sql","002_outputs.sql","003_observation.sql"])await pool.query(readFileSync(new URL("../migrations/"+name,import.meta.url),"utf8"));},
    /** Блокировка живёт на выделенной сессии; её потеря немедленно останавливает runtime. */
    async exclusive(onLost:()=>void){lock=await pool.connect();const r=await lock.query("SELECT pg_try_advisory_lock(18401,1) AS acquired");if(!r.rows[0].acquired){lock.release();lock=undefined;throw new Error("PROVIDERS_INSTANCE_ALREADY_RUNNING");}lock.on("error",onLost);lock.on("end",onLost);},
    async close(){if(lock){lock.removeAllListeners("error");lock.removeAllListeners("end");await lock.query("SELECT pg_advisory_unlock(18401,1)").catch(()=>{});lock.release();lock=undefined;}await pool.end();}
  };
}
