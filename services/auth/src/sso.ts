// ABOUTME: Передаёт существующую сессию в явно разрешённое превью через одноразовый билет.
// ABOUTME: Не возвращает токен сессии и проверяет привязку до погашения билета.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";

/** Максимальный срок одноразового подтверждения входа, миллисекунды. */
export const SSO_TTL_MS = 60_000;
type Settings = Pick<Config,"secret"|"ssoHubOrigin"|"ssoPreviewOrigins">;
type Handler = (request:Request)=>Promise<Response>;
const failure=()=>({status:400,body:{error:"INVALID_SSO"},setCookies:[] as string[]});
const key=(secret:string)=>Buffer.from(hkdfSync("sha256",secret,"brai.auth.sso.v1","ticket encryption",32));
const digest=(verifier:string)=>createHash("sha256").update(verifier,"utf8").digest();
/** Проверяет область билета и вызывает только штатные endpoint плагина Better Auth в памяти. */
export async function sso(operation:"sso-issue"|"sso-redeem",headers:Headers,body:Record<string,unknown>,origin:string,handler:Handler,cfg?:Settings){
 if(!cfg?.ssoHubOrigin||!cfg.ssoPreviewOrigins||typeof body.targetOrigin!=="string"||!cfg.ssoPreviewOrigins.includes(body.targetOrigin))return failure();
 const targetOrigin=body.targetOrigin;
 if(operation==="sso-issue"){
  if(headers.get("origin")!==cfg.ssoHubOrigin||typeof body.challenge!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(body.challenge))return failure();
  const response=await handler(new Request(`${origin}/api/auth/one-time-token/generate`,{method:"GET",headers}));
  if(!response.ok)return failure();
  const result=await response.json() as {token?:unknown};
  if(typeof result.token!=="string"||!result.token)return failure();
  const iv=randomBytes(12), cipher=createCipheriv("aes-256-gcm",key(cfg.secret),iv);
  const plaintext=JSON.stringify({token:result.token,targetOrigin,challenge:body.challenge,expiresAt:Date.now()+SSO_TTL_MS});
  const encrypted=Buffer.concat([cipher.update(plaintext,"utf8"),cipher.final()]);
  return {status:200,body:{ticket:Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString("base64url")},setCookies:[]};
 }
 if(headers.get("origin")!==targetOrigin||typeof body.ticket!=="string"||typeof body.verifier!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(body.verifier)||!/^[A-Za-z0-9_-]{1,4096}$/.test(body.ticket))return failure();
 let ticket:{token:unknown;targetOrigin:unknown;challenge:unknown;expiresAt:unknown};
 try{
  const bytes=Buffer.from(body.ticket,"base64url");if(bytes.length<29||bytes.toString("base64url")!==body.ticket)return failure();
  const decipher=createDecipheriv("aes-256-gcm",key(cfg.secret),bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));
  ticket=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString("utf8"));
 }catch{return failure();}
 if(!ticket||typeof ticket.token!=="string"||ticket.targetOrigin!==targetOrigin||typeof ticket.challenge!=="string"||!/^[A-Za-z0-9_-]{43}$/.test(ticket.challenge)||typeof ticket.expiresAt!=="number"||!Number.isSafeInteger(ticket.expiresAt)||ticket.expiresAt<=Date.now())return failure();
 const expected=Buffer.from(ticket.challenge,"base64url"), actual=digest(body.verifier);
 if(expected.length!==actual.length||!timingSafeEqual(expected,actual))return failure();
 const verifyHeaders=new Headers(headers);verifyHeaders.set("content-type","application/json");
 const response=await handler(new Request(`${origin}/api/auth/one-time-token/verify`,{method:"POST",headers:verifyHeaders,body:JSON.stringify({token:ticket.token})}));
 if(!response.ok)return failure();
 return {status:200,body:{success:true},setCookies:response.headers.getSetCookie()};
}
