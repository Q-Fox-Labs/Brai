// ABOUTME: Сохраняет состояние Welcome и сериализует обработку обновлений одного пользователя.
// ABOUTME: Внешние эффекты имеют стабильные ID; повтор Telegram возвращает тот же результат.
import {randomBytes, randomUUID} from 'node:crypto';

/** Берёт отдельную сессию PostgreSQL и освобождает блокировку при любом исходе. */
export async function withVisitor(pool, identity, profile, ref, run) {
 const db = await pool.connect();
 let broken = false;
 try {
  await db.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", ['welcome:'+identity.id]);
  const code = randomBytes(18).toString('base64url');
  const result = await db.query(`INSERT INTO welcome.visitors(user_id,profile_id,telegram_id,name,username,referral_code,inviter_id,avatar_file_id)
   VALUES($1,$2,$3,$4,$5,$6,(SELECT user_id FROM welcome.visitors WHERE referral_code=$7),$8)
   ON CONFLICT(user_id) DO UPDATE SET name=EXCLUDED.name,username=EXCLUDED.username,
    avatar_file_id=COALESCE(EXCLUDED.avatar_file_id,welcome.visitors.avatar_file_id)
   WHERE welcome.visitors.profile_id=EXCLUDED.profile_id AND welcome.visitors.telegram_id=EXCLUDED.telegram_id
   RETURNING *`,[identity.id,identity.profileId,profile.id,profile.name,profile.username,code,ref,profile.avatarFileId]);
  if (result.rowCount!==1) throw Error('WELCOME_BINDING_CHANGED');
  return await run(db,result.rows[0]);
 } finally {
  try { await db.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", ['welcome:'+identity.id]); }
  catch { broken=true; }
  db.release(broken);
 }
}

/** Регистрирует update один раз и проверяет совпадение с предыдущей доставкой. */
export async function capture(db, actor, event, dialogueId, text) {
 await db.query(`INSERT INTO welcome.turns(bot_id,update_id,user_id,dialogue_id,input_text)
  VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[event.botId,event.updateId,actor.user_id,dialogueId,text]);
 const {rows:[turn]}=await db.query('SELECT * FROM welcome.turns WHERE bot_id=$1 AND update_id=$2',[event.botId,event.updateId]);
 if (turn.user_id!==actor.user_id || turn.dialogue_id!==dialogueId) throw Error('WELCOME_UPDATE_CONFLICT');
 return turn;
}

/** Читает активный расход обоих окон одним запросом по времени PostgreSQL. */
export async function usage(db, owner) {
 const {rows:[row]}=await db.query(`SELECT clock_timestamp() AS now,
   ARRAY(SELECT request_at FROM welcome.turns WHERE user_id=$1 AND request_at>statement_timestamp()-interval '24 hours') AS requests,
   ARRAY(SELECT image_at FROM welcome.turns WHERE user_id=$1 AND image_at>statement_timestamp()-interval '24 hours') AS images`,[owner]);
 return row;
}

/** Записывает одну открытую заявку. Повтор кнопки возвращает текущую заявку. */
export async function submitApplication(db, actor) {
 const {rows:[existing]}=await db.query("SELECT id,status FROM welcome.applications WHERE user_id=$1 AND status IN ('pending','approving','approved') ORDER BY created_at DESC LIMIT 1",[actor.user_id]);
 if(existing) return existing;
 const draft=actor.questionnaire;
 if(!draft?.occupation || !draft?.purpose) return null;
 const {rows:[application]}=await db.query(`INSERT INTO welcome.applications(id,user_id,occupation,purpose,status)
  VALUES($1,$2,$3,$4,'pending') RETURNING id,status`,[randomUUID(),actor.user_id,draft.occupation,draft.purpose]);
 await db.query("UPDATE welcome.visitors SET questionnaire=NULL WHERE user_id=$1",[actor.user_id]);
 return application;
}

/** Сохраняет ответ на вопрос анкеты и отдаёт новое состояние. */
export async function saveDraft(db, actor, value) {
 await db.query("UPDATE welcome.visitors SET questionnaire=$2 WHERE user_id=$1",[actor.user_id,value]);
 actor.questionnaire=value;
}
