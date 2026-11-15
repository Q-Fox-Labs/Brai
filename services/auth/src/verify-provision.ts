// ABOUTME: Проверяет созданные provisioning идентичности перед переключением Auth.
// ABOUTME: Запускается владельцем БД и не выводит идентификаторы или данные пользователей.
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { z } from "zod";

const id=z.string().min(1).max(128);
const item=z.strictObject({telegramId:z.string().regex(/^[1-9][0-9]{0,19}$/),userId:id,profileId:id,role:z.enum(["creator","admin","user","guest"]),status:z.literal("provisioning")});
const data=z.strictObject({version:z.literal(1),originalBraiOwnerId:id,originalTelegramOwnerId:z.string().regex(/^[1-9][0-9]{0,19}$/),accounts:z.array(item).min(1).max(10000)});
const path=process.env.AUTH_ACCOUNTS_FILE,databaseURL=process.env.AUTH_DATABASE_URL,owner=process.env.AUTH_OWNER_ROLE;
if(!path||!databaseURL||!owner)throw new Error("Verify configuration required");
const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw:string;
try{
 const stat=fstatSync(fd);
 if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>1_000_000)throw new Error("Unsafe accounts file");
 raw=readFileSync(fd,"utf8");
}finally{closeSync(fd);}
const plan=data.parse(JSON.parse(raw));
const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:5000});
try{
 const identity=(await pool.query("SELECT current_user AS role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
 if(identity.role!==owner||identity.owner!==owner)throw new Error("Database owner required");
 const admins=plan.accounts.filter(value=>value.role==="admin"||value.role==="creator");
 if(admins.length!==1||admins[0].userId!==plan.originalBraiOwnerId||admins[0].telegramId!==plan.originalTelegramOwnerId)throw new Error("Invalid owner");
 if(new Set(plan.accounts.map(value=>value.userId)).size!==plan.accounts.length||new Set(plan.accounts.map(value=>value.telegramId)).size!==plan.accounts.length||new Set(plan.accounts.map(value=>value.profileId)).size!==plan.accounts.length)throw new Error("Duplicate identity");
 const client=await pool.connect();
 try{
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const marker=await client.query("SELECT user_id FROM brai_owner_bootstrap");
  if(marker.rowCount!==1||marker.rows[0].user_id!==plan.originalBraiOwnerId)throw new Error("Owner mismatch");
  const totals=await client.query("SELECT count(*)::integer AS identities,count(*) FILTER (WHERE role IN ('admin','creator'))::integer AS admins FROM brai_identity");
  if(totals.rows[0].identities!==plan.accounts.length||totals.rows[0].admins!==1)throw new Error("Unexpected identities");
  for(const item of plan.accounts){
   const result=await client.query('SELECT i.telegram_id,i.profile_id,i.role,i.status FROM brai_identity i JOIN "user" u ON u.id=i.user_id WHERE i.user_id=$1',[item.userId]);
   const row=result.rows[0];
   if(!row||row.telegram_id!==item.telegramId||row.role!==item.role||row.status!=="provisioning"||
      (item.role==="admin"||item.role==="creator"?row.profile_id!==null:row.profile_id!==item.profileId))throw new Error("Identity mismatch");
  }
  await client.query("COMMIT");
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
 console.log("auth identities verified");
}catch{console.error("auth identities verification failed");process.exitCode=1;}finally{await pool.end();}
