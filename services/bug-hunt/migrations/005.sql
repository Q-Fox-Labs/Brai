-- ABOUTME: Добавляет журнал расследований v3 без изменения исходных наблюдений v1/v2.
-- ABOUTME: Квитанции, snapshots, evidence и результаты сохраняются для replay и восстановления.
CREATE TABLE IF NOT EXISTS verification_run(
 id uuid PRIMARY KEY,installation_id text NOT NULL,owner_id text NOT NULL,
 trigger_kind text NOT NULL CHECK(trigger_kind IN('manual','timer')),
 selected integer NOT NULL DEFAULT 0,outcome text NOT NULL DEFAULT 'queued',
 registered_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS verification_schedule(
 installation_id text PRIMARY KEY,revision text NOT NULL,next_due_at timestamptz NOT NULL,
 last_tick_id uuid,last_outcome text NOT NULL DEFAULT 'not_due',last_selected integer NOT NULL DEFAULT 0,
 paused boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS verification_investigation(
 id uuid PRIMARY KEY,installation_id text NOT NULL,owner_id text NOT NULL,run_id uuid NOT NULL REFERENCES verification_run(id),
 revision integer NOT NULL,fingerprint text NOT NULL,snapshot jsonb NOT NULL,snapshot_hash text NOT NULL,
 policy jsonb NOT NULL,config_hash text NOT NULL,executor text NOT NULL CHECK(executor IN('codex_app_server','providers')),
 model jsonb,state text NOT NULL DEFAULT 'queued',stage text NOT NULL DEFAULT 'investigate',
 fence bigint NOT NULL DEFAULT 0,cancel_requested boolean NOT NULL DEFAULT false,code text,
 workflow_id text NOT NULL UNIQUE,workflow_state text NOT NULL DEFAULT 'pending',
 current_result_id uuid,manual_revision integer NOT NULL DEFAULT 0,
 registered_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deadline_at timestamptz,active_ms bigint NOT NULL DEFAULT 0,
 UNIQUE(installation_id,owner_id,fingerprint),UNIQUE(id,installation_id,owner_id)
);
ALTER TABLE verification_investigation ADD COLUMN IF NOT EXISTS active_ms bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS verification_pending ON verification_investigation(installation_id,state,registered_at,id);
CREATE TABLE IF NOT EXISTS verification_mutation(
 installation_id text NOT NULL,owner_id text NOT NULL,actor_id text NOT NULL,operation text NOT NULL,
 request_id text NOT NULL,input_hash text NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(installation_id,owner_id,actor_id,operation,request_id)
);
CREATE TABLE IF NOT EXISTS verification_effect(
 id uuid PRIMARY KEY,investigation_id uuid NOT NULL,installation_id text NOT NULL,owner_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN('model','runner','tool')),step_key text NOT NULL,
 input_hash text NOT NULL,intent jsonb NOT NULL,checkpoint jsonb NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(investigation_id,installation_id,owner_id) REFERENCES verification_investigation(id,installation_id,owner_id),
 UNIQUE(investigation_id,kind,step_key)
);
CREATE TABLE IF NOT EXISTS verification_evidence(
 id uuid PRIMARY KEY,investigation_id uuid NOT NULL,installation_id text NOT NULL,owner_id text NOT NULL,
 kind text NOT NULL,sha256 text NOT NULL,payload jsonb NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(investigation_id,installation_id,owner_id) REFERENCES verification_investigation(id,installation_id,owner_id)
);
CREATE TABLE IF NOT EXISTS verification_result(
 id uuid PRIMARY KEY,investigation_id uuid NOT NULL,installation_id text NOT NULL,owner_id text NOT NULL,
 revision integer NOT NULL,payload jsonb NOT NULL,validator_receipt jsonb NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(investigation_id,installation_id,owner_id) REFERENCES verification_investigation(id,installation_id,owner_id),
 UNIQUE(investigation_id,revision)
);
CREATE TABLE IF NOT EXISTS verification_review(
 id uuid PRIMARY KEY,investigation_id uuid NOT NULL,installation_id text NOT NULL,owner_id text NOT NULL,
 actor_id text NOT NULL,revision integer NOT NULL,verdict text NOT NULL,explanation text NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(investigation_id,installation_id,owner_id) REFERENCES verification_investigation(id,installation_id,owner_id),
 UNIQUE(investigation_id,revision)
);
CREATE TABLE IF NOT EXISTS verification_budget(
 installation_id text NOT NULL,owner_id text NOT NULL,day date NOT NULL,
 calls integer NOT NULL DEFAULT 0,tokens bigint NOT NULL DEFAULT 0,tool_calls integer NOT NULL DEFAULT 0,
 runner_runs integer NOT NULL DEFAULT 0,PRIMARY KEY(installation_id,owner_id,day)
);
INSERT INTO sys_capability(capability,version) VALUES('verification',3) ON CONFLICT DO NOTHING;
COMMENT ON TABLE verification_run IS 'Квитанции ограниченных ручных и плановых порций';
COMMENT ON TABLE verification_schedule IS 'Расписание, пауза и последний шестичасовой tick без модели';
COMMENT ON TABLE verification_investigation IS 'Закреплённые snapshots, исполнитель и registry workflow v3';
COMMENT ON TABLE verification_mutation IS 'Неизменяемые квитанции мутаций v3';
COMMENT ON TABLE verification_effect IS 'Сохранённые intents и checkpoints внешних эффектов';
COMMENT ON TABLE verification_evidence IS 'Неизменяемые ограниченные свидетельства с provenance';
COMMENT ON TABLE verification_result IS 'Неизменяемые выводы с квитанцией серверного валидатора';
COMMENT ON TABLE verification_review IS 'Ручные поправки, имеющие приоритет перед поздним автоматом';
COMMENT ON TABLE verification_budget IS 'Резервы возможного расхода по владельцу и суткам UTC';
DO $comments$
DECLARE r record;
BEGIN
 FOR r IN SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'verification_%'
 LOOP EXECUTE format('COMMENT ON COLUMN %I.%I IS %L',r.table_name,r.column_name,'Поле '||r.column_name||' объекта '||r.table_name); END LOOP;
END $comments$;
