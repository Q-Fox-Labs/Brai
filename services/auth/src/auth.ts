// ABOUTME: Настраивает неизменённый Better Auth и штатный Email OTP.
// ABOUTME: Владение OTP, аккаунтами и сессиями остаётся у официальной библиотеки.
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
import { randomInt } from "node:crypto";
import { Resend } from "resend";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { otpEmail } from "./email.js";
/** Собирает auth; callback ожидает принятия письма Resend и не журналирует данные. */
export function createAuth(cfg:Config,pool:Pool,send?:(email:string,otp:string)=>Promise<void>) {

 return betterAuth({database:pool,baseURL:cfg.origin,basePath:"/api/auth",secret:cfg.secret,trustedOrigins:[cfg.origin],
  session:{expiresIn:15_552_000,disableSessionRefresh:true,cookieCache:{enabled:false}},
  rateLimit:{enabled:true,storage:"database",customRules:{"/get-session":false}},
  advanced:{useSecureCookies:cfg.origin.startsWith("https://"),defaultCookieAttributes:{httpOnly:true,sameSite:"lax"}},
  logger:{disabled:true},
  plugins:[emailOTP({otpLength:6,expiresIn:300,allowedAttempts:3,storeOTP:"hashed",disableSignUp:false,
   // AIDEV-NOTE: Штатное расширение генерирует цифровой код с ведущими нулями.
   generateOTP:()=>randomInt(0,1_000_000).toString().padStart(6,"0"),
   async sendVerificationOTP({email,otp,type}) {
    if(type!=="sign-in")throw new Error("Unsupported OTP purpose");
    if(send){await send(email,otp);return;}
    const result=await new Resend(cfg.resendKey).emails.send({from:cfg.emailFrom,to:email,...otpEmail(otp)});
    if(result.error)throw new Error("Email delivery rejected");
   }})]});
}
