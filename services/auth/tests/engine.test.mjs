// ABOUTME: Проверяет реальные OTP и сессии официального Better Auth без внешних сервисов.
// ABOUTME: Штатный memory adapter и синтетическое письмо используются только в тесте.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {betterAuth} from 'better-auth';
import {memoryAdapter} from 'better-auth/adapters/memory';
import {createAuth} from '../dist/auth.js';
import {bridge} from '../dist/bridge.js';

const cfg={origin:'https://test.example',secret:'fixture-secret-32-chars-long-enough',resendKey:'',emailFrom:'fixture@example.com'};
function check(condition,label){assert.equal(Boolean(condition),true,label);}
function fixture(ip){
 let code='';const pool=new Pool();const configured=createAuth(cfg,pool,async(_,otp)=>{code=otp});
 const db={user:[],session:[],verification:[],account:[],rateLimit:[]};
 const auth=betterAuth({...configured.options,database:memoryAdapter(db)});
 const call=(op,body={},cookie='',origin=cfg.origin)=>bridge(op,{headers:{origin,cookie,'x-forwarded-for':ip},body},cfg.origin,auth.handler);
 const signIn=async(email)=>{
  const sent=await call('send-code',{email});check(sent.status===200,'OTP send accepted');
  check(/^\d{6}$/.test(code),'OTP format preserved');
  const signed=await call('verify-code',{email,otp:code});check(signed.status===200,'OTP sign-in accepted');
  return signed.setCookies.map(c=>c.split(';')[0]).join('; ');
 };
 return {db,call,signIn,getCode:()=>code,close:()=>pool.end()};
}

test('official engine limits OTP sends and allows repeated fresh session reads',async(t)=>{
 const f=fixture('192.0.2.10');t.after(f.close);const email='a@example.com';
 for(let i=0;i<3;i++)check((await f.call('send-code',{email})).status===200,'OTP send within limit');
 check(/^\d{6}$/.test(f.getCode()),'OTP format preserved');
 check((await f.call('send-code',{email})).status===429,'fourth OTP send is limited');
 check(f.db.user.length===0,'OTP send does not create account');
 const signed=await f.call('verify-code',{email,otp:f.getCode()});check(signed.status===200,'OTP sign-in accepted');
 check((await f.call('verify-code',{email,otp:f.getCode()})).status===400,'consumed OTP cannot be reused');
 const cookie=signed.setCookies.map(c=>c.split(';')[0]).join('; ');
 let expiresAt='',createdAt='';
 for(let i=0;i<125;i++){
  const current=await f.call('session',{},cookie);
  check(current.status===200,`session read status at request ${i+1}: ${current.status===429?'429':'other'}`);
  check(current.body?.user?.email===email,'session identity stays valid');
  const observed=current.body.session.expiresAt;
  if(i===0){expiresAt=observed;createdAt=current.body.session.createdAt;}
  check(observed===expiresAt,'session expiry remains fixed');
 }
 check(Math.round((Date.parse(expiresAt)-Date.parse(createdAt))/1000)===15552000,'session lifetime remains fixed');
});

test('official engine rejects wrong-origin sign-out and honors revocation and expiry',async(t)=>{
 const f=fixture('192.0.2.11');t.after(f.close);
 const revokedCookie=await f.signIn('a@example.com');
 check((await f.call('sign-out',{},revokedCookie,'https://attacker.example')).status===403,'wrong-origin sign-out is rejected');
 check((await f.call('sign-out',{},revokedCookie)).status===200,'sign-out succeeds');
 const revoked=await f.call('session',{},revokedCookie);check(revoked.status===200&&revoked.body===null,'revoked session is absent');
 const expiredCookie=await f.signIn('b@example.com');
 f.db.session.find(s=>s.userId===f.db.user.find(u=>u.email==='b@example.com').id).expiresAt=new Date(Date.now()-1000);
 const expired=await f.call('session',{},expiredCookie);check(expired.status===200&&expired.body===null,'expired session is absent');
});
