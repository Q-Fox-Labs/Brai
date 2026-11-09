-- ABOUTME: Ограничивает live-данные владельцем аутентифицированного подключения.
-- ABOUTME: Привязки изменяет оператор; исходная история не переписывается.
CREATE SCHEMA IF NOT EXISTS dialogues_access;
REVOKE ALL ON SCHEMA dialogues_access FROM PUBLIC;
CREATE TABLE IF NOT EXISTS dialogues_access.sys_owner_bindings (
 login_role name PRIMARY KEY,
 user_id text NOT NULL UNIQUE CHECK (length(user_id)>0),
 owner_id text NOT NULL UNIQUE CHECK (length(owner_id)>0),
 profile_id text NOT NULL CHECK (length(profile_id)>0),
 enabled boolean NOT NULL DEFAULT true
);
REVOKE ALL ON dialogues_access.sys_owner_bindings FROM PUBLIC;
COMMENT ON TABLE dialogues_access.sys_owner_bindings IS 'Закрытая привязка логина к аккаунту и области Диалогов';
COMMENT ON COLUMN dialogues_access.sys_owner_bindings.login_role IS 'Персональный логин PostgreSQL';
COMMENT ON COLUMN dialogues_access.sys_owner_bindings.user_id IS 'Постоянный аккаунт Auth';
COMMENT ON COLUMN dialogues_access.sys_owner_bindings.owner_id IS 'Ключ области без переписывания истории';
COMMENT ON COLUMN dialogues_access.sys_owner_bindings.profile_id IS 'Текущий профиль Auth';
COMMENT ON COLUMN dialogues_access.sys_owner_bindings.enabled IS 'Допуск к данным';
CREATE OR REPLACE FUNCTION dialogues_access.current_binding()
RETURNS TABLE(user_id text,owner_id text,profile_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT b.user_id,b.owner_id,b.profile_id FROM dialogues_access.sys_owner_bindings b
 WHERE b.login_role=session_user AND b.enabled
$function$;
REVOKE ALL ON FUNCTION dialogues_access.current_binding() FROM PUBLIC;
DO $policies$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY[
  'dialogues','turns','messages','message_summaries','dialogue_summaries','requests',
  'context_consumers','context_deliveries','summary_jobs','turn_results',
  'exchange_events','message_backfill'
 ] LOOP
  EXECUTE format('ALTER TABLE dialogues_live.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE dialogues_live.%I FORCE ROW LEVEL SECURITY',relation);
  -- AIDEV-NOTE: RESTRICTIVE сохраняет границу при добавлении разрешающих политик.
  EXECUTE format('DROP POLICY IF EXISTS personal_owner ON dialogues_live.%I',relation);
  EXECUTE format(
   'CREATE POLICY personal_owner ON dialogues_live.%I AS RESTRICTIVE FOR ALL TO PUBLIC '
   'USING (owner_id=(SELECT b.owner_id FROM dialogues_access.current_binding() b)) '
   'WITH CHECK (owner_id=(SELECT b.owner_id FROM dialogues_access.current_binding() b))',relation);
  EXECUTE format('DROP POLICY IF EXISTS personal_access ON dialogues_live.%I',relation);
  EXECUTE format('CREATE POLICY personal_access ON dialogues_live.%I FOR ALL TO PUBLIC USING (true) WITH CHECK (true)',relation);
 END LOOP;
END $policies$;
INSERT INTO dialogues_live.migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
