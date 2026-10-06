-- ABOUTME: Добавляет исправление и мягкое удаление завершённых сессий.
-- ABOUTME: Исходные факты истории записываются один раз и не меняются runtime ролью.
ALTER TABLE timer.state
 ADD COLUMN history_revision bigint NOT NULL DEFAULT 0
 CHECK (history_revision>=0 AND history_revision<=9007199254740991);
COMMENT ON COLUMN timer.state.history_revision IS 'Ревизия истории владельца; увеличивается только после успешного исправления или удаления.';

ALTER TABLE timer.intervals ADD COLUMN deleted_at timestamptz;
COMMENT ON COLUMN timer.intervals.deleted_at IS 'Время мягкого удаления завершённого интервала; удалённые строки скрыты из чтения истории.';

CREATE TABLE timer.interval_facts (
 user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
 timer_id uuid NOT NULL,
 original_started_at timestamptz NOT NULL,
 original_stopped_at timestamptz NOT NULL,
 original_duration_ms bigint NOT NULL CHECK (original_duration_ms>=0),
 PRIMARY KEY(user_id,timer_id),
 CHECK (original_stopped_at>=original_started_at)
);
COMMENT ON TABLE timer.interval_facts IS 'Неизменяемый исходный факт каждого завершённого интервала.';
COMMENT ON COLUMN timer.interval_facts.user_id IS 'Владелец интервала.';
COMMENT ON COLUMN timer.interval_facts.timer_id IS 'Идентификатор исходного таймера.';
COMMENT ON COLUMN timer.interval_facts.original_started_at IS 'Начало интервала до исправлений.';
COMMENT ON COLUMN timer.interval_facts.original_stopped_at IS 'Окончание интервала до исправлений.';
COMMENT ON COLUMN timer.interval_facts.original_duration_ms IS 'Исходная длительность в целых миллисекундах.';

INSERT INTO timer.interval_facts(user_id,timer_id,original_started_at,original_stopped_at,original_duration_ms)
 SELECT user_id,timer_id,started_at,stopped_at,duration_ms
 FROM timer.intervals WHERE stopped_at IS NOT NULL
 ON CONFLICT (user_id,timer_id) DO NOTHING;

INSERT INTO timer.migrations(version) VALUES(3);
