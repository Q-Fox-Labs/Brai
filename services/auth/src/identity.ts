// ABOUTME: Управляет привязками идентичности в отдельной базе Auth.
// ABOUTME: Доверенный запрос не может создать первого администратора по сети.
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { authLimit } from "./login-code.js";
import type { Pool } from "pg";
import { insertIdentity } from "./identity-record.js";
import { lifecycleLock, requestLifecycle } from "./lifecycle.js";
import type { IdentityUser, ProvisionRequest } from "./identity-types.js";

const selectUser=`SELECT u.id,u.name,i.role,i.status,i.telegram_id AS "telegramId",i.profile_id AS "profileId",i.lifecycle_generation AS generation,i.applied_generation AS "appliedGeneration"
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
  await lifecycleLock(client);
  const previous=await client.query(`SELECT r.fingerprint,${selectUser.slice(7)} JOIN brai_identity_request r ON r.user_id=i.user_id WHERE r.request_id=$1`,[input.requestId]);
  if(previous.rowCount){if(previous.rows[0].fingerprint!==fingerprint)throw new Error("Request conflict");const {fingerprint:_,...user}=previous.rows[0];await client.query("COMMIT");return user;}
  if(input.role==='creator'||input.role==='guest')throw new Error('Role assignment requires lifecycle operation');
  if(input.role==='admin'&&!(await client.query("SELECT 1 FROM brai_identity WHERE role IN ('creator','admin') AND status='active' LIMIT 1")).rowCount)throw new Error('Owner bootstrap required');
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
  await lifecycleLock(client);
  const managed=await client.query("SELECT state FROM brai_user_operation WHERE user_id=$1 ORDER BY generation DESC LIMIT 1",[userId]);
  const current=await client.query("SELECT profile_id,status FROM brai_identity WHERE user_id=$1 FOR UPDATE",[userId]);
  if(!current.rowCount||(managed.rowCount&&(current.rows[0].status!=="active"||managed.rows[0].state!=="succeeded"))||current.rows[0].status==="blocked"||(current.rows[0].profile_id&&current.rows[0].profile_id!==profileId)){await client.query("COMMIT");return null;}
  if(managed.rowCount){const result=await client.query(selectUser+" WHERE i.user_id=$1",[userId]);await client.query("COMMIT");return result.rows[0]??null;}
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
  await lifecycleLock(client);
  const invite=await client.query("SELECT id,role,consumed_by,revoked_at,expires_at FROM brai_invite WHERE digest=$1 FOR UPDATE",[digest]);
  if(!invite.rowCount||invite.rows[0].revoked_at){await client.query("COMMIT");return null;}
  const existing=await client.query(selectUser+" JOIN sys_telegram_account a ON a.user_id=i.user_id WHERE a.telegram_id=$1",[telegramId]);
  const previous:IdentityUser|undefined=existing.rows[0];
  if(previous&&!invite.rows[0].consumed_by&&previous.role!==invite.rows[0].role){await client.query('COMMIT');return null;}
  if(previous?.status==='blocked'){await client.query("COMMIT");return null;}
  const ensureProfile=async(user:IdentityUser):Promise<IdentityUser|null>=>{
   if(user.profileId)return user;
   if(user.status!=='provisioning')return null;
   await client.query("UPDATE brai_identity SET profile_id=$2 WHERE user_id=$1 AND status='provisioning' AND profile_id IS NULL",[user.id,randomUUID()]);
   const current=await client.query(selectUser+" WHERE i.user_id=$1",[user.id]);
   const refreshed:IdentityUser|undefined=current.rows[0];
   return refreshed&&refreshed.status!=='blocked'&&refreshed.profileId?refreshed:null;
  };
  const queueProfile=async(user:IdentityUser):Promise<IdentityUser|null>=>{
   if(user.status!=='provisioning')return user;
   const latest=(await client.query('SELECT request_id,kind,state FROM brai_user_operation WHERE user_id=$1 ORDER BY generation DESC LIMIT 1',[user.id])).rows[0];
   if(latest&&latest.kind==='prepare'&&['pending','running'].includes(latest.state))return user;
   const prefix='invite:'+invite.rows[0].id+':';
   // AIDEV-NOTE: Старое приглашение не отменяет terminal admin-решение или чужую ошибку.
   if(latest&&!(latest.state==='failed'&&latest.request_id.startsWith(prefix)))return null;
   const generation=(await client.query('SELECT lifecycle_generation FROM brai_identity WHERE user_id=$1',[user.id])).rows[0].lifecycle_generation+1;
   const queued=await requestLifecycle(client,user.id,'invite-profile',{requestId:prefix+generation,userId:user.id});
   if(queued.status!==200)throw new Error('Invite lifecycle unavailable');
   return (await client.query(selectUser+' WHERE i.user_id=$1',[user.id])).rows[0]??null;
  };
  if(invite.rows[0].consumed_by){
   const user=previous&&previous.id===invite.rows[0].consumed_by?await ensureProfile(previous):null;
   const queued=user?await queueProfile(user):null;
   await client.query("COMMIT");return queued;
  }
  if((invite.rows[0].expires_at as Date).getTime()<=Date.now()){await client.query("COMMIT");return null;}
  let user=previous?await ensureProfile(previous):null;
  if(previous&&!user){await client.query("COMMIT");return null;}
  if(!user){
   const id=randomUUID(),profileId=randomUUID(),userName=name??"Пользователь";
   await client.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',[id,userName,asSyntheticEmail(id)]);
   user=await insertIdentity(client,{id,name:userName,role:invite.rows[0].role,status:"provisioning",telegramId,profileId});
  }
  await client.query("UPDATE brai_invite SET consumed_at=now(),consumed_by=$2 WHERE id=$1",[invite.rows[0].id,user.id]);
  const queued=await queueProfile(user);
  await client.query("COMMIT");return queued;
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

/** Выпускает одноразовый секрет привязки для уже активного пользователя, не для модели. */
export async function issueTelegramLink(pool:Pool,secret:string,telegramId:string) {
 const client=await pool.connect();
 try {
  await client.query("BEGIN");
  const found=await client.query(selectUser+" JOIN sys_telegram_account a ON a.user_id=i.user_id WHERE a.telegram_id=$1 AND i.status='active' AND i.role IN ('creator','admin','user') FOR UPDATE OF i",[telegramId]);
  const user:IdentityUser|undefined=found.rows[0];
  // AIDEV-NOTE: Отвязка могла закончиться за время ожидания i-lock; нужен новый statement snapshot аккаунта.
  const account=user?await client.query("SELECT 1 FROM sys_telegram_account WHERE telegram_id=$1 AND user_id=$2",[telegramId,user.id]):null;
  const count=user?(await client.query("SELECT count(*)::integer AS count FROM sys_telegram_account WHERE user_id=$1",[user.id])).rows[0].count:0;
  if(!user?.profileId||!account?.rowCount||count>=2||!await authLimit(client,secret,`telegram-link-issue:${user.id}`,3)){await client.query("COMMIT");return null;}
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
  await lifecycleLock(client);
  const global=await authLimit(client,secret,"telegram-link-redeem:global",300);
  const local=await authLimit(client,secret,`telegram-link-redeem:${telegramId}`,10);
  if(!global||!local){await client.query("COMMIT");return null;}
  const found=await client.query(`SELECT l.*,i.status,i.role,i.profile_id FROM sys_telegram_link l
   JOIN brai_identity i ON i.user_id=l.user_id WHERE l.digest=$1 FOR UPDATE OF l,i`,[digest]);
  const link=found.rows[0];
  if(!link||link.status!=="active"||!link.profile_id||!["creator","admin","user"].includes(link.role)){await client.query("COMMIT");return null;}
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
  await lifecycleLock(client);
  const found=await client.query(selectUser+" JOIN sys_telegram_account a ON a.user_id=i.user_id WHERE a.telegram_id=$1 AND i.status='active' AND i.role IN ('creator','admin','user') FOR UPDATE OF i",[telegramId]);
  const user:IdentityUser|undefined=found.rows[0];
  if(!user){await client.query("COMMIT");return false;}
  const accounts=await client.query("SELECT telegram_id FROM sys_telegram_account WHERE user_id=$1",[user.id]);
  // AIDEV-NOTE: Здесь учитываются все реализованные каналы связи; сейчас подключён только Telegram.
  if(!accounts.rows.some(row=>row.telegram_id===targetTelegramId)||(["creator","admin"].includes(user.role)&&accounts.rows.length<=1)){await client.query("COMMIT");return false;}
  await client.query("DELETE FROM sys_telegram_account WHERE telegram_id=$1 AND user_id=$2",[targetTelegramId,user.id]);
  // AIDEV-NOTE: Уже погашенный код не должен создать новую действующую сессию после отвязки.
  await client.query("UPDATE brai_identity SET lifecycle_generation=lifecycle_generation+1 WHERE user_id=$1",[user.id]);
  await client.query('DELETE FROM "session" WHERE "userId"=$1',[user.id]);
  await client.query("DELETE FROM brai_login_code WHERE user_id=$1",[user.id]);
  await client.query("DELETE FROM sys_telegram_link WHERE user_id=$1",[user.id]);
  await client.query("INSERT INTO brai_identity_audit(id,actor_id,target_id,action) VALUES($1,$2,$2,'telegram-unlink')",[randomUUID(),user.id]);
  await client.query("COMMIT");return true;
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}

function asSyntheticEmail(id:string):string {
 return createHash("sha256").update(id).digest("hex")+"@identity.brai.invalid";
}
