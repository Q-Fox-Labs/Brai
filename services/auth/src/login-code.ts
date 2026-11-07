// ABOUTME: Выпускает и атомарно погашает короткие коды входа Telegram.
// ABOUTME: Не создаёт сессии и не отправляет сообщения; секреты хранятся как HMAC.
import { createHmac, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

const alphabet="0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const digest=(secret:string,value:string)=>createHmac("sha256",secret).update(value).digest("hex");
/** Нормализует группировку кода; недопустимые символы дают null. */
export function normalizeCode(value:string):string|null {
 const code=value.toUpperCase().replaceAll("-","");
 return /^[0-9A-HJKMNP-TV-Z]{12}$/.test(code)?code:null;
}
/** Атомарно проверяет общее минутное окно; вызывается внутри транзакции операции Auth. */
export async function authLimit(client:PoolClient,secret:string,key:string,max:number):Promise<boolean> {
 const result=await client.query(`INSERT INTO brai_auth_limit(key,window_started,count) VALUES($1,now(),1)
 ON CONFLICT(key) DO UPDATE SET window_started=CASE WHEN brai_auth_limit.window_started <= now()-interval '60 seconds' THEN now() ELSE brai_auth_limit.window_started END,
 count=CASE WHEN brai_auth_limit.window_started <= now()-interval '60 seconds' THEN 1 ELSE brai_auth_limit.count+1 END RETURNING count`,[digest(secret,key)]);
 return result.rows[0].count<=max;
}
/** Создаёт новый код для активной идентичности, не более трёх за минуту. */
export async function issueCode(pool:Pool,secret:string,telegramId:string) {
 const client=await pool.connect();
 try {
  await client.query("BEGIN");
  const user=await client.query("SELECT i.user_id FROM brai_identity i JOIN sys_telegram_account a ON a.user_id=i.user_id WHERE a.telegram_id=$1 AND i.status='active' FOR UPDATE OF i",[telegramId]);
  if(!user.rowCount){await client.query("COMMIT");return null;}
  const id:string=user.rows[0].user_id;
  if(!await authLimit(client,secret,`issue:${id}`,3)){await client.query("COMMIT");return null;}
  const code=Array.from(randomBytes(12),byte=>alphabet[byte&31]).join("");
  const saved=await client.query(`INSERT INTO brai_login_code(user_id,digest,expires_at) VALUES($1,$2,now()+interval '120 seconds')
   ON CONFLICT(user_id) DO UPDATE SET digest=EXCLUDED.digest,expires_at=EXCLUDED.expires_at RETURNING expires_at`,[id,digest(secret,`code:${code}`)]);
  await client.query("COMMIT");return {code,expiresAt:(saved.rows[0].expires_at as Date).toISOString()};
 } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
}
/** Однократно возвращает ID активного пользователя; лимиты не зависят от кода. */
export async function consumeCode(pool:Pool,secret:string,input:string,clientKey:string):Promise<string|null> {
 const client=await pool.connect();
 try {
  await client.query("BEGIN");
  const global=await authLimit(client,secret,"redeem:global",300);
  const local=await authLimit(client,secret,`redeem:client:${clientKey}`,10);
  const code=normalizeCode(input);let id:string|null=null;
  if(global&&local&&code){const row=await client.query(`DELETE FROM brai_login_code c USING brai_identity i WHERE c.user_id=i.user_id AND i.status='active' AND c.digest=$1 AND c.expires_at>now() RETURNING c.user_id`,[digest(secret,`code:${code}`)]);id=row.rows[0]?.user_id??null;}
  await client.query("COMMIT");return id;
 } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
}
