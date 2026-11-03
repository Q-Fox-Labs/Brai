// ABOUTME: Проверяет одноразовое погашение SSO на изолированной PostgreSQL.
// ABOUTME: Использует синтетические учётные записи и отказывается от иных баз.
import test from 'node:test';import assert from 'node:assert/strict';import {Pool} from 'pg';import {randomBytes,createHash} from 'node:crypto';
import {getMigrations} from 'better-auth/db/migration';import {createAuth} from '../../dist/auth.js';import {bridge} from '../../dist/bridge.js';
const fixtureURL=name=>{const value=process.env[name];if(!value)throw new Error(`Explicit ${name} required`);const url=new URL(value);if(url.pathname!=='/brai_auth_test'||url.hostname!=='127.0.0.1'||url.port!=='15459')throw new Error('Refusing non-fixture database');return value;};
const hub='https://fixture.example',preview='https://preview.fixture.example';
const cfg={origin:hub,trustedOrigins:[hub,preview],ssoHubOrigin:hub,ssoPreviewOrigins:[preview],secret:'fixture-auth-secret-32-characters-long',resendKey:'re_fixture',emailFrom:'Fixture <test@example.com>'};
const state=()=>{const verifier=randomBytes(32).toString('base64url');return {verifier,challenge:createHash('sha256').update(verifier).digest('base64url')};};
const cookies=r=>r.setCookies.map(v=>v.split(';')[0]).join('; ');
test('SSO consumes once across concurrent handlers and respects session revocation and expiry',async()=>{
 const owner=new Pool({connectionString:fixtureURL('AUTH_TEST_OWNER_URL')});const app=new Pool({connectionString:fixtureURL('AUTH_TEST_APP_URL')});let code='';const send=async(_,otp)=>{code=otp;};
 try{
  const bootstrap=createAuth(cfg,owner,send);await (await getMigrations(bootstrap.options)).runMigrations();await owner.query('GRANT USAGE ON SCHEMA public TO auth_app');await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO auth_app');
  const a=createAuth(cfg,app,send),b=createAuth(cfg,app,send);
  const call=(auth,op,body={},cookie='',origin=hub)=>bridge(op,{headers:{origin,cookie,'x-forwarded-for':'192.0.2.91'},body},hub,auth.handler,cfg);
  const email=`sso-${randomBytes(8).toString('hex')}@example.com`;
  assert.equal((await call(a,'send-code',{email})).status,200);const signed=await call(a,'verify-code',{email,otp:code});assert.equal(signed.status,200);const cookie=cookies(signed);
  const issue=async()=>{const s=state();const r=await call(a,'sso-issue',{targetOrigin:preview,challenge:s.challenge},cookie);assert.equal(r.status,200);return {...s,ticket:r.body.ticket,targetOrigin:preview};};
  const redeem=(auth,t)=>call(auth,'sso-redeem',{ticket:t.ticket,verifier:t.verifier,targetOrigin:t.targetOrigin},'',preview);
  const concurrent=await issue();const results=await Promise.all([redeem(a,concurrent),redeem(b,concurrent)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);assert.equal(results.filter(r=>r.setCookies.length).length,1);
  const exp=await issue();const realNow=Date.now;try{Date.now=()=>realNow()+61000;assert.equal((await redeem(a,exp)).status,400);}finally{Date.now=realNow;}
  const validAfterBad=await issue();assert.equal((await redeem(a,{...validAfterBad,verifier:state().verifier})).status,400);assert.equal((await redeem(a,validAfterBad)).status,200);
  const expiredSession=await issue();await owner.query(`UPDATE "session" SET "expiresAt"=now()-interval '1 second' WHERE "userId"=(SELECT id FROM "user" WHERE email=$1)`,[email]);const expiredReply=await redeem(a,expiredSession);assert.equal(expiredReply.status,400);assert.deepEqual(expiredReply.setCookies,[]);
  await owner.query(`UPDATE "session" SET "expiresAt"=now()+interval '1 hour' WHERE "userId"=(SELECT id FROM "user" WHERE email=$1)`,[email]);const revoked=await issue();await call(a,'sign-out',{},cookie);const revokedReply=await redeem(a,revoked);assert.equal(revokedReply.status,400);assert.deepEqual(revokedReply.setCookies,[]);
 }finally{await app.end();await owner.end();}
});
