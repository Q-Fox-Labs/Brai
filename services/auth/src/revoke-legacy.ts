// ABOUTME: Отзывает прежние сессии и одноразовые подтверждения перед cutover.
// ABOUTME: Только owner БД хранит снимок; rollback требует отдельной pre-open блокировки.
import { Pool } from "pg";

const databaseURL=process.env.AUTH_DATABASE_URL,owner=process.env.AUTH_OWNER_ROLE,app=process.env.AUTH_APP_ROLE;
const requestId=process.env.AUTH_REVOKE_REQUEST_ID,action=process.env.AUTH_CUTOVER_ACTION??"revoke";
if(!databaseURL||!owner||!app||owner===app||!requestId||!/^[A-Za-z0-9:_-]{1,128}$/.test(requestId)||
 !["revoke","restore"].includes(action)||(action==="restore"&&process.env.AUTH_ROLLBACK_PREOPEN!=="1"))throw new Error("Cutover configuration required");
const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:5000});
try{
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const identity=(await client.query("SELECT current_user AS role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
  if(identity.role!==owner||identity.owner!==owner)throw new Error("Database owner required");
  const privacy=(await client.query(`SELECT pg_get_userbyid(n.nspowner)=current_user AS owner,
   has_schema_privilege($1,n.oid,'USAGE') AS schema_access,
   EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND c.relname IN ('snapshot','revocation')
    AND (pg_get_userbyid(c.relowner)<>current_user OR has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) AS unsafe_table,
   (SELECT count(*) FROM pg_class c WHERE c.relnamespace=n.oid AND c.relname IN ('snapshot','revocation') AND c.relkind='r') AS table_count
   FROM pg_namespace n WHERE n.nspname='auth_identity_owner'`,[app])).rows[0];
  if(!privacy||!privacy.owner||privacy.schema_access||privacy.unsafe_table||privacy.table_count!=='2')throw new Error("Private schema required");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('brai-auth-cutover-revocation',0))");
  await client.query('LOCK TABLE public."session",public."verification" IN ACCESS EXCLUSIVE MODE');
  const found=await client.query("SELECT sessions_revoked,verifications_revoked,revoked_at,restored_at FROM auth_identity_owner.revocation WHERE request_id=$1 FOR UPDATE",[requestId]);
  let sessions:number,verifications:number,at:Date,replayed=false;
  if(action==="revoke"){
   if(found.rowCount){
    const prior=found.rows[0];if(prior.restored_at)throw new Error("Already restored");
    sessions=prior.sessions_revoked;verifications=prior.verifications_revoked;at=prior.revoked_at;replayed=true;
   }else{
    const s=await client.query(`WITH removed AS (DELETE FROM public."session" RETURNING *)
     INSERT INTO auth_identity_owner.snapshot(request_id,table_name,row_data) SELECT $1,'session',to_jsonb(removed) FROM removed`,[requestId]);
    const v=await client.query(`WITH removed AS (DELETE FROM public."verification" RETURNING *)
     INSERT INTO auth_identity_owner.snapshot(request_id,table_name,row_data) SELECT $1,'verification',to_jsonb(removed) FROM removed`,[requestId]);
    sessions=s.rowCount??0;verifications=v.rowCount??0;
    const marker=await client.query("INSERT INTO auth_identity_owner.revocation(request_id,sessions_revoked,verifications_revoked) VALUES($1,$2,$3) RETURNING revoked_at",[requestId,sessions,verifications]);
    at=marker.rows[0].revoked_at;
   }
  }else{
   if(!found.rowCount||found.rows[0].restored_at)throw new Error("Rollback unavailable");
   const prior=found.rows[0];sessions=prior.sessions_revoked;verifications=prior.verifications_revoked;at=prior.revoked_at;
   const occupied=await client.query('SELECT (SELECT count(*) FROM public."session") AS sessions,(SELECT count(*) FROM public."verification") AS verifications');
   if(occupied.rows[0].sessions!=='0'||occupied.rows[0].verifications!=='0')throw new Error("New data present");
   const counts=await client.query("SELECT table_name,count(*)::integer AS count FROM auth_identity_owner.snapshot WHERE request_id=$1 GROUP BY table_name",[requestId]);
   const byName=new Map(counts.rows.map(row=>[row.table_name,row.count]));
   if((byName.get('session')??0)!==sessions||(byName.get('verification')??0)!==verifications)throw new Error("Snapshot mismatch");
   await client.query(`INSERT INTO public."session" SELECT (jsonb_populate_record(NULL::public."session",row_data)).* FROM auth_identity_owner.snapshot WHERE request_id=$1 AND table_name='session'`,[requestId]);
   await client.query(`INSERT INTO public."verification" SELECT (jsonb_populate_record(NULL::public."verification",row_data)).* FROM auth_identity_owner.snapshot WHERE request_id=$1 AND table_name='verification'`,[requestId]);
   await client.query("UPDATE auth_identity_owner.revocation SET restored_at=now() WHERE request_id=$1",[requestId]);
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({sessionsRevoked:sessions,verificationsRevoked:verifications,revokedAt:at.toISOString(),replayed,action}));
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}catch{console.error("auth cutover operation failed");process.exitCode=1;}finally{await pool.end();}
