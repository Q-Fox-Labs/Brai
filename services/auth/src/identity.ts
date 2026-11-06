// ABOUTME: Управляет привязками идентичности в отдельной базе Auth.
// ABOUTME: Доверенный запрос не может создать первого администратора по сети.
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { IdentityUser, ProvisionRequest } from "./identity-types.js";

const selectUser=`SELECT u.id,u.name,i.role,i.status,i.telegram_id AS "telegramId",i.profile_id AS "profileId"
 FROM brai_identity i JOIN "user" u ON u.id=i.user_id`;
/** Ищет идентичность по Telegram без раскрытия внутреннего email. */
export async function resolveTelegram(pool:Pool,telegramId:string):Promise<IdentityUser|null> {
 const result=await pool.query(`${selectUser} WHERE i.telegram_id=$1`,[telegramId]);
 return result.rows[0]??null;
}
/** Идемпотентно создаёт идентичность; конфликт повторного запроса отклоняется. */
export async function provision(pool:Pool,secret:string,input:ProvisionRequest):Promise<IdentityUser> {
 const client=await pool.connect();
 const canonical=[input.requestId,input.telegramId,input.name??null,input.role,input.userId??null,input.profileId??null,input.status];
 const fingerprint=createHmac("sha256",secret).update(JSON.stringify(canonical)).digest("hex");
 try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('brai-identity-provision',0))");
  const previous=await client.query(`SELECT r.fingerprint,${selectUser.slice(7)} JOIN brai_identity_request r ON r.user_id=i.user_id WHERE r.request_id=$1`,[input.requestId]);
  if(previous.rowCount){if(previous.rows[0].fingerprint!==fingerprint)throw new Error("Request conflict");const {fingerprint:_,...user}=previous.rows[0];await client.query("COMMIT");return user;}
  if(input.role==='admin') {const admins=await client.query("SELECT 1 FROM brai_identity WHERE role='admin' AND status='active' LIMIT 1");if(!admins.rowCount)throw new Error("Owner bootstrap required");}
  const found=await client.query(`${selectUser} WHERE i.telegram_id=$1`,[input.telegramId]);
  let user:IdentityUser=found.rows[0];
  if(user){if((input.userId&&input.userId!==user.id)||input.role!==user.role||input.status!==user.status||(input.profileId&&input.profileId!==user.profileId))throw new Error("Identity conflict");}
  else {
   const id=input.userId??randomUUID();const name=input.name??"Пользователь";
   await client.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,false,now(),now())',[id,name,asSyntheticEmail(id)]);
   await client.query('INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,$2,$3,$4,$5)',[id,input.telegramId,input.profileId??null,input.role,input.status]);
   user={id,name,role:input.role,status:input.status,telegramId:input.telegramId,profileId:input.profileId??null};
  }
  await client.query('INSERT INTO brai_identity_request(request_id,fingerprint,user_id) VALUES($1,$2,$3)',[input.requestId,fingerprint,user.id]);
  await client.query("COMMIT");return user;
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

/** Переводит ожидающий профиль в active и сохраняет уникальную привязку. */
export async function profileReady(pool:Pool,userId:string,profileId:string):Promise<IdentityUser|null> {
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const current=await client.query("SELECT profile_id,status FROM brai_identity WHERE user_id=$1 FOR UPDATE",[userId]);
  if(!current.rowCount||current.rows[0].status==="blocked"||(current.rows[0].profile_id&&current.rows[0].profile_id!==profileId)){await client.query("COMMIT");return null;}
  await client.query("UPDATE brai_identity SET profile_id=$2,status='active' WHERE user_id=$1",[userId,profileId]);
  const result=await client.query(selectUser+" WHERE i.user_id=$1",[userId]);
  await client.query("COMMIT");return result.rows[0]??null;
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
/** Погашает приглашение один раз, повтор отправителя возвращает его идентичность. */
export async function redeemInvite(pool:Pool,secret:string,telegramId:string,code:string,name?:string):Promise<IdentityUser|null> {
 const client=await pool.connect(), digest=createHmac("sha256",secret).update("invite:"+code).digest("hex");
 try{
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('brai-identity-provision',0))");
  const invite=await client.query("SELECT id,consumed_by,revoked_at,expires_at FROM brai_invite WHERE digest=$1 FOR UPDATE",[digest]);
  if(!invite.rowCount||invite.rows[0].revoked_at){await client.query("COMMIT");return null;}
  const existing=await client.query(selectUser+" WHERE i.telegram_id=$1",[telegramId]);
  const previous:IdentityUser|undefined=existing.rows[0];
  if(previous?.status==='blocked'){await client.query("COMMIT");return null;}
  const ensureProfile=async(user:IdentityUser):Promise<IdentityUser|null>=>{
   if(user.profileId)return user;
   if(user.status!=='provisioning')return null;
   await client.query("UPDATE brai_identity SET profile_id=$2 WHERE user_id=$1 AND status='provisioning' AND profile_id IS NULL",[user.id,randomUUID()]);
   const current=await client.query(selectUser+" WHERE i.user_id=$1",[user.id]);
   const refreshed:IdentityUser|undefined=current.rows[0];
   return refreshed&&refreshed.status!=='blocked'&&refreshed.profileId?refreshed:null;
  };
  if(invite.rows[0].consumed_by){
   const user=previous&&previous.id===invite.rows[0].consumed_by?await ensureProfile(previous):null;
   await client.query("COMMIT");return user;
  }
  if((invite.rows[0].expires_at as Date).getTime()<=Date.now()){await client.query("COMMIT");return null;}
  let user=previous?await ensureProfile(previous):null;
  if(previous&&!user){await client.query("COMMIT");return null;}
  if(!user){
   const id=randomUUID(),profileId=randomUUID(),userName=name??"Пользователь";
   await client.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',[id,userName,asSyntheticEmail(id)]);
   await client.query("INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,$2,$3,'user','provisioning')",[id,telegramId,profileId]);
   user={id,name:userName,role:"user",status:"provisioning",telegramId,profileId};
  }
  await client.query("UPDATE brai_invite SET consumed_at=now(),consumed_by=$2 WHERE id=$1",[invite.rows[0].id,user.id]);
  await client.query("COMMIT");return user;
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}
function asSyntheticEmail(id:string):string {
 return createHash("sha256").update(id).digest("hex")+"@identity.brai.invalid";
}
