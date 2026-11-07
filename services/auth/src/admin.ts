// ABOUTME: Исполняет административные операции над реестром Auth.
// ABOUTME: Авторизация, изменение и аудит выполняются в одной транзакции.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";

const userSelect='SELECT u.id,u.name,i.role,i.status,i.telegram_id AS "telegramId",i.profile_id AS "profileId" FROM brai_identity i JOIN "user" u ON u.id=i.user_id';
const inviteSelect='SELECT id,created_at AS "createdAt",expires_at AS "expiresAt",revoked_at AS "revokedAt",consumed_at AS "consumedAt" FROM brai_invite';
type Operation="users-list"|"users-get"|"role-set"|"status-set"|"sessions-revoke"|"invite-create"|"invite-list"|"invite-revoke"|"admin-audit";
/** Исполняет проверенное действие администратора; actor берётся только из сессии. */
export async function adminAction(pool:Pool,secret:string,actor:string,operation:Operation,body:Record<string,string>,sessionId?:string) {
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('brai-admin',0))");
  if(sessionId){
   const session=await client.query('SELECT 1 FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">now() FOR UPDATE',[sessionId,actor]);
   if(!session.rowCount){await client.query("COMMIT");return {status:401,body:{code:"UNAUTHORIZED"}};}
  }
  const admin=await client.query("SELECT 1 FROM brai_identity WHERE user_id=$1 AND role='admin' AND status='active' FOR UPDATE",[actor]);
  if(!admin.rowCount){await client.query("COMMIT");return {status:403,body:{code:"FORBIDDEN"}};}
  const target=body.userId;
  if(target==='__quarantine__'&&operation!=='admin-audit'){await client.query("COMMIT");return {status:404,body:{code:"NOT_FOUND"}};}
  if(target && !(operation==='admin-audit' && target==='__quarantine__')){
   const exists=await client.query("SELECT 1 FROM brai_identity WHERE user_id=$1 FOR UPDATE",[target]);
   if(!exists.rowCount){await client.query("COMMIT");return {status:404,body:{code:"NOT_FOUND"}};}
  }
  let result:Record<string,unknown>={success:true};
  if(operation==="users-list")result={users:(await client.query(userSelect+" ORDER BY u.id")).rows};
  if(operation==="users-get")result={user:(await client.query(userSelect+" WHERE u.id=$1",[target])).rows[0]};
  if(operation==="role-set"||operation==="status-set"){
   const before=(await client.query("SELECT role,status,profile_id FROM brai_identity WHERE user_id=$1",[target])).rows[0];
   const nextRole=operation==="role-set"?body.role:before.role;
   const nextStatus=operation==="status-set"?body.status:before.status;
   if(nextStatus==="active"&&!before.profile_id){await client.query("COMMIT");return {status:409,body:{code:"PROFILE_NOT_READY"}};}
   if(before.role==="admin"&&before.status==="active"&&(nextRole!=="admin"||nextStatus!=="active")){
    const count=await client.query("SELECT count(*)::integer AS count FROM brai_identity WHERE role='admin' AND status='active'");
    if(count.rows[0].count<=1){await client.query("COMMIT");return {status:409,body:{code:"LAST_ADMIN"}};}
   }
   await client.query("UPDATE brai_identity SET role=$2,status=$3 WHERE user_id=$1",[target,nextRole,nextStatus]);
   if(nextStatus!=="active")await client.query("DELETE FROM sys_telegram_link WHERE user_id=$1",[target]);
  }
  if(operation==="sessions-revoke")await client.query('DELETE FROM "session" WHERE "userId"=$1',[target]);
  if(operation==="invite-create"){
   const id=randomUUID(),code=randomBytes(32).toString("base64url");
   const digest=createHmac("sha256",secret).update("invite:"+code).digest("hex");
   await client.query("INSERT INTO brai_invite(id,digest,created_by,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')",[id,digest,actor]);
   result={invite:{...(await client.query(inviteSelect+" WHERE id=$1",[id])).rows[0],code}};
  }
  if(operation==="invite-list")result={invites:(await client.query(inviteSelect+" ORDER BY created_at DESC,id")).rows};
  if(operation==="invite-revoke"){
   const changed=await client.query("UPDATE brai_invite SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL AND consumed_at IS NULL RETURNING id",[body.inviteId]);
   if(!changed.rowCount){await client.query("COMMIT");return {status:404,body:{code:"NOT_FOUND"}};}
  }
  const writes=["role-set","status-set","sessions-revoke","invite-create","invite-revoke","admin-audit"];
  if(writes.includes(operation)){
   const auditId=randomUUID(), auditTarget=target??body.inviteId??String((result.invite as {id?:string}|undefined)?.id);
   await client.query("INSERT INTO brai_identity_audit(id,actor_id,target_id,action) VALUES($1,$2,$3,$4)",[auditId,actor,auditTarget,operation==="admin-audit"?body.action:operation]);
   if(operation==="admin-audit")result={auditId};
  }
  await client.query("COMMIT");return {status:200,body:result};
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
