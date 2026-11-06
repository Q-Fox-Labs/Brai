// ABOUTME: Проверяет конкурентные операции идентичности Auth на временной PostgreSQL.
// ABOUTME: Работает только с явным локальным тестовым стендом и синтетическими данными.
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
import { issueCode, consumeCode } from "../../dist/login-code.js";
import { adminAction } from "../../dist/admin.js";
import { provision, profileReady, redeemInvite } from "../../dist/identity.js";

const value=process.env.AUTH_TEST_OWNER_URL;
if(!value)throw new Error("Explicit AUTH_TEST_OWNER_URL required");
const url=new URL(value);
if(url.pathname!=="/brai_auth_test"||url.hostname!=="127.0.0.1"||url.port!=="15459")throw new Error("Refusing non-fixture database");
const pool=new Pool({connectionString:value});
const secret="fixture-auth-secret-32-characters-long";
const cfg={origin:"https://fixture.example",trustedOrigins:["https://fixture.example"],secret,resendKey:"",emailFrom:"fixture@example.com"};
test("registry, codes, invitations and last admin survive concurrent requests",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"auth-owner-test-"));
 const run=promisify(execFile);
 const invoke=async(script,key,data)=>{
  const file=join(dir,key+'.json');await writeFile(file,JSON.stringify(data),{mode:0o600});
  return run(process.execPath,[new URL('../../dist/'+script,import.meta.url).pathname],{env:{...process.env,AUTH_DATABASE_URL:value,AUTH_OWNER_ROLE:'auth_owner',AUTH_SECRET:secret,[key]:file},timeout:30000});
 };
 try{
  await (await getMigrations(createAuth(cfg,pool).options)).runMigrations();
  await migrateIdentity(pool);await migrateIdentity(pool);
  const owner=randomUUID(),name="Fixture owner";
  await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',[owner,name,owner+"@fixture.example"]);
  const bootstrap={userId:owner,telegramId:'10001',name:'Different name'};
  await invoke('bootstrap.js','AUTH_BOOTSTRAP_FILE',bootstrap);await invoke('bootstrap.js','AUTH_BOOTSTRAP_FILE',bootstrap);
  assert.equal((await pool.query('SELECT name FROM "user" WHERE id=$1',[owner])).rows[0].name,name);
  const request={requestId:randomUUID(),userId:randomUUID(),profileId:'fixture-user',telegramId:"10002",role:"user",status:"provisioning",name:"Fixture user"};
  await invoke('provision-identities.js','AUTH_PROVISION_FILE',[request]);await invoke('provision-identities.js','AUTH_PROVISION_FILE',[request]);
  const user=await provision(pool,secret,request);
  assert.deepEqual(await provision(pool,secret,request),user);
  await assert.rejects(()=>provision(pool,secret,{...request,name:"Changed"}));
  const accounts={version:1,originalBraiOwnerId:owner,originalTelegramOwnerId:'10001',accounts:[
   {userId:owner,telegramId:'10001',profileId:'fixture-owner',role:'admin',status:'provisioning'},
   {userId:user.id,telegramId:'10002',profileId:'fixture-user',role:'user',status:'provisioning'}]};
  await invoke('verify-provision.js','AUTH_ACCOUNTS_FILE',accounts);
  await invoke('ready-profiles.js','AUTH_READY_FILE',[{userId:owner,profileId:'fixture-owner'},{userId:user.id,profileId:'fixture-user'}]);
  assert.equal((await profileReady(pool,user.id,"fixture-user")).status,"active");
  const first=await issueCode(pool,secret,"10002");assert.match(first.code,/^[0-9A-HJKMNP-TV-Z]{12}$/);
  const second=await issueCode(pool,secret,"10002");
  assert.equal(await consumeCode(pool,secret,first.code,"fixture-client"),null);
  const results=await Promise.all(Array.from({length:8},()=>consumeCode(pool,secret,second.code,"fixture-client")));
  assert.equal(results.filter(value=>value===user.id).length,1);
  assert.equal((await issueCode(pool,secret,"10002"))!==null,true);
  assert.equal(await issueCode(pool,secret,"10002"),null);
  const last=await Promise.all([
   adminAction(pool,secret,owner,"role-set",{userId:owner,role:"user"}),
   adminAction(pool,secret,owner,"status-set",{userId:owner,status:"blocked"})
  ]);
  assert.deepEqual(last.map(item=>item.body.code),["LAST_ADMIN","LAST_ADMIN"]);
  const denied=await adminAction(pool,secret,user.id,"role-set",{userId:user.id,role:"admin"});
  assert.equal(denied.status,403);
  const created=await adminAction(pool,secret,owner,"invite-create",{});
  const code=created.body.invite.code;
  const invited=await Promise.all([redeemInvite(pool,secret,"10003",code),redeemInvite(pool,secret,"10004",code)]);
  assert.equal(invited.filter(Boolean).length,1);
  const winner=invited.find(Boolean);
  assert.match(winner.profileId,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const retry=await redeemInvite(pool,secret,winner.telegramId,code);
  assert.equal(retry.id,winner.id);
  assert.equal(retry.profileId,winner.profileId);
  assert.equal((await pool.query("SELECT digest FROM brai_invite WHERE id=$1",[created.body.invite.id])).rows[0].digest.includes(code),false);
  const audit=await adminAction(pool,secret,owner,"admin-audit",{userId:user.id,action:"memory.read"});
  assert.equal(audit.status,200);assert.ok(audit.body.auditId);
  assert.equal((await pool.query("SELECT actor_id,target_id,action FROM brai_identity_audit WHERE id=$1",[audit.body.auditId])).rows[0].actor_id,owner);
  const cutoverId='fixture-'+randomUUID(),token='fixture-secret-token',verifyValue='fixture-verification';
  await pool.query('INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',[randomUUID(),token,owner]);
  await pool.query('INSERT INTO "verification"(id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',[randomUUID(),'fixture-identifier',verifyValue]);
  const privateAccess=await pool.query("SELECT has_schema_privilege('auth_app','auth_identity_owner','USAGE') AS schema_access,has_table_privilege('auth_app','auth_identity_owner.snapshot','SELECT') AS table_access");
  assert.deepEqual(privateAccess.rows[0],{schema_access:false,table_access:false});
  const cutover=async(action='revoke')=>{
   const result=await run(process.execPath,[new URL('../../dist/revoke-legacy.js',import.meta.url).pathname],{env:{...process.env,AUTH_DATABASE_URL:value,AUTH_OWNER_ROLE:'auth_owner',AUTH_APP_ROLE:'auth_app',AUTH_REVOKE_REQUEST_ID:cutoverId,AUTH_CUTOVER_ACTION:action,...(action==='restore'?{AUTH_ROLLBACK_PREOPEN:'1'}:{})},timeout:30000});
   assert.equal(result.stdout.includes(token),false);assert.equal(result.stdout.includes(verifyValue),false);return JSON.parse(result.stdout);
  };
  const revoked=await cutover();assert.ok(revoked.sessionsRevoked>=1);assert.ok(revoked.verificationsRevoked>=1);
  assert.equal((await pool.query('SELECT count(*) FROM "session"')).rows[0].count,'0');
  const replay=await cutover();assert.equal(replay.replayed,true);assert.equal(replay.sessionsRevoked,revoked.sessionsRevoked);
  const newId=randomUUID();
  await pool.query('INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now())',[newId,'fixture-new-token',owner]);
  await assert.rejects(()=>cutover('restore'));
  assert.equal((await pool.query('SELECT count(*) FROM "session" WHERE id=$1',[newId])).rows[0].count,'1');
  await pool.query('DELETE FROM "session" WHERE id=$1',[newId]);
  await cutover('restore');
  assert.equal((await pool.query('SELECT count(*) FROM "session" WHERE token=$1',[token])).rows[0].count,'1');
  assert.equal((await pool.query('SELECT count(*) FROM "verification" WHERE value=$1',[verifyValue])).rows[0].count,'1');
  await assert.rejects(()=>cutover());
 }finally{await pool.end();await rm(dir,{recursive:true,force:true});}
});
