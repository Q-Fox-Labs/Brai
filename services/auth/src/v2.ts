// ABOUTME: Проверяет запросы v2 и направляет их в операции идентичностей Auth.
// ABOUTME: Доверенные Telegram-команды и web-команды имеют разные subjects и ACL.
import { z } from "zod";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { adminAction } from "./admin.js";
import { issueCode } from "./login-code.js";
import { getIdentity, issueTelegramLink, profileReady, provision, redeemInvite, redeemTelegramLink, resolveTelegram, unlinkTelegram } from "./identity.js";

const id=z.string().min(1).max(128);
const telegramId=z.string().regex(/^[0-9]{1,20}$/);
const role=z.enum(["admin","user"]), status=z.enum(["provisioning","active","blocked"]);
const headersSchema=z.strictObject({cookie:z.string().max(16384).optional(),origin:z.string().max(16384).optional(),"user-agent":z.string().max(16384).optional(),"x-forwarded-for":z.string().max(16384).optional(),"sec-fetch-site":z.string().max(16384).optional()});
const trusted={
 "telegram-resolve":z.strictObject({telegramId}),
 "telegram-link-issue":z.strictObject({telegramId}),
 "telegram-link-redeem":z.strictObject({telegramId,code:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}),
 "telegram-unlink":z.strictObject({telegramId,targetTelegramId:telegramId}),
 "identity-get":z.strictObject({userId:id}),
 "telegram-code-issue":z.strictObject({telegramId,requestId:id}),
 "identity-provision":z.strictObject({requestId:id,telegramId,name:z.string().min(1).max(200).optional(),role,userId:id.optional(),profileId:id.optional(),status}),
 "profile-ready":z.strictObject({userId:id,profileId:id}),
 "invite-redeem":z.strictObject({telegramId,code:z.string().regex(/^[A-Za-z0-9_-]{43}$/),name:z.string().min(1).max(200).optional()})
};
const admin={
 "users-list":z.strictObject({}),"users-get":z.strictObject({userId:id}),
 "role-set":z.strictObject({userId:id,role}),"status-set":z.strictObject({userId:id,status}),
 "sessions-revoke":z.strictObject({userId:id}),"invite-create":z.strictObject({}),
 "invite-list":z.strictObject({}),"invite-revoke":z.strictObject({inviteId:id}),
 "admin-audit":z.strictObject({userId:id,action:z.enum(["memory.list","memory.read","chats.list","chats.read","artifacts.list","artifacts.read","personal.read"])})
};
export const v2Subjects=Object.fromEntries([...Object.keys(trusted),...Object.keys(admin),"login-code-redeem"].map(name=>[name,"brai.auth.v2."+name]));
type Handler=(request:Request)=>Promise<Response>;
function parse<T>(schema:z.ZodType<T>,value:unknown):T {const parsed=schema.safeParse(value);if(!parsed.success)throw new Error("Invalid request");return parsed.data;}
/** Возвращает действующий идентификатор сессии после проверки Better Auth и БД. */
export async function sessionIdentity(pool:Pool,cfg:Config,handler:Handler,headers:Headers) {
 const response=await handler(new Request(cfg.origin+"/api/auth/get-session",{method:"GET",headers}));
 if(!response.ok)return null;
 const session=await response.json() as {user?:{id?:unknown},session?:{id?:unknown}}|null;
 if(typeof session?.user?.id!=="string"||typeof session.session?.id!=="string")return null;
 const result=await pool.query('SELECT u.id,u.name,i.role,i.status,i.telegram_id AS "telegramId",i.profile_id AS "profileId" FROM brai_identity i JOIN "user" u ON u.id=i.user_id WHERE i.user_id=$1 AND i.status=\'active\'',[session.user.id]);
 return result.rows[0]?{...result.rows[0],sessionId:session.session.id}:null;
}
/** Исполняет валидированный запрос; секреты не попадают в ошибки транспорта. */
export async function v2(operation:string,input:unknown,cfg:Config,pool:Pool,handler:Handler) {
 if(cfg.identityMode!=="telegram")throw new Error("Invalid identity mode");
 if(operation==="telegram-link-issue"){const data=parse(trusted[operation],input);return issueTelegramLink(pool,cfg.secret,data.telegramId);}
 if(operation==="telegram-link-redeem"){const data=parse(trusted[operation],input);return {user:await redeemTelegramLink(pool,cfg.secret,data.telegramId,data.code)};}
 if(operation==="telegram-unlink"){const data=parse(trusted[operation],input);return {unlinked:await unlinkTelegram(pool,data.telegramId,data.targetTelegramId)};}
 if(operation==="identity-get"){const data=parse(trusted[operation],input);return getIdentity(pool,data.userId);}
 if(operation==="telegram-resolve"){const data=parse(trusted[operation],input);return {user:await resolveTelegram(pool,data.telegramId)};}
 if(operation==="telegram-code-issue"){const data=parse(trusted[operation],input);const code=await issueCode(pool,cfg.secret,data.telegramId);if(!code)throw new Error("Invalid request");return {...code,origin:cfg.origin};}
 if(operation==="identity-provision"){const data=parse(trusted[operation],input);if(data.status==="active"&&!data.profileId)throw new Error("Invalid request");return {user:await provision(pool,cfg.secret,data)};}
 if(operation==="profile-ready"){const data=parse(trusted[operation],input);return {user:await profileReady(pool,data.userId,data.profileId)};}
 if(operation==="invite-redeem"){const data=parse(trusted[operation],input);return {user:await redeemInvite(pool,cfg.secret,data.telegramId,data.code,data.name)};}
 const schema=operation==="login-code-redeem"?z.strictObject({code:z.string().max(64)}):admin[operation as keyof typeof admin];
 if(!schema)throw new Error("Invalid operation");
 const request=parse(z.strictObject({headers:headersSchema,body:schema}),input);
 const headers=new Headers(request.headers);
 const origin=headers.get("origin");
 if(!origin||!cfg.trustedOrigins.includes(origin))return {status:403,body:{code:"FORBIDDEN"},setCookies:[]};
 if(operation==="login-code-redeem"){
  headers.set("content-type","application/json");
  const response=await handler(new Request(cfg.origin+"/api/auth/brai/telegram-redeem",{method:"POST",headers,body:JSON.stringify(request.body)}));
  const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null,setCookies:response.headers.getSetCookie()};
 }
 const user=await sessionIdentity(pool,cfg,handler,headers);
 if(!user)return {status:401,body:{code:"UNAUTHORIZED"},setCookies:[]};
 const result=await adminAction(pool,cfg.secret,user.id,operation as keyof typeof admin,request.body as Record<string,string>,user.sessionId);
 return {...result,setCookies:[]};
}
