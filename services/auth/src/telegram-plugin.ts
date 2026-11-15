// ABOUTME: Создаёт сессию Better Auth после погашения кода Telegram.
// ABOUTME: Cookie устанавливает официальная библиотека; токен не входит в JSON.
import { createAuthEndpoint, formCsrfMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { Pool } from "pg";
import { consumeCodeGrant } from "./login-code.js";
import { lifecycleLock } from "./lifecycle.js";

/** Возвращает штатное расширение Better Auth для входа по коду. */
export function telegramPlugin(pool:Pool,secret:string) {
 return {id:"brai-telegram",endpoints:{telegramRedeem:createAuthEndpoint("/brai/telegram-redeem",{method:"POST",use:[formCsrfMiddleware],body:z.strictObject({code:z.string().max(64)})},async ctx=>{
  const source=ctx.request?.headers.get("x-forwarded-for")??"unknown";
  const grant=await consumeCodeGrant(pool,secret,ctx.body.code,source);
  if(!grant)throw ctx.error("UNAUTHORIZED",{message:"Invalid code"});
  const user=await ctx.context.internalAdapter.findUserById(grant.userId);
  if(!user)throw ctx.error("UNAUTHORIZED",{message:"Invalid code"});
  const session=await ctx.context.internalAdapter.createSession(user.id);
  if(!session)throw ctx.error("INTERNAL_SERVER_ERROR",{message:"Session unavailable"});
  // AIDEV-NOTE: Код мог быть погашен до revoke, а сессия создана после него.
  // Эпоха хранится на сессии: восстановление учётной записи не оживляет старый вход.
  const client=await pool.connect();let valid=false;
  try{
   await client.query("BEGIN");await lifecycleLock(client);
   const stamped=await client.query('UPDATE "session" s SET brai_generation=$3 FROM brai_identity i WHERE s.id=$1 AND s."userId"=$2 AND i.user_id=s."userId" AND i.status=\'active\' AND i.role IN (\'creator\',\'admin\',\'user\') AND i.lifecycle_generation=$3 RETURNING s.id',[session.id,user.id,grant.generation]);
   valid=!!stamped.rowCount;
   if(!valid)await client.query('DELETE FROM "session" WHERE id=$1 AND "userId"=$2',[session.id,user.id]);
   await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  if(!valid)throw ctx.error("UNAUTHORIZED",{message:"Invalid code"});
  await setSessionCookie(ctx,{session,user});
  return ctx.json({success:true});
 })}};
}
