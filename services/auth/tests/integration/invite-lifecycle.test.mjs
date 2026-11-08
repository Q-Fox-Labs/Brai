// ABOUTME: Проверяет общую очередь Auth для приглашений и административного отзыва.
// ABOUTME: Работает только с выделенной PostgreSQL fixture и синтетическими пользователями.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getMigrations } from "better-auth/db/migration";
import { createAuth } from "../../dist/auth.js";
import { migrateIdentity } from "../../dist/identity-schema.js";
import { Pool } from "pg";
import { adminAction } from "../../dist/admin.js";
import { lifecycleWorker } from "../../dist/lifecycle.js";
import { redeemInvite, profileReady } from "../../dist/identity.js";
const value=process.env.AUTH_TEST_OWNER_URL;
if(!value)throw new Error("Explicit AUTH_TEST_OWNER_URL required");
const url=new URL(value);
if(url.hostname!=="127.0.0.1"||url.port!=="15459"||url.pathname!=="/brai_auth_test")throw new Error("Refusing non-fixture database");
const pool=new Pool({connectionString:value});
const secret="fixture-auth-secret-32-characters-long";
test("invites reuse lifecycle, retry own failure and cannot supersede admin decisions",async()=>{
 const actor=randomUUID(),prefix=String(Date.now()),users=[];
 const action=(op,body)=>adminAction(pool,secret,actor,op,body);
 const invite=async()=>((await action("invite-create",{})).body.invite);
 const claim=async userId=>{
  const operation=(await lifecycleWorker(pool,"claim",{workerId:"invite-fixture"})).operation;
  assert.equal(operation?.userId,userId);return operation;
 };
 const complete=(operation,success)=>lifecycleWorker(pool,"complete",{operationId:operation.id,leaseToken:operation.leaseToken,success,...(success?{}:{errorCode:"PROFILE_FAILED"})});
 try {
  const cfg={origin:"https://fixture.example",trustedOrigins:["https://fixture.example"],secret,emailFrom:"fixture@example.com"};
  await (await getMigrations(createAuth(cfg,pool).options)).runMigrations();await migrateIdentity(pool);
  await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',[actor,"Invite admin",actor+"@fixture.example"]);
  await pool.query("INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,$2,$3,'admin','active')",[actor,prefix+"01",randomUUID()]);
  const first=await invite(),telegram=prefix+"02";
  const parallel=await Promise.all(Array.from({length:5},()=>redeemInvite(pool,secret,telegram,first.code)));
  const user=parallel[0];users.push(user.id);
  assert.ok(parallel.every(u=>u.id===user.id));
  assert.equal((await pool.query("SELECT 1 FROM brai_user_operation WHERE user_id=$1",[user.id])).rowCount,1);
  assert.equal(await profileReady(pool,user.id,user.profileId),null);
  const preparation=await claim(user.id);assert.equal(preparation.kind,"prepare");
  assert.ok(preparation.requestId.startsWith("invite:"+first.id+":"));
  assert.equal(preparation.requestId.includes(first.code),false);
  assert.equal((await complete(preparation,true)).accepted,true);
  assert.equal((await redeemInvite(pool,secret,telegram,first.code)).status,"active");
  assert.equal((await lifecycleWorker(pool,"claim",{workerId:"active-noop"})).operation,null);

  const revokedInvite=await invite(),revoked=await redeemInvite(pool,secret,prefix+"03",revokedInvite.code);users.push(revoked.id);
  const original=(await pool.query("SELECT id FROM brai_user_operation WHERE user_id=$1",[revoked.id])).rows[0];
  await action("users-revoke",{requestId:randomUUID(),userId:revoked.id});
  const stopped=await claim(revoked.id);assert.equal(stopped.kind,"stop");
  assert.equal((await pool.query("SELECT state FROM brai_user_operation WHERE id=$1",[original.id])).rows[0].state,"cancelled");
  await complete(stopped,true);
  assert.equal(await redeemInvite(pool,secret,prefix+"03",revokedInvite.code),null);
  assert.equal((await lifecycleWorker(pool,"claim",{workerId:"blocked-noop"})).operation,null);

  const retryInvite=await invite(),retry=await redeemInvite(pool,secret,prefix+"04",retryInvite.code);users.push(retry.id);
  const failed=await claim(retry.id);await complete(failed,false);
  assert.equal((await lifecycleWorker(pool,"claim",{workerId:"no-blind-retry"})).operation,null);
  assert.equal((await redeemInvite(pool,secret,prefix+"04",retryInvite.code)).id,retry.id);
  const retried=await claim(retry.id);
  assert.equal(retried.generation,failed.generation+1);assert.notEqual(retried.id,failed.id);
  await complete(retried,true);

  const managedInvite=await invite();
  const managed=(await action("users-add",{requestId:randomUUID(),telegramId:prefix+"05"})).body;
  users.push(managed.user.id);
  assert.equal((await redeemInvite(pool,secret,prefix+"05",managedInvite.code)).id,managed.user.id);
  const reused=await claim(managed.user.id);assert.equal(reused.id,managed.operation.id);
  await complete(reused,false);
  assert.equal(await redeemInvite(pool,secret,prefix+"05",managedInvite.code),null);
  assert.equal((await lifecycleWorker(pool,"claim",{workerId:"admin-failure-denied"})).operation,null);

  await action("status-set",{requestId:randomUUID(),userId:user.id,status:"provisioning"});
  await complete(await claim(user.id),true);
  assert.equal(await redeemInvite(pool,secret,telegram,first.code),null);
  assert.equal((await lifecycleWorker(pool,"claim",{workerId:"admin-terminal-denied"})).operation,null);
 }finally{
  await pool.query("DELETE FROM brai_invite WHERE created_by=$1",[actor]);
  for(const userId of users)await pool.query('DELETE FROM "user" WHERE id=$1',[userId]);
  await pool.query('DELETE FROM "user" WHERE id=$1',[actor]);
  await pool.end();
 }
});
