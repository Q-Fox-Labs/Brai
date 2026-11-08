// ABOUTME: Создаёт постоянного автора профиля и его первый канал Telegram.
// ABOUTME: Освобождённый внешний ID не наследует автора или данные прежнего профиля.
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { IdentityUser } from "./identity-types.js";

/** Сохраняет автора памяти отдельно от повторно используемого внешнего аккаунта. Вызывается под provision-lock. */
export async function insertIdentity(client:PoolClient,user:IdentityUser&{telegramId:string}):Promise<IdentityUser> {
 const telegramId=user.telegramId;let author=telegramId;
 while((await client.query("SELECT 1 FROM brai_identity WHERE telegram_id=$1 UNION ALL SELECT 1 FROM sys_telegram_account WHERE telegram_id=$1",[author])).rowCount){
  author="9"+randomBytes(8).readBigUInt64BE().toString().padStart(20,"0").slice(-19);
 }
 await client.query("INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,$2,$3,$4,$5)",[user.id,author,user.profileId,user.role,user.status]);
 if(author!==telegramId){
  // AIDEV-NOTE: Триггер обслуживает первоначальную регистрацию; синтетический автор не является каналом доступа.
  await client.query("DELETE FROM sys_telegram_account WHERE telegram_id=$1 AND user_id=$2",[author,user.id]);
  await client.query("INSERT INTO sys_telegram_account(telegram_id,user_id) VALUES($1,$2)",[telegramId,user.id]);
 }
 return {...user,telegramId:author};
}
