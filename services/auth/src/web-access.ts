// ABOUTME: Применяет роли и поколения Auth также к альтернативному email-входу.
// ABOUTME: Непривязанные email-аккаунты сохраняют прежний вход; guest не получает cookie.
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { lifecycleLock } from "./lifecycle.js";
import { sessionIdentity } from "./v2.js";

type Handler=(request:Request)=>Promise<Response>;
type EmailGrant={userId:string|null;linked:boolean;generation:number|null;allowed:boolean};
const roles=["creator","admin","user"];
async function hasRegistry(pool:Pool){return !!(await pool.query("SELECT to_regclass('brai_identity') AS registry")).rows[0]?.registry;}
async function rawSession(cfg:Config,handler:Handler,headers:Headers){
 const response=await handler(new Request(cfg.origin+"/api/auth/get-session",{method:"GET",headers}));
 if(!response.ok)return null;
 return await response.json() as {user?:{id?:string};session?:{id?:string}}|null;
}
/** Проверяет legacy email или роль и поколение привязанного профиля без создания сессии. */
export async function permitsWebSession(pool:Pool,cfg:Config,handler:Handler,headers:Headers){
 const value=await rawSession(cfg,handler,headers);
 if(!value?.user?.id||!value.session?.id)return false;
 if(cfg.identityMode!=="telegram"&&(!await hasRegistry(pool)||!(await pool.query('SELECT 1 FROM brai_identity WHERE user_id=$1',[value.user.id])).rowCount))return true;
 return !!await sessionIdentity(pool,cfg,handler,headers);
}
/** До OTP фиксирует поколение; незнакомый адрес не получает назначенную продуктовую роль. */
export async function captureEmailGrant(pool:Pool,email:unknown):Promise<EmailGrant>{
 if(typeof email!=="string")return {userId:null,linked:false,generation:null,allowed:true};
 const registry=await hasRegistry(pool);
 const query=registry?'SELECT u.id,i.user_id,i.role,i.status,i.lifecycle_generation FROM "user" u LEFT JOIN brai_identity i ON i.user_id=u.id WHERE lower(u.email)=$1':'SELECT id FROM "user" WHERE lower(email)=$1';
 const row=(await pool.query(query,[email.trim().toLowerCase()])).rows[0];
 return {userId:row?.id??null,linked:!!row?.user_id,generation:row?.lifecycle_generation??null,allowed:!row?.user_id||row.status==='active'&&roles.includes(row.role)};
}
/** Подтверждает только захваченное до OTP поколение; при отказе удаляет новый вход. */
export async function confirmEmailSession(pool:Pool,cfg:Config,handler:Handler,headers:Headers,grant:EmailGrant){
 const value=await rawSession(cfg,handler,headers),userId=value?.user?.id,sessionId=value?.session?.id;
 if(!userId||!sessionId)return false;
 const client=await pool.connect();
 let valid=false;
 try{
  await client.query('BEGIN');await lifecycleLock(client);
  const registry=!!(await client.query("SELECT to_regclass('brai_identity') AS registry")).rows[0]?.registry;
  const row=registry?(await client.query('SELECT role,status,lifecycle_generation FROM brai_identity WHERE user_id=$1 FOR UPDATE',[userId])).rows[0]:null;
  valid=grant.allowed&&(!grant.userId||grant.userId===userId)&&(!row?!grant.linked:grant.linked&&roles.includes(row.role)&&row.status==='active'&&row.lifecycle_generation===grant.generation);
  if(valid&&row){
   const stamped=await client.query('UPDATE "session" SET brai_generation=$3 WHERE id=$1 AND "userId"=$2 RETURNING id',[sessionId,userId,grant.generation]);
   valid=!!stamped.rowCount;
  }
  if(!valid)await client.query('DELETE FROM "session" WHERE id=$1 AND "userId"=$2',[sessionId,userId]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 return valid&&await permitsWebSession(pool,cfg,handler,headers);
}
/** Извлекает cookie только в памяти сервера для проверки ответа официального движка. */
export function responseCookies(setCookies:string[]){return new Headers({cookie:setCookies.map(value=>value.split(';')[0]).join('; ')});}

