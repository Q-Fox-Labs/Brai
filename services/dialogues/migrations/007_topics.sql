-- ABOUTME: Добавляет темы, их версии и курсоры компактного контекста.
-- ABOUTME: Исходные диалоги, сообщения и старые выдачи сохраняются.
CREATE TABLE IF NOT EXISTS dialogues_live.topics (
 owner_id text NOT NULL, id text NOT NULL, title text, home_dialogue_id text, merged_into text, membership_version bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(owner_id,id),
 FOREIGN KEY(owner_id,home_dialogue_id) REFERENCES dialogues_live.dialogues(owner_id,id),
 FOREIGN KEY(owner_id,merged_into) REFERENCES dialogues_live.topics(owner_id,id),
 CHECK (id IS DISTINCT FROM merged_into)
);
CREATE TABLE IF NOT EXISTS dialogues_live.topic_members (
 owner_id text NOT NULL, dialogue_id text NOT NULL, topic_id text NOT NULL,
 checked_at bigint, manually_assigned boolean NOT NULL DEFAULT false,
 PRIMARY KEY(owner_id,dialogue_id),
 FOREIGN KEY(owner_id,dialogue_id) REFERENCES dialogues_live.dialogues(owner_id,id),
 FOREIGN KEY(owner_id,topic_id) REFERENCES dialogues_live.topics(owner_id,id)
);
CREATE INDEX IF NOT EXISTS topic_members_lookup ON dialogues_live.topic_members(owner_id,topic_id,dialogue_id);
CREATE TABLE IF NOT EXISTS dialogues_live.topic_separations (
 owner_id text NOT NULL, dialogue_id text NOT NULL, separated_from text NOT NULL,
 PRIMARY KEY(owner_id,dialogue_id,separated_from),
 FOREIGN KEY(owner_id,dialogue_id) REFERENCES dialogues_live.dialogues(owner_id,id),
 FOREIGN KEY(owner_id,separated_from) REFERENCES dialogues_live.dialogues(owner_id,id),
 CHECK (dialogue_id<>separated_from)
);
CREATE TABLE IF NOT EXISTS dialogues_live.topic_summaries (
 owner_id text NOT NULL, topic_id text NOT NULL, version bigint NOT NULL,
 source_digest text NOT NULL, membership_version bigint NOT NULL, extended text NOT NULL, compact text NOT NULL,
 extended_tokens integer NOT NULL CHECK(extended_tokens BETWEEN 1 AND 400),
 compact_tokens integer NOT NULL CHECK(compact_tokens BETWEEN 1 AND 50),
 source_refs jsonb NOT NULL, change_seq bigint NOT NULL,
 PRIMARY KEY(owner_id,topic_id,version),
 FOREIGN KEY(owner_id,topic_id) REFERENCES dialogues_live.topics(owner_id,id)
);
CREATE TABLE IF NOT EXISTS dialogues_live.message_compact_summaries (
 owner_id text NOT NULL, dialogue_id text NOT NULL, message_id text NOT NULL,
 source_version bigint NOT NULL, text text NOT NULL,
 tokens integer NOT NULL CHECK(tokens BETWEEN 1 AND 200), change_seq bigint NOT NULL,
 PRIMARY KEY(owner_id,dialogue_id,message_id,source_version),
 FOREIGN KEY(owner_id,dialogue_id,message_id) REFERENCES dialogues_live.messages(owner_id,dialogue_id,id)
);
ALTER TABLE dialogues_live.context_consumers ADD COLUMN IF NOT EXISTS topic_view jsonb;
ALTER TABLE dialogues_live.context_deliveries ADD COLUMN IF NOT EXISTS topic_view jsonb;
CREATE INDEX IF NOT EXISTS messages_dialogue_activity ON dialogues_live.messages
 (owner_id,dialogue_id,(COALESCE(occurred_at,recorded_at)) DESC,change_seq DESC) WHERE kind IN ('input','final');
CREATE INDEX IF NOT EXISTS messages_dialogue_search ON dialogues_live.messages USING gin(
 (CASE WHEN octet_length(text)<=65024 THEN to_tsvector('pg_catalog.russian',text) ELSE ''::tsvector END)
) WHERE kind IN ('input','final');
DO $topics_access$
DECLARE relation text;
DECLARE binding record;
BEGIN
 IF to_regclass('dialogues_access.sys_owner_bindings') IS NULL THEN RETURN; END IF;
 FOREACH relation IN ARRAY ARRAY['topics','topic_members','topic_separations','topic_summaries','message_compact_summaries'] LOOP
  EXECUTE format('ALTER TABLE dialogues_live.%I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE dialogues_live.%I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('DROP POLICY IF EXISTS personal_owner ON dialogues_live.%I',relation);
  EXECUTE format(
   'CREATE POLICY personal_owner ON dialogues_live.%I AS RESTRICTIVE FOR ALL TO PUBLIC '
   'USING (owner_id=(SELECT b.owner_id FROM dialogues_access.current_binding() b)) '
   'WITH CHECK (owner_id=(SELECT b.owner_id FROM dialogues_access.current_binding() b))',relation);
  EXECUTE format('DROP POLICY IF EXISTS personal_access ON dialogues_live.%I',relation);
  EXECUTE format('CREATE POLICY personal_access ON dialogues_live.%I FOR ALL TO PUBLIC USING (true) WITH CHECK (true)',relation);
 END LOOP;
 FOR binding IN SELECT login_role FROM dialogues_access.sys_owner_bindings WHERE enabled LOOP
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON dialogues_live.topics,dialogues_live.topic_members TO %I',binding.login_role);
  EXECUTE format('GRANT SELECT,INSERT ON dialogues_live.topic_separations,dialogues_live.topic_summaries,dialogues_live.message_compact_summaries TO %I',binding.login_role);
 END LOOP;
END $topics_access$;
INSERT INTO dialogues_live.migrations(version) VALUES(7) ON CONFLICT DO NOTHING;
