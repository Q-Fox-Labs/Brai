// ABOUTME: Управляет долговечной очередью окружений пользователей Auth.
// ABOUTME: Поколение и аренда исключают активацию устаревшего задания.
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { insertIdentity } from "./identity-record.js";

/** Публичная выборка исключает секреты аренды и параметры повтора. */
export const operationSelect='SELECT id,request_id AS "requestId",user_id AS "userId",generation,kind,state,error_code AS "errorCode" FROM brai_user_operation';
/** Административный пользователь содержит сводку последней операции. */
export const adminUserSelect=`SELECT u.id,u.name,i.role,i.status,i.telegram_id AS "telegramId",i.profile_id AS "profileId",
 ARRAY(SELECT a.telegram_id FROM sys_telegram_account a WHERE a.user_id=i.user_id ORDER BY a.telegram_id) AS "telegramIds",
 (SELECT jsonb_build_object('id',o.id,'requestId',o.request_id,'kind',o.kind,'state',o.state,'errorCode',o.error_code)
 FROM brai_user_operation o WHERE o.user_id=i.user_id ORDER BY o.generation DESC LIMIT 1) AS lifecycle
 FROM brai_identity i JOIN "user" u ON u.id=i.user_id`;
/** До row locks сериализует admin, provisioning и worker в одном порядке. */
export async function lifecycleLock(client:PoolClient) {
 await client.query("SELECT pg_advisory_xact_lock(hashtextextended('brai-admin',0))");
 await client.query("SELECT pg_advisory_xact_lock(hashtextextended('brai-identity-provision',0))");
}
/** Вызывается внутри авторизованной транзакции; повтор не возобновляет доступ. */
export async function requestLifecycle(client:PoolClient,actor:string,action:string,body:Record<string,string>) {
 const requestId=body.requestId??randomUUID();
 const fingerprint=createHash('sha256').update(JSON.stringify([actor,action,body.telegramId??null,body.userId??null,body.status??null])).digest('hex');
 const previous=await client.query('SELECT fingerprint,user_id FROM brai_user_operation WHERE request_id=$1',[requestId]);
 const response=async(userId:string)=>({status:200,body:{
  user:(await client.query(adminUserSelect+' WHERE i.user_id=$1',[userId])).rows[0],
  operation:(await client.query(operationSelect+' WHERE request_id=$1',[requestId])).rows[0]
 }});
 if(previous.rowCount){
  if(previous.rows[0].fingerprint!==fingerprint)return {status:409,body:{code:'REQUEST_CONFLICT'}};
  return response(previous.rows[0].user_id);
 }
 let user=(await client.query(adminUserSelect+(action==='users-add'?' JOIN sys_telegram_account a ON a.user_id=i.user_id WHERE a.telegram_id=$1':' WHERE i.user_id=$1'),[action==='users-add'?body.telegramId:body.userId])).rows[0];
 if(!user&&action!=='users-add')return {status:404,body:{code:'NOT_FOUND'}};
 const kind=action==='users-revoke'||body.status==='blocked'?'stop':'prepare';
 const noop=user?.status==='active'&&(action==='users-add'||body.status==='active');
 if(user?.role==='admin'&&kind==='prepare'){
  const channels=await client.query("SELECT 1 FROM sys_telegram_account WHERE user_id=$1 LIMIT 1",[user.id]);
  if(!channels.rowCount)return {status:409,body:{code:'CONTACT_REQUIRED'}};
 }
 // AIDEV-NOTE: provisioning также снимает доступ, поэтому защищаем последнего active admin.
 if(user?.role==='admin'&&user.status==='active'&&!noop){
  const count=await client.query("SELECT count(*)::integer AS count FROM brai_identity WHERE role='admin' AND status='active'");
  if(count.rows[0].count<=1)return {status:409,body:{code:'LAST_ADMIN'}};
 }
 if(!user){
  const id=randomUUID(),profileId=randomUUID(),email=createHash('sha256').update(id).digest('hex')+'@identity.brai.invalid';
  await client.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',[id,'Пользователь',email]);
  user=await insertIdentity(client,{id,name:'Пользователь',role:'user',status:'provisioning',telegramId:body.telegramId,profileId});
 }
 // AIDEV-NOTE: cancelled сохраняет аренду до остановки worker или истечения срока.
 await client.query("UPDATE brai_user_operation SET state='cancelled',updated_at=now() WHERE user_id=$1 AND state IN ('pending','running')",[user.id]);
 const generation=(await client.query('UPDATE brai_identity SET lifecycle_generation=lifecycle_generation+1 WHERE user_id=$1 RETURNING lifecycle_generation',[user.id])).rows[0].lifecycle_generation;
 if(noop){
  // AIDEV-NOTE: No-op создаёт историю, но сохраняет только уже действующие сессии прежнего поколения.
  await client.query('UPDATE "session" SET brai_generation=$2 WHERE "userId"=$1 AND brai_generation=$2-1',[user.id,generation]);
 }
 if(!noop){
  await client.query("UPDATE brai_identity SET status=$2,profile_id=COALESCE(profile_id,$3) WHERE user_id=$1",[user.id,kind==='stop'?'blocked':'provisioning',randomUUID()]);
  await client.query('DELETE FROM "session" WHERE "userId"=$1',[user.id]);
  await client.query('DELETE FROM brai_login_code WHERE user_id=$1',[user.id]);
  await client.query('DELETE FROM sys_telegram_link WHERE user_id=$1',[user.id]);
 }
 await client.query("INSERT INTO brai_user_operation(id,request_id,fingerprint,user_id,generation,kind,state,activate_on_success) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[randomUUID(),requestId,fingerprint,user.id,generation,kind,noop?'succeeded':'pending',body.status!=='provisioning']);
 await client.query('INSERT INTO brai_identity_audit(id,actor_id,target_id,action) VALUES($1,$2,$3,$4)',[randomUUID(),actor,user.id,action]);
 return response(user.id);
}
/** Выдаёт единственную глобальную аренду на 45 секунд и отклоняет устаревшие подтверждения. */
export async function lifecycleWorker(pool:Pool,action:'claim'|'renew'|'complete',input:{workerId?:string;operationId?:string;leaseToken?:string;success?:boolean;errorCode?:string}) {
 const client=await pool.connect();
 try {
  await client.query('BEGIN');await lifecycleLock(client);
  let result:Record<string,unknown>;
  if(action==='claim'){
   const busy=await client.query("SELECT 1 FROM brai_user_operation WHERE lease_expires_at>clock_timestamp() LIMIT 1");
   const next=busy.rowCount?null:(await client.query("SELECT id FROM brai_user_operation WHERE state IN ('pending','running') ORDER BY created_at,id LIMIT 1")).rows[0];
   if(!next)result={operation:null};
   else {
    const token=randomUUID();
    await client.query("UPDATE brai_user_operation SET state='running',worker_id=$2,lease_token=$3,lease_expires_at=clock_timestamp()+interval '45 seconds',updated_at=now() WHERE id=$1",[next.id,input.workerId,token]);
    const operation=(await client.query(operationSelect+' WHERE id=$1',[next.id])).rows[0];
    const {lifecycle:_,telegramIds:__,...user}=(await client.query(adminUserSelect+' WHERE i.user_id=$1',[operation.userId])).rows[0];
    result={operation:{...operation,leaseToken:token,user}};
   }
  }else{
   const row=(await client.query("SELECT o.*,i.lifecycle_generation,i.status,o.lease_expires_at>clock_timestamp() AS valid_lease FROM brai_user_operation o JOIN brai_identity i ON i.user_id=o.user_id WHERE o.id=$1",[input.operationId])).rows[0];
   const leased=row&&row.lease_token===input.leaseToken&&row.valid_lease;
   const accepted=!!leased&&row.state==='running'&&row.generation===row.lifecycle_generation&&
    (row.kind==='prepare'?row.status==='provisioning':row.status==='blocked');
   if(action==='renew'){
    if(accepted)await client.query("UPDATE brai_user_operation SET lease_expires_at=clock_timestamp()+interval '45 seconds',updated_at=now() WHERE id=$1",[row.id]);
    result={accepted};
   }else{
    if(accepted){
     if(input.success&&row.kind==='prepare'&&row.activate_on_success&&row.status==='provisioning')await client.query("UPDATE brai_identity SET status='active' WHERE user_id=$1",[row.user_id]);
     await client.query("UPDATE brai_user_operation SET state=$2,error_code=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",[row.id,input.success?'succeeded':'failed',input.success?null:(input.errorCode??'LIFECYCLE_FAILED')]);
    }else if(leased&&row.state==='cancelled')await client.query('UPDATE brai_user_operation SET lease_token=NULL,lease_expires_at=NULL WHERE id=$1',[row.id]);
    result={accepted,operation:(await client.query(operationSelect+' WHERE id=$1',[input.operationId])).rows[0]??null};
   }
  }
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
