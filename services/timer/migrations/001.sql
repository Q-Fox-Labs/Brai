-- ABOUTME: Создаёт закрытое хранилище одного таймера и журнал результатов.
-- ABOUTME: Выполняется владельцем БД; runtime права выдаёт отдельный мигратор.
CREATE SCHEMA IF NOT EXISTS timer;
REVOKE ALL ON SCHEMA timer FROM PUBLIC;
CREATE TABLE IF NOT EXISTS timer.intervals (
 timer_id uuid PRIMARY KEY,
 started_at timestamptz NOT NULL,
 stopped_at timestamptz,
 duration_ms bigint,
 CHECK ((stopped_at IS NULL AND duration_ms IS NULL) OR
        (stopped_at IS NOT NULL AND duration_ms IS NOT NULL AND stopped_at>=started_at AND duration_ms>=0))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_interval ON timer.intervals ((true)) WHERE stopped_at IS NULL;
CREATE INDEX IF NOT EXISTS completed_order ON timer.intervals (started_at DESC,timer_id DESC) WHERE stopped_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS timer.state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 version bigint NOT NULL DEFAULT 0 CHECK (version>=0 AND version<=9007199254740991),
 active_timer_id uuid REFERENCES timer.intervals(timer_id)
);
INSERT INTO timer.state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS timer.commands (
 delivery_key text PRIMARY KEY,
 command_id uuid UNIQUE,
 subject text NOT NULL,
 content text,
 event_subject text NOT NULL,
 result jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS timer.migrations (version integer PRIMARY KEY);
INSERT INTO timer.migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
