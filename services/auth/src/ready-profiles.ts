// ABOUTME: Активирует подготовленные профили Auth отдельной операторской фазой.
// ABOUTME: Принимает только закрытый JSON и подключение владельца БД.
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { z } from "zod";
import { profileReady } from "./identity.js";

const id=z.string().min(1).max(128);
const path=process.env.AUTH_READY_FILE,databaseURL=process.env.AUTH_DATABASE_URL,owner=process.env.AUTH_OWNER_ROLE;
if(!path||!databaseURL||!owner)throw new Error("Ready configuration required");
const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw:string;
try{
 const stat=fstatSync(fd);
 if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>1_000_000)throw new Error("Unsafe ready file");
 raw=readFileSync(fd,"utf8");
}finally{closeSync(fd);}
const items=z.array(z.strictObject({userId:id,profileId:id})).max(10000).parse(JSON.parse(raw));
const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:5000});
try{
 const identity=(await pool.query("SELECT current_user AS role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
 if(identity.role!==owner||identity.owner!==owner)throw new Error("Database owner required");
 for(const item of items)if(!await profileReady(pool,item.userId,item.profileId))throw new Error("Profile conflict");
 console.log("auth profiles ready");
}catch{console.error("auth profiles ready failed");process.exitCode=1;}finally{await pool.end();}
