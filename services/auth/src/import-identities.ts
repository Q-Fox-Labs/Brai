// ABOUTME: Привязывает существующих пользователей Better Auth к Telegram из файла оператора.
// ABOUTME: Работает транзакционно только с правами владельца выделенной БД Auth.
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { lifecycleLock } from "./lifecycle.js";

const id=z.string().min(1).max(128);
const telegramId=z.string().regex(/^[1-9][0-9]{0,19}$/);
const item=z.strictObject({
 userId:id,telegramId,profileId:id.nullable(),role:z.enum(["creator","admin","user","guest"]),
 status:z.enum(["provisioning","active","blocked"]),name:z.string().min(1).max(200).optional(),
 telegramIds:z.array(telegramId).max(2).refine(ids=>ids.length===new Set(ids).size).optional()
});
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
if(new Set(items.map(value=>value.userId)).size!==items.length)throw new Error("Duplicate identity");
const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:5000});
try{
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const identity=(await client.query("SELECT current_user AS role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
  if(identity.role!==owner||identity.owner!==owner)throw new Error("Database owner required");
  await lifecycleLock(client);
  if(!(await client.query("SELECT 1 FROM brai_owner_bootstrap")).rowCount)throw new Error("Owner bootstrap required");
  const accountsToInsert: {userId:string;telegramIds:string[]}[]=[];
  for(const value of items){
   if(value.name!==undefined){
    const email=createHash("sha256").update(value.userId).digest("hex")+"@identity.brai.invalid";
    const user=await client.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now()) ON CONFLICT(id) DO NOTHING RETURNING id',[value.userId,value.name,email]);
    if(!user.rowCount){
     const existing=(await client.query('SELECT name FROM "user" WHERE id=$1 FOR UPDATE',[value.userId])).rows[0];
     if(existing?.name!==value.name)throw new Error("Display name conflict");
    }
   }
   const inserted=await client.query("INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO NOTHING RETURNING user_id",[value.userId,value.telegramId,value.profileId,value.role,value.status]);
   if(!inserted.rowCount){
    const row=(await client.query("SELECT telegram_id,profile_id,role,status FROM brai_identity WHERE user_id=$1",[value.userId])).rows[0];
    if(!row||row.telegram_id!==value.telegramId||row.profile_id!==value.profileId||row.role!==value.role||row.status!==value.status)throw new Error("Identity conflict");
    if(value.telegramIds!==undefined){
     const accounts=(await client.query("SELECT telegram_id FROM sys_telegram_account WHERE user_id=$1",[value.userId])).rows.map(row=>String(row.telegram_id)).sort();
     if(JSON.stringify(accounts)!==JSON.stringify([...value.telegramIds].sort()))throw new Error("Telegram binding conflict");
    }
   }else{
    if(value.telegramIds!==undefined){
     // AIDEV-NOTE: Stable memory author and live Telegram accounts can differ.
     // Remove only the trigger's bootstrap binding on the new identity.
     await client.query("DELETE FROM sys_telegram_account WHERE user_id=$1 AND telegram_id=$2",[value.userId,value.telegramId]);
     accountsToInsert.push({userId:value.userId,telegramIds:value.telegramIds});
    }
    await client.query("INSERT INTO brai_identity_audit(id,actor_id,target_id,action) VALUES($1,'operator',$2,'identity-import')",[randomUUID(),value.userId]);
   }
  }
  for(const value of accountsToInsert){
   for(const account of value.telegramIds)await client.query("INSERT INTO sys_telegram_account(telegram_id,user_id) VALUES($1,$2)",[account,value.userId]);
  }
  await client.query("COMMIT");console.log("auth identities imported");
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}catch{console.error("auth identity import failed");process.exitCode=1;}finally{await pool.end();}
