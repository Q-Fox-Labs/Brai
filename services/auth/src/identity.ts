// ABOUTME: Управляет привязками идентичности в отдельной базе Auth.
// ABOUTME: Доверенный запрос не может создать первого администратора по сети.
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { authLimit } from "./login-code.js";
import type { Pool, PoolClient } from "pg";
import type { IdentityUser, ProvisionRequest } from "./identity-types.js";

const selectUser=`SELECT u.id,u.name,i.role,i.status,i.telegram_id AS "telegramId",i.profile_id AS "profileId"
 FROM brai_identity i JOIN "user" u ON u.id=i.user_id`;
/** Ищет идентичность по Telegram без раскрытия внутреннего email. */
export async function resolveTelegram(pool:Pool,telegramId:string):Promise<IdentityUser|null> {
 const result=await pool.query(`${selectUser} JOIN sys_telegram_account a ON a.user_id=i.user_id WHERE a.telegram_id=$1`,[telegramId]);
 return result.rows[0]??null;
}
/** Читает владельца независимо от подключённых каналов; доступен только доверенному Control. */
export async function getIdentity(pool:Pool,userId:string) {
 const result=await pool.query(`${selectUser} WHERE i.user_id=$1`,[userId]);
 const telegramIds=(await pool.query("SELECT telegram_id FROM sys_telegram_account WHERE user_id=$1 ORDER BY telegram_id",[userId])).rows.map(row=>row.telegram_id as string);
 return {user:result.rows[0]??null,telegramIds};
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
  const found=await client.query(`${selectUser} JOIN sys_telegram_account a ON a.user_id=i.user_id WHERE a.telegram_id=$1`,[input.telegramId]);
  let user:IdentityUser=found.rows[0];
  if(user){if((input.userId&&input.userId!==user.id)||input.role!==user.role||input.status!==user.status||(input.profileId&&input.profileId!==user.profileId))throw new Error("Identity conflict");}
  else {
   const id=input.userId??randomUUID();const name=input.name??"Пользователь";
   await client.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,false,now(),now())',[id,name,asSyntheticEmail(id)]);
   user=await insertIdentity(client,{id,name,role:input.role,status:input.status,telegramId:input.telegramId,profileId:input.profileId??null});
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
  const existing=await client.query(selectUser+" JOIN sys_telegram_account a ON a.user_id=i.user_id WHERE a.telegram_id=$1",[telegramId]);
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
   user=await insertIdentity(client,{id,name:userName,role:"user",status:"provisioning",telegramId,profileId});
  }
  await client.query("UPDATE brai_invite SET consumed_at=now(),consumed_by=$2 WHERE id=$1",[invite.rows[0].id,user.id]);
  await client.query("COMMIT");return user;
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

/** Выпускает одноразовый секрет привязки для уже активного пользователя, не для модели. */
export async function issueTelegramLink(pool:Pool,secret:string,telegramId:string) {
 const client=await pool.connect();
 try {
  await client.query("BEGIN");
  const found=await client.query(selectUser+" JOIN sys_telegram_account a ON a.user_id=i.user_id WHERE a.telegram_id=$1 AND i.status='active' FOR UPDATE OF i",[telegramId]);
  const user:IdentityUser|undefined=found.rows[0];
  const count=user?(await client.query("SELECT count(*)::integer AS count FROM sys_telegram_account WHERE user_id=$1",[user.id])).rows[0].count:0;
  if(!user?.profileId||count>=2||!await authLimit(client,secret,`telegram-link-issue:${user.id}`,3)){await client.query("COMMIT");return null;}
  const code=randomBytes(32).toString("base64url"),digest=createHmac("sha256",secret).update("telegram-link:"+code).digest("hex");
  const saved=await client.query(`INSERT INTO sys_telegram_link(user_id,digest,expires_at) VALUES($1,$2,now()+interval '10 minutes')
   ON CONFLICT(user_id) DO UPDATE SET digest=EXCLUDED.digest,expires_at=EXCLUDED.expires_at,consumed_by=NULL,consumed_at=NULL RETURNING expires_at`,[user.id,digest]);
  await client.query("COMMIT");return {code,expiresAt:(saved.rows[0].expires_at as Date).toISOString()};
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

/** Привязывает свободный аккаунт без создания профиля; повтор не восстанавливает отозванный доступ. */
export async function redeemTelegramLink(pool:Pool,secret:string,telegramId:string,code:string):Promise<IdentityUser|null> {
 const client=await pool.connect(),digest=createHmac("sha256",secret).update("telegram-link:"+code).digest("hex");
 try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('brai-identity-provision',0))");
  const global=await authLimit(client,secret,"telegram-link-redeem:global",300);
  const local=await authLimit(client,secret,`telegram-link-redeem:${telegramId}`,10);
  if(!global||!local){await client.query("COMMIT");return null;}
  const found=await client.query(`SELECT l.*,i.status,i.profile_id FROM sys_telegram_link l
   JOIN brai_identity i ON i.user_id=l.user_id WHERE l.digest=$1 FOR UPDATE OF l,i`,[digest]);
  const link=found.rows[0];
  if(!link||link.status!=="active"||!link.profile_id){await client.query("COMMIT");return null;}
  const account=await client.query("SELECT user_id FROM sys_telegram_account WHERE telegram_id=$1",[telegramId]);
  if(link.consumed_by){
   const valid=link.consumed_by===telegramId&&account.rows[0]?.user_id===link.user_id;
   const result=valid?await client.query(selectUser+" WHERE i.user_id=$1",[link.user_id]):null;
   await client.query("COMMIT");return result?.rows[0]??null;
  }
  if((link.expires_at as Date).getTime()<=Date.now()||account.rows[0]&&account.rows[0].user_id!==link.user_id){await client.query("COMMIT");return null;}
  if(!account.rowCount){
   const count=await client.query("SELECT count(*)::integer AS count FROM sys_telegram_account WHERE user_id=$1",[link.user_id]);
   if(count.rows[0].count>=2){await client.query("COMMIT");return null;}
   await client.query("INSERT INTO sys_telegram_account(telegram_id,user_id) VALUES($1,$2)",[telegramId,link.user_id]);
  }
  await client.query("UPDATE sys_telegram_link SET consumed_by=$2,consumed_at=now() WHERE user_id=$1",[link.user_id,telegramId]);
  await client.query("INSERT INTO brai_identity_audit(id,actor_id,target_id,action) VALUES($1,$2,$2,'telegram-link')",[randomUUID(),link.user_id]);
  const result=await client.query(selectUser+" WHERE i.user_id=$1",[link.user_id]);
  await client.query("COMMIT");return result.rows[0]??null;
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

/** Отзывает свой выбранный канал; администратор сохраняет хотя бы один канал связи. */
export async function unlinkTelegram(pool:Pool,telegramId:string,targetTelegramId:string):Promise<boolean> {
 const client=await pool.connect();
 try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('brai-identity-provision',0))");
  const found=await client.query(selectUser+" JOIN sys_telegram_account a ON a.user_id=i.user_id WHERE a.telegram_id=$1 AND i.status='active' FOR UPDATE OF i",[telegramId]);
  const user:IdentityUser|undefined=found.rows[0];
  if(!user){await client.query("COMMIT");return false;}
  const accounts=await client.query("SELECT telegram_id FROM sys_telegram_account WHERE user_id=$1",[user.id]);
  // AIDEV-NOTE: Здесь учитываются все реализованные каналы связи; сейчас подключён только Telegram.
  if(!accounts.rows.some(row=>row.telegram_id===targetTelegramId)||(user.role==="admin"&&accounts.rows.length<=1)){await client.query("COMMIT");return false;}
  await client.query("DELETE FROM sys_telegram_account WHERE telegram_id=$1 AND user_id=$2",[targetTelegramId,user.id]);
  await client.query('DELETE FROM "session" WHERE "userId"=$1',[user.id]);
  await client.query("DELETE FROM brai_login_code WHERE user_id=$1",[user.id]);
  await client.query("DELETE FROM sys_telegram_link WHERE user_id=$1",[user.id]);
  await client.query("INSERT INTO brai_identity_audit(id,actor_id,target_id,action) VALUES($1,$2,$2,'telegram-unlink')",[randomUUID(),user.id]);
  await client.query("COMMIT");return true;
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

/** Сохраняет автора памяти отдельно от повторно используемого внешнего аккаунта. Вызывается под provision-lock. */
async function insertIdentity(client:PoolClient,user:IdentityUser&{telegramId:string}):Promise<IdentityUser> {
 const telegramId=user.telegramId;let author=telegramId;
 while((await client.query("SELECT 1 FROM brai_identity WHERE telegram_id=$1 UNION ALL SELECT 1 FROM sys_telegram_account WHERE telegram_id=$1",[author])).rowCount){
  author="9"+randomBytes(8).readBigUInt64BE().toString().padStart(20,"0").slice(-19);
 }
 await client.query("INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,$2,$3,$4,$5)",[user.id,author,user.profileId,user.role,user.status]);
 if(author!==telegramId){
  // AIDEV-NOTE: Триггер обслуживает первоначальную регистрацию; синтетический автор не является каналом доступа.
  await client.query("DELETE FROM sys_telegram_account WHERE telegram_id=$1 AND user_id=$2",[author,user.id]);
  await client.query("INSERT INTO sys_telegram_account(telegram_id,user_id) VALUES($1,$2)",[telegramId,user.id]);
 }
 return {...user,telegramId:author};
}

function asSyntheticEmail(id:string):string {
 return createHash("sha256").update(id).digest("hex")+"@identity.brai.invalid";
}
