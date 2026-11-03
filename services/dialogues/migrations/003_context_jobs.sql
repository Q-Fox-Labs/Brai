-- ABOUTME: Хранит подтверждённые выдачи контекста и задания свёртки v0.2.
-- ABOUTME: Не изменяет оригиналы, старые саммари или архивный импорт.
CREATE TABLE IF NOT EXISTS dialogues_live.context_consumers(
 owner_id text NOT NULL,consumer_id text NOT NULL,context_instance_id text NOT NULL,
 checkpoint bigint NOT NULL DEFAULT 0,bootstrapped boolean NOT NULL DEFAULT false,
 active_delivery_id text,PRIMARY KEY(owner_id,consumer_id,context_instance_id)
);
CREATE TABLE IF NOT EXISTS dialogues_live.context_deliveries(
 owner_id text NOT NULL,id text NOT NULL,consumer_id text NOT NULL,context_instance_id text NOT NULL,
 request_id text NOT NULL,request_hash text NOT NULL,through_seq bigint NOT NULL,
 pages jsonb NOT NULL,served_pages integer[] NOT NULL DEFAULT '{}',
 state text NOT NULL CHECK(state IN('active','superseded','acked')),
 receipt jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id),
 FOREIGN KEY(owner_id,consumer_id,context_instance_id)
 REFERENCES dialogues_live.context_consumers(owner_id,consumer_id,context_instance_id)
);
CREATE TABLE IF NOT EXISTS dialogues_live.summary_jobs(
 owner_id text NOT NULL,id text NOT NULL,dialogue_id text NOT NULL,
 previous_version bigint,from_order bigint NOT NULL,through_order bigint NOT NULL,
 through_message_id text NOT NULL,boundary_seq bigint NOT NULL,
 state text NOT NULL CHECK(state IN('queued','running','failed','succeeded','stale')),
 attempts integer NOT NULL DEFAULT 0,available_at timestamptz NOT NULL DEFAULT now(),
 lease_id text,lease_until timestamptz,native_thread_id text,native_turn_id text,
 native_launch_id text,execution_state text NOT NULL DEFAULT 'not_started',
 progress jsonb NOT NULL DEFAULT '{}',error_code text,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,id),FOREIGN KEY(owner_id,dialogue_id) REFERENCES dialogues_live.dialogues(owner_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS summary_jobs_active ON dialogues_live.summary_jobs(owner_id,dialogue_id)
 WHERE state IN('queued','running');
CREATE INDEX IF NOT EXISTS summary_jobs_ready ON dialogues_live.summary_jobs(state,available_at);
CREATE INDEX IF NOT EXISTS messages_time ON dialogues_live.messages(owner_id,(COALESCE(occurred_at,recorded_at)),change_seq,message_order);
COMMENT ON TABLE dialogues_live.context_consumers IS 'Подтверждённая граница только свёрток для отдельного контекста потребителя';
COMMENT ON TABLE dialogues_live.context_deliveries IS 'Неизменный пакет страниц, учёт чтения и ACK; тексты не выводятся в журналы';
COMMENT ON TABLE dialogues_live.summary_jobs IS 'Очередь фиксированных диапазонов свёртки, lease и native execution IDs';
DO $comments$
DECLARE c record;
BEGIN
 FOR c IN SELECT table_name,column_name FROM information_schema.columns
 WHERE table_schema='dialogues_live' AND table_name IN('context_consumers','context_deliveries','summary_jobs') LOOP
 EXECUTE format('COMMENT ON COLUMN dialogues_live.%I.%I IS %L',c.table_name,c.column_name,'Служебное поле v0.2: '||c.column_name);
 END LOOP;
END $comments$;
INSERT INTO dialogues_live.migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
