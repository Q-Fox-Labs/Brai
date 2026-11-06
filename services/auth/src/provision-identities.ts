// ABOUTME: Создаёт ожидающие идентичности до перехода Auth в Telegram-режим.
// ABOUTME: Доступен только владельцу БД и читает параметры из закрытого JSON.
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { z } from "zod";
import { provision } from "./identity.js";

const id=z.string().min(1).max(128);
const request=z.strictObject({requestId:id,telegramId:z.string().regex(/^[0-9]{1,20}$/),name:z.string().min(1).max(200).optional(),role:z.literal("user"),userId:id,profileId:id,status:z.literal("provisioning")});
const path=process.env.AUTH_PROVISION_FILE,databaseURL=process.env.AUTH_DATABASE_URL,owner=process.env.AUTH_OWNER_ROLE,secret=process.env.AUTH_SECRET;
if(!path||!databaseURL||!owner||!secret||secret.length<32)throw new Error("Provision configuration required");
const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let raw:string;
try{
 const stat=fstatSync(fd);
 if(!stat.isFile()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>1_000_000)throw new Error("Unsafe provision file");
 raw=readFileSync(fd,"utf8");
}finally{closeSync(fd);}
const items=z.array(request).max(10000).parse(JSON.parse(raw));
const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:5000});
try{
 const identity=(await pool.query("SELECT current_user AS role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
 if(identity.role!==owner||identity.owner!==owner)throw new Error("Database owner required");
 if(!(await pool.query("SELECT 1 FROM brai_owner_bootstrap")).rowCount)throw new Error("Owner bootstrap required");
 for(const item of items)await provision(pool,secret,item);
 console.log("auth identities provisioned");
}catch{console.error("auth identity provision failed");process.exitCode=1;}finally{await pool.end();}
