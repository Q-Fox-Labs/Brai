// ABOUTME: Проверяет закрытый transport-контракт, cookies и шаблон OTP письма.
// ABOUTME: Ошибки и чувствительные заголовки остаются внутри заданной границы.
import test from 'node:test';
import assert from 'node:assert/strict';
import {bridge} from '../dist/bridge.js';
import {otpEmail} from '../dist/email.js';
const origin='https://test.example';
test('all Set-Cookie and native JSON/status survive the bridge',async()=>{
 const result=await bridge('verify-code',{headers:{origin,cookie:'a=b'},body:{email:'test@example.com',otp:'000012'}},origin,async request=>{
 assert.equal(request.url,origin+'/api/auth/sign-in/email-otp');assert.equal(request.headers.get('cookie'),'a=b');assert.equal((await request.json()).otp,'000012');
 const headers=new Headers();headers.append('set-cookie','one=1; HttpOnly; Secure; SameSite=Lax');headers.append('set-cookie','two=2; HttpOnly; Secure');return Response.json({user:{id:'u'}},{headers});
 });assert.equal(result.status,200);assert.equal(result.setCookies.length,2);
});
test('send-code fixes purpose; session uses GET and empty body',async()=>{
 await bridge('send-code',{headers:{origin},body:{email:'a@example.com'}},origin,async request=>{assert.deepEqual(await request.json(),{email:'a@example.com',type:'sign-in'});return Response.json({success:true});});
 await bridge('session',{headers:{cookie:'session=x'},body:{}},origin,async request=>{assert.equal(request.method,'GET');assert.equal(await request.text(),'');return Response.json(null);});
});
test('arbitrary URL/header/body, numeric OTP and missing Origin are rejected before handler',async()=>{
 for(const payload of [{headers:{origin},body:{email:'a@example.com',otp:12}},{headers:{origin,authorization:'Bearer x'},body:{email:'a@example.com',otp:'000012'}},{headers:{origin},body:{email:'a@example.com',otp:'000012'},url:'https://evil'},{headers:{},body:{email:'a@example.com',otp:'000012'}}])await assert.rejects(()=>bridge('verify-code',payload,origin,async()=>{throw new Error('handler must not execute');}),/Invalid|Origin/);
});
test('native Origin rejection/status preserved',async()=>{
 const result=await bridge('sign-out',{headers:{origin:'https://evil.example'},body:{}},origin,async request=>{assert.equal(request.headers.get('origin'),'https://evil.example');return Response.json({code:'INVALID_ORIGIN'},{status:403});});assert.equal(result.status,403);
});
test('mail matches Brai-old content and keeps its responsive layout and public logo',()=>{
 const email=otpEmail('000012',origin);
 assert.equal(email.subject,'Код входа в Brai');
 assert.equal(email.text,[
  'Ваш одноразовый код', '', 'Введите этот код в Brai, чтобы завершить вход.', '',
  '000012', '', 'Код действует 5 минут.',
  'Если вы не запрашивали код, просто проигнорируйте это письмо.', '', 'Brai · brai.one'
 ].join('\n'));
 assert.match(email.html,/class="otp-code"[^>]*>000012<\/div>/);
 assert.match(email.html,/<img src="https:\/\/test\.example\/brand\/brai-logo-email-white-bg\.png" width="150" height="80" alt="Brai"/);
 assert.match(email.html,/@media only screen and \(max-width: 620px\)/);
 assert.match(email.html,/max-width:600px/);
 assert.match(email.html,/font-size: 40px !important; letter-spacing: 4px !important;/);
 for(const otp of ['', '12', '12345', '1234567', '12345x', '<1234>', '１２３４５６']) {
  assert.throws(()=>otpEmail(otp,origin),/Invalid OTP format/);
 }
});
