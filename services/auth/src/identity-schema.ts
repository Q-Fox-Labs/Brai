// ABOUTME: Создаёт постоянные таблицы идентичностей и одноразовых секретов Auth.
// ABOUTME: Выполняется только владельцем БД в отдельном процессе миграции.
import type { Pool } from "pg";

/** Создаёт отсутствующие таблицы; повтор не изменяет существующие данные. */
export async function migrateIdentity(pool:Pool) {
 const schema=await pool.query("SELECT pg_get_userbyid(nspowner) AS owner,current_user AS actor FROM pg_namespace WHERE nspname='auth_identity_owner'");
 if(schema.rowCount&&schema.rows[0].owner!==schema.rows[0].actor)throw new Error("Foreign identity schema");
 await pool.query(`
 CREATE TABLE IF NOT EXISTS brai_identity (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  telegram_id text UNIQUE, profile_id text UNIQUE,
  role text NOT NULL CHECK (role IN ('admin','user')),
  status text NOT NULL CHECK (status IN ('provisioning','active','blocked')),
  created_at timestamptz NOT NULL DEFAULT now()
 );
 COMMENT ON TABLE brai_identity IS 'Роли и внешние идентификаторы пользователей Auth';
 COMMENT ON COLUMN brai_identity.user_id IS 'Идентификатор пользователя Better Auth';
 COMMENT ON COLUMN brai_identity.telegram_id IS 'Стабильный внутренний автор памяти; текущие аккаунты хранятся отдельно';
 COMMENT ON COLUMN brai_identity.profile_id IS 'Идентификатор профиля';
 COMMENT ON COLUMN brai_identity.role IS 'Роль доступа';
 COMMENT ON COLUMN brai_identity.status IS 'Состояние учётной записи';
 COMMENT ON COLUMN brai_identity.created_at IS 'Время создания';
 DO $migration$ BEGIN
 IF to_regclass('sys_telegram_account') IS NULL THEN
 CREATE TABLE sys_telegram_account (
  telegram_id text PRIMARY KEY CHECK (telegram_id ~ '^[1-9][0-9]{0,19}$'),
  user_id text NOT NULL REFERENCES brai_identity(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
 );
 INSERT INTO sys_telegram_account(telegram_id,user_id)
 SELECT telegram_id,user_id FROM brai_identity WHERE telegram_id IS NOT NULL;
 END IF;
 END $migration$;
 COMMENT ON TABLE sys_telegram_account IS 'Проверенные Telegram-аккаунты одного пользователя Auth';
 COMMENT ON COLUMN sys_telegram_account.telegram_id IS 'Уникальный Telegram ID аккаунта';
 COMMENT ON COLUMN sys_telegram_account.user_id IS 'Канонический владелец профиля';
 COMMENT ON COLUMN sys_telegram_account.created_at IS 'Время привязки аккаунта';
 CREATE INDEX IF NOT EXISTS sys_telegram_account_user ON sys_telegram_account(user_id);
 CREATE OR REPLACE FUNCTION sys_register_telegram_author() RETURNS trigger LANGUAGE plpgsql AS $function$
 BEGIN
  IF TG_OP='UPDATE' AND OLD.telegram_id IS NOT NULL AND NEW.telegram_id IS DISTINCT FROM OLD.telegram_id
  THEN RAISE EXCEPTION 'Memory author identity is immutable'; END IF;
  IF NEW.telegram_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.telegram_id IS DISTINCT FROM OLD.telegram_id) THEN
   INSERT INTO sys_telegram_account(telegram_id,user_id) VALUES(NEW.telegram_id,NEW.user_id);
  END IF;
  RETURN NEW;
 END $function$;
 REVOKE ALL ON FUNCTION sys_register_telegram_author() FROM PUBLIC;
 DROP TRIGGER IF EXISTS sys_register_primary_telegram ON brai_identity;
 DROP TRIGGER IF EXISTS sys_register_telegram_author ON brai_identity;
 CREATE TRIGGER sys_register_telegram_author AFTER INSERT OR UPDATE OF telegram_id ON brai_identity
 FOR EACH ROW WHEN (NEW.telegram_id IS NOT NULL) EXECUTE FUNCTION sys_register_telegram_author();
 CREATE TABLE IF NOT EXISTS sys_telegram_link (
  user_id text PRIMARY KEY REFERENCES brai_identity(user_id) ON DELETE CASCADE,
  digest text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  consumed_by text, consumed_at timestamptz
 );
 COMMENT ON TABLE sys_telegram_link IS 'Одноразовая привязка дополнительного Telegram-аккаунта';
 COMMENT ON COLUMN sys_telegram_link.user_id IS 'Владелец существующего профиля';
 COMMENT ON COLUMN sys_telegram_link.digest IS 'HMAC одноразового секрета без открытого кода';
 COMMENT ON COLUMN sys_telegram_link.expires_at IS 'Срок привязки';
 COMMENT ON COLUMN sys_telegram_link.consumed_by IS 'Telegram ID погасившего аккаунта';
 COMMENT ON COLUMN sys_telegram_link.consumed_at IS 'Время погашения';
 CREATE TABLE IF NOT EXISTS brai_login_code (
  user_id text PRIMARY KEY REFERENCES brai_identity(user_id) ON DELETE CASCADE,
  digest text NOT NULL UNIQUE, expires_at timestamptz NOT NULL
 );
 COMMENT ON TABLE brai_login_code IS 'Одноразовые коды входа в виде HMAC';
 COMMENT ON COLUMN brai_login_code.user_id IS 'Владелец кода';
 COMMENT ON COLUMN brai_login_code.digest IS 'HMAC нормализованного кода';
 COMMENT ON COLUMN brai_login_code.expires_at IS 'Срок действия кода';
 CREATE TABLE IF NOT EXISTS brai_auth_limit (
  key text PRIMARY KEY, window_started timestamptz NOT NULL, count integer NOT NULL
 );
 COMMENT ON TABLE brai_auth_limit IS 'Окна ограничения частоты операций входа';
 COMMENT ON COLUMN brai_auth_limit.key IS 'HMAC ключа ограничения';
 COMMENT ON COLUMN brai_auth_limit.window_started IS 'Начало окна';
 COMMENT ON COLUMN brai_auth_limit.count IS 'Число запросов в окне';
 CREATE TABLE IF NOT EXISTS brai_invite (
  id text PRIMARY KEY, digest text NOT NULL UNIQUE, created_by text NOT NULL REFERENCES brai_identity(user_id),
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  revoked_at timestamptz, consumed_at timestamptz, consumed_by text REFERENCES brai_identity(user_id)
 );
 COMMENT ON TABLE brai_invite IS 'Одноразовые приглашения без открытого секрета';
 COMMENT ON COLUMN brai_invite.id IS 'Идентификатор приглашения';
 COMMENT ON COLUMN brai_invite.digest IS 'HMAC секрета';
 COMMENT ON COLUMN brai_invite.created_by IS 'Создавший администратор';
 COMMENT ON COLUMN brai_invite.created_at IS 'Время создания';
 COMMENT ON COLUMN brai_invite.expires_at IS 'Срок действия';
 COMMENT ON COLUMN brai_invite.revoked_at IS 'Время отзыва';
 COMMENT ON COLUMN brai_invite.consumed_at IS 'Время использования';
 COMMENT ON COLUMN brai_invite.consumed_by IS 'Получивший приглашение пользователь';
 CREATE TABLE IF NOT EXISTS brai_identity_request (
  request_id text PRIMARY KEY, fingerprint text NOT NULL, user_id text NOT NULL REFERENCES brai_identity(user_id)
 );
 COMMENT ON TABLE brai_identity_request IS 'Идемпотентность доверенного создания идентичности';
 COMMENT ON COLUMN brai_identity_request.request_id IS 'Идентификатор запроса';
 COMMENT ON COLUMN brai_identity_request.fingerprint IS 'HMAC параметров запроса';
 COMMENT ON COLUMN brai_identity_request.user_id IS 'Созданная идентичность';
 CREATE TABLE IF NOT EXISTS brai_identity_audit (
  id text PRIMARY KEY, actor_id text NOT NULL, target_id text NOT NULL, action text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
 );
 COMMENT ON TABLE brai_identity_audit IS 'Аудит административных действий Auth';
 COMMENT ON COLUMN brai_identity_audit.id IS 'Идентификатор события';
 COMMENT ON COLUMN brai_identity_audit.actor_id IS 'Идентификатор администратора';
 COMMENT ON COLUMN brai_identity_audit.target_id IS 'Идентификатор цели';
 COMMENT ON COLUMN brai_identity_audit.action IS 'Действие';
 COMMENT ON COLUMN brai_identity_audit.occurred_at IS 'Время действия';
 CREATE TABLE IF NOT EXISTS brai_owner_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), user_id text NOT NULL REFERENCES brai_identity(user_id)
 );
 COMMENT ON TABLE brai_owner_bootstrap IS 'Однократная операторская настройка первого владельца';
 COMMENT ON COLUMN brai_owner_bootstrap.singleton IS 'Единственная запись настройки';
 COMMENT ON COLUMN brai_owner_bootstrap.user_id IS 'Идентификатор первого владельца';

 ALTER TABLE brai_identity ADD COLUMN IF NOT EXISTS lifecycle_generation integer NOT NULL DEFAULT 0;
 ALTER TABLE "session" ADD COLUMN IF NOT EXISTS brai_generation integer NOT NULL DEFAULT 0;
 COMMENT ON COLUMN "session".brai_generation IS 'Поколение доступа Auth при входе; старые сессии не восстанавливаются после revoke';
 COMMENT ON COLUMN brai_identity.lifecycle_generation IS 'Монотонное поколение административных заданий пользователя';
 CREATE TABLE IF NOT EXISTS brai_user_operation (
  id text PRIMARY KEY, request_id text NOT NULL UNIQUE, fingerprint text NOT NULL,
  user_id text NOT NULL REFERENCES brai_identity(user_id) ON DELETE CASCADE,
  generation integer NOT NULL, kind text NOT NULL CHECK(kind IN ('prepare','stop')),
  state text NOT NULL CHECK(state IN ('pending','running','succeeded','failed','cancelled')),
  activate_on_success boolean NOT NULL, error_code text, worker_id text, lease_token text, lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,generation)
 );
 CREATE INDEX IF NOT EXISTS brai_user_operation_queue ON brai_user_operation(created_at,id) WHERE state IN ('pending','running');
 COMMENT ON TABLE brai_user_operation IS 'Долговечные административные задания окружений Auth; повтор запроса не возобновляет доступ';
 COMMENT ON COLUMN brai_user_operation.id IS 'UUID операции';
 COMMENT ON COLUMN brai_user_operation.request_id IS 'Стабильный ID запроса клиента';
 COMMENT ON COLUMN brai_user_operation.fingerprint IS 'Хеш инициатора и параметров запроса';
 COMMENT ON COLUMN brai_user_operation.user_id IS 'Пользователь Auth';
 COMMENT ON COLUMN brai_user_operation.generation IS 'Поколение изменения пользователя';
 COMMENT ON COLUMN brai_user_operation.kind IS 'Подготовка либо остановка окружения';
 COMMENT ON COLUMN brai_user_operation.state IS 'Состояние задания; failed требует нового запроса';
 COMMENT ON COLUMN brai_user_operation.activate_on_success IS 'Активировать после подготовки; false сохраняет provisioning';
 COMMENT ON COLUMN brai_user_operation.error_code IS 'Безопасный код ошибки без вывода исполнителя';
 COMMENT ON COLUMN brai_user_operation.worker_id IS 'Идентификатор взявшего задание исполнителя';
 COMMENT ON COLUMN brai_user_operation.lease_token IS 'Секрет владения текущей арендой';
 COMMENT ON COLUMN brai_user_operation.lease_expires_at IS 'Срок аренды; истечение разрешает повтор';
 COMMENT ON COLUMN brai_user_operation.created_at IS 'Время создания задания';
 COMMENT ON COLUMN brai_user_operation.updated_at IS 'Время изменения задания';
 CREATE SCHEMA IF NOT EXISTS auth_identity_owner;
 REVOKE ALL ON SCHEMA auth_identity_owner FROM PUBLIC;
 CREATE TABLE IF NOT EXISTS auth_identity_owner.revocation (
  request_id text PRIMARY KEY, sessions_revoked integer NOT NULL, verifications_revoked integer NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now(), restored_at timestamptz
 );
 ALTER TABLE auth_identity_owner.revocation ADD COLUMN IF NOT EXISTS restored_at timestamptz;
 COMMENT ON TABLE auth_identity_owner.revocation IS 'Идемпотентная операторская граница отзыва прежних сессий';
 COMMENT ON COLUMN auth_identity_owner.revocation.request_id IS 'Идентификатор операции';
 COMMENT ON COLUMN auth_identity_owner.revocation.sessions_revoked IS 'Число отозванных сессий';
 COMMENT ON COLUMN auth_identity_owner.revocation.verifications_revoked IS 'Число отозванных подтверждений';
 COMMENT ON COLUMN auth_identity_owner.revocation.revoked_at IS 'Время транзакции отзыва';
 COMMENT ON COLUMN auth_identity_owner.revocation.restored_at IS 'Время контролируемого восстановления до открытия';
 CREATE TABLE IF NOT EXISTS auth_identity_owner.snapshot (
  request_id text NOT NULL, table_name text NOT NULL CHECK (table_name IN ('session','verification')),
  row_data jsonb NOT NULL
 );
 COMMENT ON TABLE auth_identity_owner.snapshot IS 'Owner-only снимок секретных строк для контролируемого rollback до открытия';
 COMMENT ON COLUMN auth_identity_owner.snapshot.request_id IS 'Идентификатор операции';
 COMMENT ON COLUMN auth_identity_owner.snapshot.table_name IS 'Исходная таблица Better Auth';
 COMMENT ON COLUMN auth_identity_owner.snapshot.row_data IS 'Исходная строка с секретными данными';`);
}
