-- ABOUTME: Добавляет независимую границу обмена и краткий журнал операций.
-- ABOUTME: Не копирует тексты контекста и не изменяет оригиналы.
ALTER TABLE dialogues_live.context_consumers
 ADD COLUMN IF NOT EXISTS protocol_version integer NOT NULL DEFAULT 2;
CREATE TABLE IF NOT EXISTS dialogues_live.exchange_events(
 owner_id text NOT NULL,event_id text NOT NULL,event_type text NOT NULL,
 dialogue_id text,turn_id text,delivery_id text,through_seq bigint,
 result_ids jsonb NOT NULL DEFAULT '[]'::jsonb,occurred_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,event_id)
);
CREATE TABLE IF NOT EXISTS dialogues_live.message_backfill(
 owner_id text NOT NULL,dialogue_id text NOT NULL,message_id text NOT NULL,source_hash text NOT NULL,
 next_offset integer NOT NULL DEFAULT 0,working_summary text,execution jsonb NOT NULL DEFAULT '{}'::jsonb,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','done')),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,dialogue_id,message_id)
);
COMMENT ON TABLE dialogues_live.message_backfill IS 'Возобновляемая подготовка саммари исторических сообщений';
COMMENT ON COLUMN dialogues_live.message_backfill.owner_id IS 'Владелец сообщения';
COMMENT ON COLUMN dialogues_live.message_backfill.dialogue_id IS 'Беседа сообщения';
COMMENT ON COLUMN dialogues_live.message_backfill.message_id IS 'ID сообщения';
COMMENT ON COLUMN dialogues_live.message_backfill.source_hash IS 'Хеш исходного сообщения';
COMMENT ON COLUMN dialogues_live.message_backfill.next_offset IS 'Следующее смещение в Unicode';
COMMENT ON COLUMN dialogues_live.message_backfill.working_summary IS 'Промежуточное саммари';
COMMENT ON COLUMN dialogues_live.message_backfill.execution IS 'Состояние текущего запроса';
COMMENT ON COLUMN dialogues_live.message_backfill.state IS 'Состояние обработки';
COMMENT ON COLUMN dialogues_live.message_backfill.updated_at IS 'Время изменения';
COMMENT ON TABLE dialogues_live.exchange_events IS 'Факты операций и выдач без текстов переписки и контекста';
COMMENT ON COLUMN dialogues_live.context_consumers.protocol_version IS 'Версия протокола подтверждённой границы';
DO $comments$
DECLARE c record;
BEGIN
 FOR c IN SELECT column_name FROM information_schema.columns
 WHERE table_schema='dialogues_live' AND table_name='exchange_events' LOOP
 EXECUTE format('COMMENT ON COLUMN dialogues_live.exchange_events.%I IS %L',c.column_name,'Поле журнала обмена: '||c.column_name);
 END LOOP;
END $comments$;
INSERT INTO dialogues_live.migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
