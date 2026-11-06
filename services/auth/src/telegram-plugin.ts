// ABOUTME: Создаёт сессию Better Auth после погашения кода Telegram.
// ABOUTME: Cookie устанавливает официальная библиотека; токен не входит в JSON.
import { createAuthEndpoint, formCsrfMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { Pool } from "pg";
import { consumeCode } from "./login-code.js";

/** Возвращает штатное расширение Better Auth для входа по коду. */
export function telegramPlugin(pool:Pool,secret:string) {
 return {id:"brai-telegram",endpoints:{telegramRedeem:createAuthEndpoint("/brai/telegram-redeem",{method:"POST",use:[formCsrfMiddleware],body:z.strictObject({code:z.string().max(64)})},async ctx=>{
  const source=ctx.request?.headers.get("x-forwarded-for")??"unknown";
  const userId=await consumeCode(pool,secret,ctx.body.code,source);
  if(!userId)throw ctx.error("UNAUTHORIZED",{message:"Invalid code"});
  const user=await ctx.context.internalAdapter.findUserById(userId);
  if(!user)throw ctx.error("UNAUTHORIZED",{message:"Invalid code"});
  const session=await ctx.context.internalAdapter.createSession(user.id);
  if(!session)throw ctx.error("INTERNAL_SERVER_ERROR",{message:"Session unavailable"});
  await setSessionCookie(ctx,{session,user});
  return ctx.json({success:true});
 })}};
}
