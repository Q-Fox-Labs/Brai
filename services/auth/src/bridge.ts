// ABOUTME: Переводит четыре закрытые операции NATS в штатный HTTP-handler Better Auth.
// ABOUTME: Не открывает HTTP-порт, не принимает URL и не отключает Origin/CSRF.
import { validate } from "./schema.js";
export const subjects={"send-code":"brai.auth.v1.send-code","verify-code":"brai.auth.v1.verify-code",session:"brai.auth.v1.session","sign-out":"brai.auth.v1.sign-out"} as const;
export type Operation=keyof typeof subjects;
const headersAllowed=new Set(["cookie","origin","user-agent","x-forwarded-for","sec-fetch-site"]);
/** Проверяет DTO и возвращает ответ handler с отдельным массивом всех Set-Cookie. */
export async function bridge(operation:Operation,payload:unknown,origin:string,handler:(request:Request)=>Promise<Response>) {
 validate({"send-code":"SendCodeRequest","verify-code":"VerifyCodeRequest",session:"SessionRequest","sign-out":"SignOutRequest"}[operation],payload);
 if(!payload||typeof payload!=="object"||Array.isArray(payload))throw new Error("Invalid request");
 const input=payload as Record<string,unknown>;
 if(Object.keys(input).some(k=>k!=="headers"&&k!=="body"))throw new Error("Invalid request fields");
 if(!input.headers||typeof input.headers!=="object"||Array.isArray(input.headers))throw new Error("Invalid headers");
 const headers=new Headers();
 for(const [key,value] of Object.entries(input.headers)){if(!headersAllowed.has(key)||typeof value!=="string"||value.length>16384)throw new Error("Invalid header");headers.set(key,value);}
 const body=input.body;
 if(!body||typeof body!=="object"||Array.isArray(body))throw new Error("Invalid body");
 const b=body as Record<string,unknown>;
 const allowed=operation==="send-code"?["email"]:operation==="verify-code"?["email","otp"]:[];
 if(Object.keys(b).some(k=>!allowed.includes(k))||allowed.some(k=>typeof b[k]!=="string"))throw new Error("Invalid body fields");
 if(allowed.includes("email")&&(String(b.email).length>320||!/^\S+@\S+\.\S+$/.test(String(b.email))))throw new Error("Invalid email");
 if(operation==="verify-code"&&!/^\d{6}$/.test(String(b.otp)))throw new Error("Invalid OTP");
 if(operation!=="session"&&!headers.has("origin"))throw new Error("Origin required");
 const path={"send-code":"/email-otp/send-verification-otp","verify-code":"/sign-in/email-otp",session:"/get-session","sign-out":"/sign-out"}[operation];
 const actualBody=operation==="send-code"?{email:b.email,type:"sign-in"}:b;
 headers.set("content-type","application/json");
 const request=new Request(`${origin}/api/auth${path}`,{method:operation==="session"?"GET":"POST",headers,...(operation==="session"?{}:{body:JSON.stringify(actualBody)})});
 const response=await handler(request);
 const text=await response.text();
 return {status:response.status,body:text?JSON.parse(text):null,setCookies:response.headers.getSetCookie()};
}
