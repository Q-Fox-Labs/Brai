// ABOUTME: Однократно создаёт первого владельца Auth по защищённому файлу оператора.
// ABOUTME: Нужны права владельца БД; сетевой запрос не запускает эту команду.
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { lifecycleLock, requestLifecycle } from "./lifecycle.js";

const dataSchema=z.strictObject({role:z.enum(["admin","creator"]).optional(),telegramId:z.string().regex(/^[0-9]{1,20}$/),name:z.string().min(1).max(200),userId:z.string().min(1).max(128).optional(),profileId:z.string().min(1).max(128).optional()});
const path=process.env.AUTH_BOOTSTRAP_FILE, databaseURL=process.env.AUTH_DATABASE_URL, owner=process.env.AUTH_OWNER_ROLE;
if(!path||!databaseURL||!owner)throw new Error("Bootstrap configuration required");
const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
let raw:string;
try{
 const stat=fstatSync(fd);
 if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>4096)throw new Error("Unsafe bootstrap file");
 raw=readFileSync(fd,"utf8");
}finally{closeSync(fd);}
const input=dataSchema.parse(JSON.parse(raw));
const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:5000});
try{
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const identity=(await client.query("SELECT current_user AS role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
  if(identity.role!==owner||identity.owner!==owner)throw new Error("Database owner required");
  await lifecycleLock(client);
  const prior=await client.query("SELECT i.user_id,i.telegram_id,i.profile_id,i.role,i.status FROM brai_owner_bootstrap b JOIN brai_identity i ON i.user_id=b.user_id");
  if(prior.rowCount){
   const saved=prior.rows[0];
   if(!input.userId||saved.user_id!==input.userId||saved.telegram_id!==input.telegramId||!['admin','creator'].includes(saved.role)||(input.profileId&&saved.profile_id!==input.profileId))throw new Error("Owner already configured");
   if(input.role==='creator'&&saved.role!=='creator'){
    if(saved.status!=='active'||(await client.query("SELECT 1 FROM brai_identity WHERE role='creator' LIMIT 1")).rowCount)throw new Error('Creator already configured');
    const result=await requestLifecycle(client,'operator','role-set',{userId:saved.user_id,role:'creator',requestId:'operator-first-creator:'+saved.user_id});
    if(result.status!==200)throw new Error('Creator unavailable');
   }
   await client.query("COMMIT");console.log("auth owner configured");
  } else {
  if((await client.query("SELECT 1 FROM brai_identity WHERE role IN ('creator','admin') LIMIT 1")).rowCount)throw new Error("Owner already configured");
  const id=input.userId??randomUUID(),email=createHash("sha256").update(id).digest("hex")+"@identity.brai.invalid";
  const existing=await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE',[id]);
  if(!existing.rowCount)await client.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',[id,input.name,email]);
  if((await client.query('SELECT 1 FROM brai_identity WHERE user_id=$1',[id])).rowCount)throw new Error("Identity conflict");
  await client.query("INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,$2,$3,$5,$4)",[id,input.telegramId,input.profileId??null,input.profileId?"active":"provisioning",input.role??"admin"]);
  await client.query("INSERT INTO brai_owner_bootstrap(user_id) VALUES($1)",[id]);
  await client.query("INSERT INTO brai_identity_audit(id,actor_id,target_id,action) VALUES($1,'operator',$2,'owner-bootstrap')",[randomUUID(),id]);
  await client.query("COMMIT");console.log("auth owner configured");
  }
 }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
}catch{console.error("auth owner bootstrap failed");process.exitCode=1;}finally{await pool.end();}
