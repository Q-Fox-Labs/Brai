// ABOUTME: Управляет долговечной очередью окружений пользователей Auth.
// ABOUTME: Поколение и аренда исключают активацию устаревшего задания.
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { insertIdentity } from "./identity-record.js";

/** Публичная выборка исключает секреты аренды и параметры повтора. */
export const operationSelect='SELECT id,request_id AS "requestId",user_id AS "userId",generation,kind,state,error_code AS "errorCode" FROM brai_user_operation';
/** Административный пользователь содержит сводку последней операции. */
export const adminUserSelect=`SELECT u.id,u.name,i.role,i.status,i.telegram_id AS "telegramId",i.profile_id AS "profileId",i.lifecycle_generation AS generation,i.applied_generation AS "appliedGeneration",
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
 const fingerprint=createHash('sha256').update(JSON.stringify([actor,action,body.telegramId??null,body.userId??null,body.status??null,...(body.role===undefined?[]:[body.role])])).digest('hex');
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
 const roleChange=action==='role-set';
 if(user?.role==='creator'&&actor!=='operator'){
  const author=await client.query('SELECT role FROM brai_identity WHERE user_id=$1',[actor]);
  if(author.rows[0]?.role!=='creator')return {status:403,body:{code:'FORBIDDEN'}};
 }
 if(roleChange&&!['creator','admin','user','guest'].includes(body.role))return {status:400,body:{code:'INVALID_ROLE'}};
 if(action==='users-add'&&body.role!==undefined&&!['user','guest'].includes(body.role))return {status:400,body:{code:'INVALID_ROLE'}};
 if(action==='users-add'&&user&&body.role!==undefined&&body.role!==user.role)return {status:409,body:{code:'ROLE_CONFLICT'}};
 const nextRole=roleChange?body.role:user?.role??body.role??'user';
 const manager=(role:string)=>['creator','admin'].includes(role);
 const kind=action==='users-revoke'||body.status==='blocked'||roleChange&&user.status==='blocked'?'stop':'prepare';
 const noop=user?.status==='active'&&(action==='users-add'||body.status==='active'||roleChange&&user.role===nextRole);
 const preserveManagement=roleChange&&user.status==='active'&&manager(user.role)&&manager(nextRole);
 if(manager(nextRole)&&kind==='prepare'){
  const channels=await client.query("SELECT 1 FROM sys_telegram_account WHERE user_id=$1 LIMIT 1",[user.id]);
  if(!channels.rowCount)return {status:409,body:{code:'CONTACT_REQUIRED'}};
 }
 // AIDEV-NOTE: Переоформление admin → creator сохраняет управление даже у единственного управляющего.
 if(user&&manager(user.role)&&user.status==='active'&&!noop&&!preserveManagement){
  const count=await client.query("SELECT count(*)::integer AS count FROM brai_identity WHERE role IN ('creator','admin') AND status='active'");
  if(count.rows[0].count<=1)return {status:409,body:{code:'LAST_ADMIN'}};
 }
 if(!user){
  const id=randomUUID(),profileId=randomUUID(),email=createHash('sha256').update(id).digest('hex')+'@identity.brai.invalid';
  await client.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',[id,'Пользователь',email]);
  user=await insertIdentity(client,{id,name:'Пользователь',role:nextRole,status:'provisioning',telegramId:body.telegramId,profileId});
 }
 await client.query("UPDATE brai_user_operation SET state='cancelled',updated_at=now() WHERE user_id=$1 AND state IN ('pending','running')",[user.id]);
 const generation=(await client.query('UPDATE brai_identity SET lifecycle_generation=lifecycle_generation+1 WHERE user_id=$1 RETURNING lifecycle_generation',[user.id])).rows[0].lifecycle_generation;
 if(noop||preserveManagement){
  await client.query('UPDATE "session" SET brai_generation=$2 WHERE "userId"=$1 AND brai_generation=$2-1',[user.id,generation]);
 }
 if(!noop){
  const nextStatus=preserveManagement?'active':kind==='stop'?'blocked':'provisioning';
  await client.query("UPDATE brai_identity SET role=$2,status=$3,profile_id=COALESCE(profile_id,$4) WHERE user_id=$1",[user.id,nextRole,nextStatus,randomUUID()]);
  if(!preserveManagement)await client.query('DELETE FROM "session" WHERE "userId"=$1',[user.id]);
  await client.query('DELETE FROM brai_login_code WHERE user_id=$1',[user.id]);
  // AIDEV-NOTE: Код email-входа тоже не должен ожить после guest → user.
  await client.query(`DELETE FROM verification WHERE identifier IN
   (SELECT 'sign-in-otp-' || lower(email) FROM "user" WHERE id=$1)`,[user.id]);
  await client.query('DELETE FROM sys_telegram_link WHERE user_id=$1',[user.id]);
 }
 const activate=roleChange?user.status==='active':body.status!=='provisioning';
 await client.query("INSERT INTO brai_user_operation(id,request_id,fingerprint,user_id,generation,kind,state,activate_on_success,required_policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[randomUUID(),requestId,fingerprint,user.id,generation,kind,noop?'succeeded':'pending',activate,roleChange||nextRole==='guest'?1:0]);
 await client.query('INSERT INTO brai_identity_audit(id,actor_id,target_id,action,old_role,new_role,request_id,generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),actor,user.id,action,roleChange?user.role:null,roleChange?nextRole:null,requestId,generation]);
 return response(user.id);
}

/** Выдаёт единственную глобальную аренду на 45 секунд и отклоняет устаревшие подтверждения. */
export async function lifecycleWorker(pool:Pool,action:'claim'|'renew'|'complete',input:{rolePolicyVersion?:1;workerId?:string;operationId?:string;leaseToken?:string;success?:boolean;errorCode?:string}) {
 const client=await pool.connect();
 try {
  await client.query('BEGIN');await lifecycleLock(client);
  let result:Record<string,unknown>;
  if(action==='claim'){
   const busy=await client.query("SELECT 1 FROM brai_user_operation WHERE lease_expires_at>clock_timestamp() LIMIT 1");
   const next=busy.rowCount?null:(await client.query("SELECT id FROM brai_user_operation WHERE state IN ('pending','running') AND required_policy_version <= $1 ORDER BY created_at,id LIMIT 1",[input.rolePolicyVersion??0])).rows[0];
   if(!next)result={operation:null};
   else {
    const token=randomUUID();
    await client.query("UPDATE brai_user_operation SET state='running',worker_id=$2,lease_token=$3,lease_expires_at=clock_timestamp()+interval '45 seconds',updated_at=now() WHERE id=$1",[next.id,input.workerId,token]);
    const operation=(await client.query(operationSelect+' WHERE id=$1',[next.id])).rows[0];
    const {lifecycle:_,telegramIds:__,...user}=(await client.query(adminUserSelect+' WHERE i.user_id=$1',[operation.userId])).rows[0];
    result={operation:{...operation,leaseToken:token,user}};
   }
  }else{
   const row=(await client.query("SELECT o.*,i.lifecycle_generation,i.status,i.role,o.lease_expires_at>clock_timestamp() AS valid_lease FROM brai_user_operation o JOIN brai_identity i ON i.user_id=o.user_id WHERE o.id=$1",[input.operationId])).rows[0];
   const leased=row&&row.lease_token===input.leaseToken&&row.valid_lease;
   const accepted=!!leased&&row.state==='running'&&row.generation===row.lifecycle_generation&&
    (row.kind==='prepare'?(row.status==='provisioning'||row.status==='active'&&['creator','admin'].includes(row.role)):row.status==='blocked');
   if(action==='renew'){
    if(accepted)await client.query("UPDATE brai_user_operation SET lease_expires_at=clock_timestamp()+interval '45 seconds',updated_at=now() WHERE id=$1",[row.id]);
    result={accepted};
   }else{
    if(accepted){
     if(input.success&&row.kind==='prepare')await client.query('UPDATE brai_identity SET applied_generation=lifecycle_generation WHERE user_id=$1',[row.user_id]);
     if(input.success&&row.kind==='prepare'&&row.activate_on_success&&row.status==='provisioning')await client.query("UPDATE brai_identity SET status='active' WHERE user_id=$1",[row.user_id]);
     await client.query("UPDATE brai_user_operation SET state=$2,error_code=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1",[row.id,input.success?'succeeded':'failed',input.success?null:(input.errorCode??'LIFECYCLE_FAILED')]);
    }else if(leased&&row.state==='cancelled')await client.query('UPDATE brai_user_operation SET lease_token=NULL,lease_expires_at=NULL WHERE id=$1',[row.id]);
    result={accepted,operation:(await client.query(operationSelect+' WHERE id=$1',[input.operationId])).rows[0]??null};
   }
  }
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
