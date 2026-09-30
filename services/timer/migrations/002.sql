-- ABOUTME: Создаёт личные таймеры после отдельной очистки анонимных прикладных данных.
-- ABOUTME: Сохраняет журнал миграций и отказывается удалять непустые данные v1.
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM timer.intervals) OR EXISTS (SELECT 1 FROM timer.commands)
    OR EXISTS (SELECT 1 FROM timer.state WHERE active_timer_id IS NOT NULL OR version <> 0) THEN
  RAISE EXCEPTION 'TIMER_V1_DATA_REQUIRES_EXPLICIT_RESET';
 END IF;
END $$;
DROP TABLE timer.state;
DROP TABLE timer.commands;
DROP TABLE timer.intervals;
CREATE TABLE timer.intervals (
 user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
 timer_id uuid NOT NULL,
 started_at timestamptz NOT NULL,
 stopped_at timestamptz,
 duration_ms bigint,
 PRIMARY KEY(user_id,timer_id),
 CHECK ((stopped_at IS NULL AND duration_ms IS NULL) OR
        (stopped_at IS NOT NULL AND duration_ms IS NOT NULL AND stopped_at>=started_at AND duration_ms>=0))
);
CREATE UNIQUE INDEX one_active_interval ON timer.intervals(user_id) WHERE stopped_at IS NULL;
CREATE INDEX completed_order ON timer.intervals(user_id,started_at DESC,timer_id DESC) WHERE stopped_at IS NOT NULL;
CREATE TABLE timer.state (
 user_id text PRIMARY KEY CHECK (length(user_id) BETWEEN 1 AND 128),
 version bigint NOT NULL DEFAULT 0 CHECK(version>=0 AND version<=9007199254740991),
 active_timer_id uuid,
 FOREIGN KEY(user_id,active_timer_id) REFERENCES timer.intervals(user_id,timer_id)
);
CREATE TABLE timer.commands (
 user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
 delivery_key text NOT NULL,
 command_id uuid,
 subject text NOT NULL,
 content text,
 event_subject text NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(user_id,delivery_key),
 UNIQUE(user_id,command_id),
 CHECK(result->>'userId'=user_id)
);
INSERT INTO timer.migrations(version) VALUES(2);
