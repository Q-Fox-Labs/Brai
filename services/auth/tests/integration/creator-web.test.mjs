// ABOUTME: Проверяет допуск Creator и отзыв прежних веб-входов на реальной БД Auth.
// ABOUTME: Использует только выделенную localhost fixture с синтетическими учётными записями.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHmac, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { issueCode, consumeCode } from '../../dist/login-code.js';
import { revokeNonCreatorWebAccess } from '../../dist/web-access.js';
import { adminAction } from '../../dist/admin.js';
import { createAuth } from '../../dist/auth.js';
import { bridge } from '../../dist/bridge.js';

function fixtureURL(name) {
 const url = new URL(process.env[name]);
 if (url.hostname !== '127.0.0.1' || url.port !== '15459' || url.pathname !== '/brai_auth_test') throw new Error('Refusing non-fixture database');
 return url.href;
}
const ownerURL = fixtureURL('AUTH_TEST_OWNER_URL'), appURL = fixtureURL('AUTH_TEST_APP_URL');
const owner = new Pool({connectionString:ownerURL}), app = new Pool({connectionString:appURL});
const secret = 'fixture-auth-secret-32-characters-long';
const ids = [];
const run = promisify(execFile);
async function seed(role) {
 const id=randomUUID(), email=id+'@fixture.example', telegramId=String(BigInt('1000000000000000000')+BigInt('0x'+id.replaceAll('-','').slice(0,12)));
 await owner.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',[id,'Synthetic',email]);
 ids.push(id);
 if(role){
  await owner.query('INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,$2,$3,$4,\'active\')',[id,telegramId,randomUUID(),role]);
 }
 return {id,email,telegramId};
}
async function session(user) {
 const id=randomUUID();
 await owner.query('INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt",brai_generation) VALUES($1,$2,$3,now()+interval \'1 hour\',now(),now(),0)',[id,randomUUID(),user.id]);
 return id;
}
async function oldCode(user, code) {
 await owner.query("INSERT INTO brai_login_code(user_id,digest,expires_at) VALUES($1,$2,now()+interval '2 minutes')",[user.id,createHmac('sha256',secret).update('code:'+code).digest('hex')]);
}
after(async()=>{if(ids.length){await owner.query('DELETE FROM brai_identity_audit WHERE target_id=ANY($1::text[])',[ids]);await owner.query('DELETE FROM "user" WHERE id=ANY($1::text[])',[ids]);}await Promise.all([owner.end(),app.end()]);});

test('только Creator получает код; прежние коды и сессии остальных отзываются',async()=>{
 await run(process.execPath,[fileURLToPath(new URL('../../dist/migrate.js',import.meta.url))],{env:{...process.env,AUTH_DATABASE_URL:ownerURL,AUTH_OWNER_ROLE:'auth_owner',AUTH_APP_ROLE:'auth_app',AUTH_SECRET:secret,AUTH_ORIGIN:'https://fixture.example',AUTH_IDENTITY_MODE:'telegram'}});
 const creator=await seed('creator'), manager=await seed('creator'), admin=await seed('admin'), user=await seed('user'), guest=await seed('guest'), legacy=await seed(null), ssoUser=await seed('creator');
 for(const item of [admin,user,guest])assert.equal(await issueCode(app,secret,item.telegramId),null);
 const creatorCode=await issueCode(app,secret,creator.telegramId);
 assert.ok(creatorCode);
 for(const [item,code] of [[admin,'123456789ABC'],[user,'123456789ABD'],[guest,'123456789ABE']])await oldCode(item,code);
 assert.equal(await consumeCode(app,secret,'123456789ABC','fixture'),null);
 const creatorSession=await session(creator);
 // Принятый старый Auth сохранял сессию Admin при повышении до Creator.
 const promoted=await seed('admin'), oldAdminSession=await session(promoted);
 await owner.query("UPDATE brai_identity SET role='creator', lifecycle_generation=1 WHERE user_id=$1",[promoted.id]);
 await owner.query(`UPDATE "session" SET brai_generation=1,"createdAt"=now()+interval '1 second' WHERE id=$1`,[oldAdminSession]);
 await owner.query("INSERT INTO brai_identity_audit(id,actor_id,target_id,action,old_role,new_role,generation) VALUES($1,'operator',$2,'role-set','admin','creator',1)",[randomUUID(),promoted.id]);

 const origin='https://fixture.example', preview='https://preview.fixture.example';
 const cfg={identityMode:'telegram',origin,trustedOrigins:[origin,preview],ssoHubOrigin:origin,ssoPreviewOrigins:[preview],secret};
 const auth=createAuth(cfg,app);
 const ssoCode=await issueCode(app,secret,ssoUser.telegramId);
 const signed=await auth.handler(new Request(origin+'/api/auth/brai/telegram-redeem',{method:'POST',headers:{origin,'content-type':'application/json','x-forwarded-for':'192.0.2.2'},body:JSON.stringify({code:ssoCode.code})}));
 assert.equal(signed.status,200);
 const cookie=signed.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
 const verifier=randomBytes(32).toString('base64url');
 const challenge=createHash('sha256').update(verifier).digest('base64url');
 const ticket=await bridge('sso-issue',{headers:{origin,cookie},body:{targetOrigin:preview,challenge}},origin,auth.handler,cfg);
 assert.equal(ticket.status,200);
 // Синтетический старый вход, созданный до нового правила для текущего user.
 await owner.query("UPDATE brai_identity SET role='user' WHERE user_id=$1",[ssoUser.id]);
 const revokedSessions=await Promise.all([admin,user,guest,legacy].map(session));
 for(const item of [creator,admin,user,guest,legacy])await owner.query('INSERT INTO verification(id,identifier,value,"expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'5 minutes\',now(),now())',[randomUUID(),'sign-in-otp-'+item.email,'synthetic']);
 await revokeNonCreatorWebAccess(app);
 const newCreatorSession=await session(promoted);
 await revokeNonCreatorWebAccess(app);
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM "session" WHERE id=$1',[creatorSession])).rows[0].n,1);
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM "session" WHERE id=$1',[oldAdminSession])).rows[0].n,0);
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM "session" WHERE id=$1',[newCreatorSession])).rows[0].n,1);
 // Следующее повышение после отката должно иметь собственную отметку.
 await owner.query("INSERT INTO brai_identity_audit(id,actor_id,target_id,action,old_role,new_role,generation) VALUES($1,'operator',$2,'role-set','admin','creator',2)",[randomUUID(),promoted.id]);
 await revokeNonCreatorWebAccess(app);
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM "session" WHERE id=$1',[newCreatorSession])).rows[0].n,0);
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM "session" WHERE id=ANY($1::text[])',[revokedSessions])).rows[0].n,0);
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM brai_login_code WHERE user_id=ANY($1::text[])',[[admin.id,user.id,guest.id]])).rows[0].n,0);
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM verification WHERE identifier=ANY($1::text[])',[[creator,admin,user,guest,legacy].map(x=>'sign-in-otp-'+x.email)])).rows[0].n,1);
 const redeem=await bridge('sso-redeem',{headers:{origin:preview},body:{targetOrigin:preview,ticket:ticket.body.ticket,verifier}},origin,auth.handler,cfg);
 assert.notEqual(redeem.status,200);
 assert.deepEqual(redeem.setCookies,[]);
 assert.equal(await consumeCode(app,secret,creatorCode.code,'fixture'),creator.id);
 const pending=await issueCode(app,secret,creator.telegramId);
 const changed=await adminAction(app,secret,manager.id,'role-set',{userId:creator.id,role:'admin',requestId:randomUUID()});
 assert.equal(changed.status,200);
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM "session" WHERE id=$1',[creatorSession])).rows[0].n,0);
 assert.equal(await issueCode(app,secret,creator.telegramId),null);
 assert.equal((await adminAction(app,secret,manager.id,'role-set',{userId:creator.id,role:'creator',requestId:randomUUID()})).status,200);
 assert.equal(await consumeCode(app,secret,pending.code,'fixture'),null);
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM "session" WHERE id=$1',[creatorSession])).rows[0].n,0);
 const currentSession=await session(creator);
 await revokeNonCreatorWebAccess(app);
 assert.equal((await owner.query('SELECT count(*)::int AS n FROM "session" WHERE id=$1',[currentSession])).rows[0].n,1);
});
