// ABOUTME: Проверяет официальный Better Auth на изолированной PostgreSQL.
// ABOUTME: Письма перехватываются штатным callback; внешние секреты не используются.
import test from 'node:test';import assert from 'node:assert/strict';import {Pool} from 'pg';
import {getMigrations} from 'better-auth/db/migration';import {createAuth} from '../../dist/auth.js';import {bridge} from '../../dist/bridge.js';
const origin='https://fixture.example';
const fixtureURL=name=>{const value=process.env[name];if(!value)throw new Error(`Explicit ${name} required`);const url=new URL(value);if(url.pathname!=='/brai_auth_test'||url.hostname!=='127.0.0.1'||url.port!=='15459')throw new Error('Refusing non-fixture database');return value;};
const owner=new Pool({connectionString:fixtureURL('AUTH_TEST_OWNER_URL')});
const app=new Pool({connectionString:fixtureURL('AUTH_TEST_APP_URL')});
const cfg={origin,secret:'fixture-auth-secret-32-characters-long',resendKey:'re_fixture',emailFrom:'Fixture <test@example.com>'};
let last='';let mails=0;
const send=async(_email,otp)=>{last=otp;mails++;};
const call=(auth,op,body={},cookie='')=>bridge(op,{headers:{origin,cookie,'x-forwarded-for':'192.0.2.1'},body},origin,auth.handler);
const cookies=response=>response.setCookies.map(v=>v.split(';')[0]).join('; ');
test('official OTP, sessions, revocation and PostgreSQL isolation',async()=>{
 try{
 const bootstrap=createAuth(cfg,owner,send);await (await getMigrations(bootstrap.options)).runMigrations();await owner.query('GRANT USAGE ON SCHEMA public TO auth_app');await owner.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO auth_app');
 let auth=createAuth(cfg,app,send);const email='new@example.com';
 assert.equal((await call(auth,'send-code',{email})).status,200);assert.match(last,/^\d{6}$/);assert.equal((await owner.query('SELECT count(*) FROM "user"')).rows[0].count,'0');
 const wrong=await call(auth,'verify-code',{email,otp:last==='000000'?'000001':'000000'});assert.equal(wrong.status,400);
 const signed=await call(auth,'verify-code',{email,otp:last});assert.equal(signed.status,200);assert.equal((await owner.query('SELECT count(*) FROM "user"')).rows[0].count,'1');
 const cookie=cookies(signed);assert.match(cookie,/session_token/);assert.ok(signed.setCookies.every(c=>/HttpOnly/.test(c)));assert.ok(signed.setCookies.some(c=>/Secure/.test(c)&&/Max-Age=15552000/i.test(c)));
 const first=await call(auth,'session',{},cookie);assert.equal(first.body.user.email,email);
 const session=first.body.session;assert.ok(Math.abs((Date.parse(session.expiresAt)-Date.parse(session.createdAt))/1000-15552000)<2);
 await owner.query('UPDATE "session" SET "updatedAt"=now()-interval \'2 days\'');auth=createAuth(cfg,app,send);
 const again=await call(auth,'session',{},cookie);assert.equal(again.body.session.expiresAt,session.expiresAt);
 await owner.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\'');assert.equal((await call(auth,'session',{},cookie)).body,null);
 await owner.query('UPDATE "session" SET "expiresAt"=$1',[session.expiresAt]);
 assert.equal((await call(auth,'verify-code',{email,otp:last})).status,400);
 const evil=await bridge('sign-out',{headers:{origin:'https://evil.example',cookie},body:{}},origin,auth.handler);assert.equal(evil.status,403);
 assert.equal((await call(auth,'sign-out',{},cookie)).status,200);assert.equal((await call(auth,'session',{},cookie)).body,null);
 await owner.query('DELETE FROM "rateLimit"');
 await call(auth,'send-code',{email});const expired=last;await owner.query('UPDATE "verification" SET "expiresAt"=now()-interval \'1 second\'');assert.equal((await call(auth,'verify-code',{email,otp:expired})).status,400);
 await owner.query('DELETE FROM "rateLimit"');
 await call(auth,'send-code',{email});const saved=last;await call(auth,'send-code',{email});assert.notEqual(last,saved);assert.equal((await call(auth,'verify-code',{email,otp:saved})).status,400);
 for(let i=0;i<3;i++)await call(auth,'verify-code',{email,otp:last==='000000'?'000001':'000000'});assert.notEqual((await call(auth,'verify-code',{email,otp:last})).status,200);
 await owner.query('DELETE FROM "rateLimit"');for(let i=0;i<3;i++)await call(auth,'send-code',{email});assert.equal((await call(auth,'send-code',{email})).status,429);
 assert.ok(mails>=1);await assert.rejects(()=>app.query('SELECT * FROM private_fixture.foreign_data'),e=>e.code==='42501');await assert.rejects(()=>app.query('CREATE TABLE public.denied(id integer)'),e=>e.code==='42501');
 }finally{await app.end();await owner.end();}
});
