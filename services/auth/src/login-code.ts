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
async function limit(client:PoolClient,secret:string,key:string,max:number):Promise<boolean> {
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
  const user=await client.query("SELECT user_id FROM brai_identity WHERE telegram_id=$1 AND status='active' FOR UPDATE",[telegramId]);
  if(!user.rowCount){await client.query("COMMIT");return null;}
  const id:string=user.rows[0].user_id;
  if(!await limit(client,secret,`issue:${id}`,3)){await client.query("COMMIT");return null;}
  const code=Array.from(randomBytes(12),byte=>alphabet[byte&31]).join("");
  const saved=await client.query(`INSERT INTO brai_login_code(user_id,digest,expires_at) VALUES($1,$2,now()+interval '120 seconds')
   ON CONFLICT(user_id) DO UPDATE SET digest=EXCLUDED.digest,expires_at=EXCLUDED.expires_at RETURNING expires_at`,[id,digest(secret,`code:${code}`)]);
  await client.query("COMMIT");return {code,expiresAt:(saved.rows[0].expires_at as Date).toISOString()};
 } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
}
/** Погашает код и возвращает поколение доступа, к которому относится вход. */
export async function consumeCodeGrant(pool:Pool,secret:string,input:string,clientKey:string):Promise<{userId:string;generation:number}|null> {
 const client=await pool.connect();
 try {
  await client.query("BEGIN");
  const global=await limit(client,secret,"redeem:global",300);
  const local=await limit(client,secret,`redeem:client:${clientKey}`,10);
  const code=normalizeCode(input);let grant:{userId:string;generation:number}|null=null;
  if(global&&local&&code){const row=await client.query(`DELETE FROM brai_login_code c USING brai_identity i WHERE c.user_id=i.user_id AND i.status='active' AND c.digest=$1 AND c.expires_at>now() RETURNING c.user_id,i.lifecycle_generation`,[digest(secret,`code:${code}`)]);grant=row.rows[0]?{userId:row.rows[0].user_id,generation:row.rows[0].lifecycle_generation}:null;}
  await client.query("COMMIT");return grant;
 } catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
}

/** Сохраняет прежний интерфейс однократного чтения ID для операторских проверок. */
export async function consumeCode(pool:Pool,secret:string,input:string,clientKey:string):Promise<string|null> {
 return (await consumeCodeGrant(pool,secret,input,clientKey))?.userId??null;
}
