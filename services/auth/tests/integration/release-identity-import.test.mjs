// ABOUTME: Проверяет перенос идентичностей и текущих Telegram-привязок через команду владельца.
// ABOUTME: Использует только синтетическую PostgreSQL, рабочие Auth и Telegram не вызываются.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../../dist/auth.js";
import { migrateIdentity } from "../../dist/identity-schema.js";
import { getIdentity, resolveTelegram } from "../../dist/identity.js";

const value=process.env.AUTH_TEST_OWNER_URL;
if(!value)throw new Error("Explicit AUTH_TEST_OWNER_URL required");
const url=new URL(value);
if(url.pathname!=="/brai_auth_test"||url.hostname!=="127.0.0.1"||!["15459","15463"].includes(url.port))throw new Error("Refusing non-fixture database");
const secret="fixture-auth-secret-32-characters-long";

test("identity import preserves current bindings and rolls back conflicting imports",async()=>{
 const pool=new Pool({connectionString:value});
 const dir=await mkdtemp(join(tmpdir(),"auth-import-fixture-"));
 const run=promisify(execFile);
 const invoke=async(script,key,data)=>{
  const file=join(dir,key+".json");
  await writeFile(file,JSON.stringify(data),{mode:0o600});
  return run(process.execPath,[new URL("../../dist/"+script,import.meta.url).pathname],{env:{...process.env,AUTH_DATABASE_URL:value,AUTH_OWNER_ROLE:"auth_owner",AUTH_SECRET:secret,[key]:file},timeout:30000});
 };
 try{
  const cfg={origin:"https://fixture.example",trustedOrigins:["https://fixture.example"],secret,resendKey:"",emailFrom:"fixture@example.com"};
  await (await getMigrations(createAuth(cfg,pool).options)).runMigrations();
  await migrateIdentity(pool);
  if(!(await pool.query("SELECT 1 FROM brai_owner_bootstrap")).rowCount){
   await invoke("bootstrap.js","AUTH_BOOTSTRAP_FILE",{userId:randomUUID(),telegramId:"11900",name:"Fixture owner"});
  }
  const detached={userId:randomUUID(),profileId:randomUUID(),name:'Detached tester',telegramId:'11901',telegramIds:[],role:'user',status:'blocked'};
  const connected={userId:randomUUID(),profileId:randomUUID(),name:'Connected tester',telegramId:'11902',telegramIds:['11901','11903'],role:'guest',status:'active'};
  await invoke('import-identities.js','AUTH_IMPORT_FILE',[connected,detached]);
  await invoke('import-identities.js','AUTH_IMPORT_FILE',[detached,{...connected,telegramIds:['11903','11901']}]);
  const detachedUser=await getIdentity(pool,detached.userId);
  assert.equal(detachedUser.user.status,'blocked');
  assert.equal(detachedUser.user.telegramId,detached.telegramId);
  assert.deepEqual(detachedUser.telegramIds,[]);
  for(const account of connected.telegramIds)assert.equal((await resolveTelegram(pool,account)).id,connected.userId);
  assert.equal(await resolveTelegram(pool,connected.telegramId),null);
  assert.equal((await resolveTelegram(pool,'11903')).name,connected.name);
  const conflicting={...connected,userId:randomUUID(),profileId:randomUUID(),telegramId:'11904'};
  await assert.rejects(()=>invoke('import-identities.js','AUTH_IMPORT_FILE',[conflicting]));
  await assert.rejects(()=>invoke('import-identities.js','AUTH_IMPORT_FILE',[{...connected,telegramIds:[]}]));
  assert.equal((await pool.query('SELECT 1 FROM "user" WHERE id=$1',[conflicting.userId])).rowCount,0);
  assert.equal((await resolveTelegram(pool,'11903')).id,connected.userId);
 }finally{await pool.end();await rm(dir,{recursive:true,force:true});}
});
