// ABOUTME: Проверяет одноразовую передачу реальной сессии Better Auth в превью.
// ABOUTME: Использует синтетические данные и штатный memory adapter.
import test from 'node:test';import assert from 'node:assert/strict';import {randomBytes,createHash} from 'node:crypto';import {Pool} from 'pg';
import {betterAuth} from 'better-auth';import {memoryAdapter} from 'better-auth/adapters/memory';import {createAuth} from '../dist/auth.js';import {bridge} from '../dist/bridge.js';import {config} from '../dist/config.js';
const hub='https://hub.example', preview='https://preview.example';
const cfg={origin:hub,trustedOrigins:[hub,preview],ssoHubOrigin:hub,ssoPreviewOrigins:[preview],secret:'fixture-secret-32-chars-long-enough',resendKey:'',emailFrom:'fixture@example.com'};
const state=()=>{const verifier=randomBytes(32).toString('base64url');return {verifier,challenge:createHash('sha256').update(verifier).digest('base64url')};};
test('SSO uses existing session and rejects tamper, wrong state, audience and replay',async t=>{
 const pool=new Pool();t.after(()=>pool.end());let code='';const configured=createAuth(cfg,pool,async(_,otp)=>{code=otp});const db={user:[],session:[],verification:[],account:[],rateLimit:[]};const auth=betterAuth({...configured.options,database:memoryAdapter(db)});
 const call=(op,body={},cookie='',origin=hub)=>bridge(op,{headers:{origin,cookie,'x-forwarded-for':'192.0.2.51'},body},hub,auth.handler,cfg);
 await call('send-code',{email:'sso@example.com'});const signed=await call('verify-code',{email:'sso@example.com',otp:code});assert.equal(signed.status,200);const cookie=signed.setCookies.map(v=>v.split(';')[0]).join('; ');
 const {verifier,challenge}=state();const issue=await call('sso-issue',{targetOrigin:preview,challenge},cookie);assert.equal(issue.status,200);assert.deepEqual(issue.setCookies,[]);const ticket=issue.body.ticket;
 assert.equal((await call('sso-redeem',{ticket,verifier:state().verifier,targetOrigin:preview},'',preview)).status,400);
 assert.equal((await call('sso-redeem',{ticket:ticket.slice(0,-2)+'AA',verifier,targetOrigin:preview},'',preview)).status,400);
 assert.equal((await call('sso-redeem',{ticket,verifier,targetOrigin:preview},'',hub)).status,400);
 const redeemed=await call('sso-redeem',{ticket,verifier,targetOrigin:preview},'',preview);assert.equal(redeemed.status,200);assert.deepEqual(redeemed.body,{success:true});assert.ok(redeemed.setCookies.length);const previewCookie=redeemed.setCookies.map(v=>v.split(';')[0]).join('; ');
 assert.equal((await call('sso-redeem',{ticket,verifier,targetOrigin:preview},'',preview)).status,400);
 assert.equal((await call('session',{},previewCookie,preview)).body.user.email,'sso@example.com');await call('sign-out',{},cookie);assert.equal((await call('session',{},previewCookie,preview)).body,null);
});
test('configuration is disabled by default and requires explicit secure allowlist',()=>{
 const env={AUTH_ORIGIN:hub,AUTH_SECRET:'a'.repeat(32),AUTH_DATABASE_URL:'postgres://fixture',AUTH_EMAIL_FROM:'fixture@example.com'};
 assert.equal(config(env,'migration').ssoHubOrigin,undefined);
 assert.throws(()=>config({...env,AUTH_SSO_HUB_ORIGIN:hub},'migration'));
 assert.throws(()=>config({...env,AUTH_SSO_HUB_ORIGIN:hub,AUTH_SSO_PREVIEW_ORIGINS:'https://*.example'},'migration'));
 assert.deepEqual(config({...env,AUTH_TRUSTED_ORIGINS:preview,AUTH_SSO_HUB_ORIGIN:hub,AUTH_SSO_PREVIEW_ORIGINS:preview},'migration').ssoPreviewOrigins,[preview]);
});
