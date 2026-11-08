// ABOUTME: Проверяет совместную работу Telegram-привязок и административного lifecycle.
// ABOUTME: Использует только синтетические аккаунты в отдельной PostgreSQL fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { createAuth } from "../../dist/auth.js";
import { adminAction } from "../../dist/admin.js";
import { lifecycleWorker } from "../../dist/lifecycle.js";
import { provision,resolveTelegram,getIdentity,issueTelegramLink,redeemTelegramLink,unlinkTelegram } from "../../dist/identity.js";
import { issueCode } from "../../dist/login-code.js";
import { sessionIdentity } from "../../dist/v2.js";

const ownerURL=process.env.AUTH_TEST_OWNER_URL,appURL=process.env.AUTH_TEST_APP_URL;
for(const value of [ownerURL,appURL]){
 if(!value)throw new Error("Explicit fixture URL required");
 const url=new URL(value);
 if(url.hostname!=="127.0.0.1"||url.port!=="15459"||url.pathname!=="/brai_auth_test")throw new Error("Refusing non-fixture database");
}
const owner=new Pool({connectionString:ownerURL}),app=new Pool({connectionString:appURL});
const secret="fixture-auth-secret-32-characters-long",origin="https://fixture.example";
test("aliases share admin lifecycle and unlink invalidates pending web login",async()=>{
 const actor=randomUUID(),prefix=String(Date.now()),adminTelegram=prefix+"11",first=prefix+"12",second=prefix+"13";
 const created=[];
 const action=(op,body)=>adminAction(app,secret,actor,op,body);
 const finish=async(userId)=>{
  const operation=(await lifecycleWorker(app,"claim",{workerId:"telegram-lifecycle-fixture"})).operation;
  assert.equal(operation?.userId,userId);
  assert.equal((await lifecycleWorker(app,"complete",{operationId:operation.id,leaseToken:operation.leaseToken,success:true})).accepted,true);
 };
 try{
  await promisify(execFile)(process.execPath,[new URL("../../dist/migrate.js",import.meta.url).pathname],{env:{...process.env,AUTH_DATABASE_URL:ownerURL,AUTH_OWNER_ROLE:"auth_owner",AUTH_APP_ROLE:"auth_app",AUTH_SECRET:secret,AUTH_ORIGIN:origin,AUTH_IDENTITY_MODE:"telegram"},timeout:30000});
  await owner.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',[actor,"Telegram fixture admin",actor+"@fixture.example"]);
  await owner.query("INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,$2,$3,'admin','active')",[actor,adminTelegram,randomUUID()]);
  const user=await provision(app,secret,{requestId:randomUUID(),telegramId:first,role:"user",status:"active",profileId:randomUUID()});
  created.push(user.id);
  const originalProfile=user.profileId;
  const oldLink=await issueTelegramLink(app,secret,first);
  assert.equal((await action("users-revoke",{requestId:randomUUID(),userId:user.id})).status,200);
  assert.equal((await resolveTelegram(app,first)).status,"blocked");
  await finish(user.id);
  assert.equal((await action("users-add",{requestId:randomUUID(),telegramId:first})).body.user.id,user.id);
  await finish(user.id);
  assert.equal(await redeemTelegramLink(app,secret,second,oldLink.code),null);
  const link=await issueTelegramLink(app,secret,first);
  assert.equal((await redeemTelegramLink(app,secret,second,link.code)).id,user.id);
  const beforeCount=(await owner.query("SELECT count(*) FROM brai_identity")).rows[0].count;
  const viaAlias=await action("users-add",{requestId:randomUUID(),telegramId:second});
  assert.equal(viaAlias.body.user.id,user.id);
  assert.equal(viaAlias.body.user.profileId,originalProfile);
  assert.deepEqual(viaAlias.body.user.telegramIds,[first,second].sort());
  assert.equal(viaAlias.body.operation.state,"succeeded");
  assert.equal((await owner.query("SELECT count(*) FROM brai_identity")).rows[0].count,beforeCount);

  const cfg={identityMode:"telegram",origin,trustedOrigins:[origin],secret};
  const engine=createAuth(cfg,app);
  const login=code=>engine.handler(new Request(origin+"/api/auth/brai/telegram-redeem",{method:"POST",headers:{origin,"content-type":"application/json","x-forwarded-for":"192.0.2.89"},body:JSON.stringify({code})}));
  const code=await issueCode(app,secret,second);
  const signed=await login(code.code);assert.equal(signed.status,200);
  const cookie=signed.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ");
  assert.equal((await sessionIdentity(app,cfg,engine.handler,new Headers({cookie}))).id,user.id);
  const epoch=(await owner.query("SELECT lifecycle_generation FROM brai_identity WHERE user_id=$1",[user.id])).rows[0].lifecycle_generation;
  assert.equal(await unlinkTelegram(app,second,first),true);
  assert.equal((await owner.query("SELECT lifecycle_generation FROM brai_identity WHERE user_id=$1",[user.id])).rows[0].lifecycle_generation,epoch+1);
  assert.equal(await sessionIdentity(app,cfg,engine.handler,new Headers({cookie})),null);
  assert.equal(await resolveTelegram(app,first),null);
  assert.equal((await resolveTelegram(app,second)).id,user.id);
  assert.deepEqual((await action("users-get",{userId:user.id})).body.user.telegramIds,[second]);

  const context=await engine.$context,createSession=context.internalAdapter.createSession.bind(context.internalAdapter);
  context.internalAdapter.createSession=async(...args)=>{
   context.internalAdapter.createSession=createSession;
   assert.equal(await unlinkTelegram(app,second,second),true);
   return createSession(...args);
  };
  const finalCode=await issueCode(app,secret,second);
  const finalLogin=await login(finalCode.code);
  assert.equal(finalLogin.status,401);
  assert.equal(finalLogin.headers.get("set-cookie"),null);
  assert.equal((await owner.query('SELECT 1 FROM "session" WHERE "userId"=$1',[user.id])).rowCount,0);
  assert.deepEqual((await getIdentity(app,user.id)).telegramIds,[]);
  assert.equal((await getIdentity(app,user.id)).user.profileId,originalProfile);
  assert.equal((await action("role-set",{userId:user.id,role:"admin"})).body.code,"CONTACT_REQUIRED");
  assert.equal(await unlinkTelegram(app,adminTelegram,adminTelegram),false);

  const reused=(await action("users-add",{requestId:randomUUID(),telegramId:first})).body.user;
  created.push(reused.id);
  assert.notEqual(reused.id,user.id);
  assert.notEqual(reused.telegramId,user.telegramId);
  assert.notEqual(reused.profileId,originalProfile);
  await finish(reused.id);
  assert.equal((await resolveTelegram(app,first)).id,reused.id);
  assert.deepEqual((await getIdentity(app,user.id)).telegramIds,[]);
 }finally{
  try{
   for(const userId of created){
    await owner.query('DELETE FROM brai_identity_request WHERE user_id=$1',[userId]);
    await owner.query('DELETE FROM "user" WHERE id=$1',[userId]);
   }
   await owner.query('DELETE FROM "user" WHERE id=$1',[actor]);
  }finally{await app.end();await owner.end();}
 }
});
