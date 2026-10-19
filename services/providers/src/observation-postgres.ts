// ABOUTME: Снимает marker lifecycle и сохраняет Alerts DTO одной транзакцией.
// ABOUTME: Отдельное соединение и сроки изолируют observer от model slots и основного PG pool.
import pg from 'pg';
import { safeFact,alertFor,OBSERVATION_LIMITS as L,type Alert,type ObservationStore,type SafeFact } from './observation.js';
/** Только собственная БД providers; drain не читает result кроме числового usage. */
export function postgresObservation(connectionString:string){
  const pool=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:1000,idleTimeoutMillis:10000,query_timeout:1500,statement_timeout:1000,application_name:'brai_providers_observation'});
  pool.on('error',()=>{});
  const store:ObservationStore={
    async collectObservations(now){
      const c=await pool.connect();
      try{
        await c.query('BEGIN');
        await c.query('LOCK TABLE providers_alert_outbox,providers_alert_episodes IN SHARE ROW EXCLUSIVE MODE');
        const expired=await c.query('DELETE FROM providers_alert_outbox WHERE expires_at<=$1',[now]);
        await c.query('DELETE FROM providers_alert_episodes WHERE expires_at<=$1',[now]);
        const rows=await c.query('SELECT owner_id,operation_id,phase,created_at,COALESCE(finished_at,observation_at) AS finished_at,route,error_code,result->\'usage\' AS usage FROM providers_operations WHERE observation_pending ORDER BY observation_at,owner_id,operation_id LIMIT $1 FOR UPDATE SKIP LOCKED',[L.batch]);
        const facts:SafeFact[]=[];let dropped=0;
        for(const row of rows.rows){
          const fact=safeFact({ownerId:row.owner_id,operationId:row.operation_id,phase:row.phase,createdAt:Number(row.created_at),finishedAt:row.finished_at===null?null:Number(row.finished_at),route:row.route,errorCode:row.error_code,result:{usage:row.usage??null}});
          facts.push(fact);
          const keys=[fact.scope_id,fact.data.provider,fact.data.model];
          if(fact.data.phase==='succeeded')await c.query('DELETE FROM providers_alert_episodes WHERE owner_id=$1 AND provider=$2 AND model=$3',keys);
          const event=alertFor(fact);
          if(event){
            const episode=await c.query('SELECT 1 FROM providers_alert_episodes WHERE owner_id=$1 AND provider=$2 AND model=$3',keys);
            if(!episode.rowCount){
              const counts=await c.query('SELECT (SELECT count(*) FROM providers_alert_outbox)::int AS outbox,(SELECT count(*) FROM providers_alert_episodes)::int AS episodes');
              if(counts.rows[0].outbox>=L.outboxRows||counts.rows[0].episodes>=L.episodeRows)dropped++;
              else{
                await c.query('INSERT INTO providers_alert_outbox(event_id,payload,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[event.id,event,now+L.ttlMs]);
                await c.query('INSERT INTO providers_alert_episodes(owner_id,provider,model,expires_at) VALUES($1,$2,$3,$4)',[...keys,now+L.episodeTtlMs]);
              }
            }
          }
          await c.query('UPDATE providers_operations SET observation_pending=false WHERE owner_id=$1 AND operation_id=$2',[row.owner_id,row.operation_id]);
        }
        const counts=await c.query('SELECT (SELECT count(*) FROM providers_alert_outbox)::int AS outbox,(SELECT count(*) FROM providers_alert_episodes)::int AS episodes');
        await c.query('COMMIT');
        return {facts,dropped,expired:expired.rowCount??0,outboxSize:counts.rows[0].outbox,episodes:counts.rows[0].episodes};
      }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
    },
    async pendingAlerts(now){const result=await pool.query('SELECT payload FROM providers_alert_outbox WHERE expires_at>$1 ORDER BY expires_at,event_id LIMIT $2',[now,L.batch]);return result.rows.map(r=>r.payload as Alert);},
    async ackAlert(id){await pool.query('DELETE FROM providers_alert_outbox WHERE event_id=$1',[id]);}
  };
  return {...store,async close(){await pool.end();}};
}
