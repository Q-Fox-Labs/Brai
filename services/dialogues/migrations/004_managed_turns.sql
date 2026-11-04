-- ABOUTME: Добавляет управляемые ходы и результаты без изменения истории.
-- ABOUTME: Ограничение одного открытого хода относится только к новой схеме.
ALTER TABLE dialogues_live.context_deliveries ADD COLUMN IF NOT EXISTS request_options jsonb;
COMMENT ON COLUMN dialogues_live.context_deliveries.request_options IS 'Исходные параметры выдачи для безопасного продолжения';
ALTER TABLE dialogues_live.turns ADD COLUMN IF NOT EXISTS managed boolean NOT NULL DEFAULT false;
ALTER TABLE dialogues_live.turns ADD COLUMN IF NOT EXISTS purpose text;
ALTER TABLE dialogues_live.turns ADD COLUMN IF NOT EXISTS constraints_text text;
ALTER TABLE dialogues_live.turns ADD COLUMN IF NOT EXISTS reconciled_through_order bigint;
ALTER TABLE dialogues_live.turns ADD COLUMN IF NOT EXISTS final_message_id text;
ALTER TABLE dialogues_live.turns ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE dialogues_live.turns ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS turns_one_open_managed ON dialogues_live.turns(owner_id,dialogue_id) WHERE managed AND status <> 'completed';
CREATE TABLE IF NOT EXISTS dialogues_live.turn_results(
 owner_id text NOT NULL,dialogue_id text NOT NULL,turn_id text NOT NULL,id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('work','final')),
 formulation text NOT NULL CHECK(length(trim(formulation))>0),
 source_refs text[] NOT NULL DEFAULT '{}',
 status text NOT NULL CHECK(status IN ('pending','done','not_done','cancelled')),
 result text,verification text,reason text,remainder text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,dialogue_id,turn_id,id),
 FOREIGN KEY(owner_id,dialogue_id,turn_id) REFERENCES dialogues_live.turns(owner_id,dialogue_id,id),
 CHECK(kind <> 'final' OR status IN ('pending','done')),
 CHECK(kind <> 'work' OR status <> 'done' OR length(trim(coalesce(result,'')))>0),
 CHECK(status NOT IN ('not_done','cancelled') OR length(trim(coalesce(reason,'')))>0)
);
CREATE UNIQUE INDEX IF NOT EXISTS turn_results_one_final ON dialogues_live.turn_results(owner_id,dialogue_id,turn_id) WHERE kind='final';
COMMENT ON TABLE dialogues_live.turn_results IS 'Ожидаемые и достигнутые результаты управляемого хода';
DO $comments$
DECLARE c record;
BEGIN
 FOR c IN SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='dialogues_live'
 AND (table_name='turn_results' OR (table_name='turns' AND column_name IN ('managed','purpose','constraints_text','reconciled_through_order','final_message_id','version','updated_at'))) LOOP
 EXECUTE format('COMMENT ON COLUMN dialogues_live.%I.%I IS %L',c.table_name,c.column_name,'Поле управляемого хода: '||c.column_name);
 END LOOP;
END $comments$;
INSERT INTO dialogues_live.migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
