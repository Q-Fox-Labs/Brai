// ABOUTME: Привязывает существующих пользователей Better Auth к Telegram из файла оператора.
// ABOUTME: Работает транзакционно только с правами владельца выделенной БД Auth.
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";

const id=z.string().min(1).max(128);
const item=z.strictObject({userId:id,telegramId:z.string().regex(/^[0-9]{1,20}$/),profileId:id.nullable(),role:z.enum(["admin","user"]),status:z.enum(["provisioning","active","blocked"])});
const path=process.env.AUTH_IMPORT_FILE, databaseURL=process.env.AUTH_DATABASE_URL, owner=process.env.AUTH_OWNER_ROLE;
if(!path||!databaseURL||!owner)throw new Error("Import configuration required");
const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw:string;
try{
 const stat=fstatSync(fd);
 if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>1_000_000)throw new Error("Unsafe import file");
 raw=readFileSync(fd,"utf8");
}finally{closeSync(fd);}
const items=z.array(item).max(10000).parse(JSON.parse(raw));
if(items.some(value=>value.status==="active"&&!value.profileId))throw new Error("Active identity requires profile");
const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:5000});
try{
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const identity=(await client.query("SELECT current_user AS role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
  if(identity.role!==owner||identity.owner!==owner)throw new Error("Database owner required");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('brai-identity-provision',0))");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('brai-admin',0))");
  if(!(await client.query("SELECT 1 FROM brai_owner_bootstrap")).rowCount)throw new Error("Owner bootstrap required");
  for(const value of items){
   const inserted=await client.query("INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO NOTHING RETURNING user_id",[value.userId,value.telegramId,value.profileId,value.role,value.status]);
   if(!inserted.rowCount){
    const row=(await client.query("SELECT telegram_id,profile_id,role,status FROM brai_identity WHERE user_id=$1",[value.userId])).rows[0];
    if(!row||row.telegram_id!==value.telegramId||row.profile_id!==value.profileId||row.role!==value.role||row.status!==value.status)throw new Error("Identity conflict");
   }else await client.query("INSERT INTO brai_identity_audit(id,actor_id,target_id,action) VALUES($1,'operator',$2,'identity-import')",[randomUUID(),value.userId]);
  }
  await client.query("COMMIT");console.log("auth identities imported");
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}catch{console.error("auth identity import failed");process.exitCode=1;}finally{await pool.end();}
