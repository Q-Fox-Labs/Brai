-- ABOUTME: Добавляет очередь изменений и отметки о проверенных входах для тем.
-- ABOUTME: Сохранённые карточки и членство остаются доступны при обновлении и откате.
ALTER TABLE dialogues_live.topics ADD COLUMN IF NOT EXISTS dirty_seq bigint DEFAULT 0;
ALTER TABLE dialogues_live.topic_members ADD COLUMN IF NOT EXISTS checked_evidence text;
ALTER TABLE dialogues_live.topic_members ADD COLUMN IF NOT EXISTS evidence_seq bigint NOT NULL DEFAULT -1;
ALTER TABLE dialogues_live.topic_members ALTER COLUMN evidence_seq SET DEFAULT 0;

-- AIDEV-NOTE: Метка записывается вместе с изменением, поэтому входы после ACK и после рестарта не теряются.
CREATE INDEX IF NOT EXISTS topics_dirty ON dialogues_live.topics(owner_id,dirty_seq,id)
 WHERE dirty_seq IS NOT NULL AND merged_into IS NULL;
CREATE OR REPLACE FUNCTION dialogues_live.mark_topic_dirty()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $mark$
BEGIN
 -- AIDEV-NOTE: Политики тем продолжают сверять session_user при записи из старого runtime.
 IF to_regprocedure('dialogues_access.current_binding()') IS NOT NULL THEN
  IF NEW.owner_id IS DISTINCT FROM (SELECT b.owner_id FROM dialogues_access.current_binding() b) THEN RETURN NEW; END IF;
 END IF;
 UPDATE dialogues_live.topics t SET dirty_seq=NEW.change_seq
 FROM dialogues_live.topic_members tm
 WHERE tm.owner_id=NEW.owner_id AND tm.dialogue_id=NEW.dialogue_id
  AND t.owner_id=tm.owner_id AND t.id=tm.topic_id;
 IF TG_TABLE_NAME='messages' THEN
  IF NEW.kind='input' THEN
   UPDATE dialogues_live.topic_members SET evidence_seq=NEW.change_seq
   WHERE owner_id=NEW.owner_id AND dialogue_id=NEW.dialogue_id;
  END IF;
 END IF;
 RETURN NEW;
END $mark$;
REVOKE ALL ON FUNCTION dialogues_live.mark_topic_dirty() FROM PUBLIC;

DROP TRIGGER IF EXISTS topics_message_changed ON dialogues_live.messages;
CREATE TRIGGER topics_message_changed AFTER INSERT ON dialogues_live.messages
 FOR EACH ROW WHEN (NEW.kind IN ('input','final')) EXECUTE FUNCTION dialogues_live.mark_topic_dirty();
DROP TRIGGER IF EXISTS topics_message_summary_changed ON dialogues_live.message_summaries;
CREATE TRIGGER topics_message_summary_changed AFTER INSERT ON dialogues_live.message_summaries
 FOR EACH ROW EXECUTE FUNCTION dialogues_live.mark_topic_dirty();
DROP TRIGGER IF EXISTS topics_dialogue_summary_changed ON dialogues_live.dialogue_summaries;
CREATE TRIGGER topics_dialogue_summary_changed AFTER INSERT ON dialogues_live.dialogue_summaries
 FOR EACH ROW EXECUTE FUNCTION dialogues_live.mark_topic_dirty();
DROP TRIGGER IF EXISTS topics_final_changed ON dialogues_live.turns;
CREATE TRIGGER topics_final_changed AFTER UPDATE OF final_message_id,completion_seq ON dialogues_live.turns
 FOR EACH ROW WHEN (OLD.final_message_id IS DISTINCT FROM NEW.final_message_id
  OR OLD.completion_seq IS DISTINCT FROM NEW.completion_seq) EXECUTE FUNCTION dialogues_live.mark_topic_dirty();

INSERT INTO dialogues_live.migrations(version) VALUES(8) ON CONFLICT DO NOTHING;
