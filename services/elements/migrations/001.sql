-- ABOUTME: Создаёт собственную структуру Elements, Moves, попыток и outbox.
-- ABOUTME: Runtime не выполняет DDL; миграция запускается владельцем БД отдельно.
CREATE SCHEMA IF NOT EXISTS elements;
CREATE TABLE IF NOT EXISTS elements.migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS elements.elements(
 id uuid PRIMARY KEY,
 owner_id text NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 255),
 kind text NOT NULL CHECK(kind IN ('level','mission','quest','goal','task')),
 parent_id uuid REFERENCES elements.elements(id),
 status text NOT NULL CHECK(status IN ('draft','active','completed')),
 current_revision_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS elements.element_revisions(
 id uuid PRIMARY KEY,
 element_id uuid NOT NULL REFERENCES elements.elements(id),
 revision integer NOT NULL CHECK(revision>0),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 256),
 description text NOT NULL CHECK(length(description)<=8192),
 result_spec jsonb NOT NULL CHECK(jsonb_typeof(result_spec)='object'),
 created_by text NOT NULL CHECK(length(created_by) BETWEEN 1 AND 255),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(element_id,revision)
);
DO $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='elements_current_revision_fk') THEN
  ALTER TABLE elements.elements ADD CONSTRAINT elements_current_revision_fk FOREIGN KEY(current_revision_id) REFERENCES elements.element_revisions(id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS elements.moves(
 id uuid PRIMARY KEY,
 owner_id text NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 255),
 kind text NOT NULL CHECK(kind IN ('action','operation')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 256),
 instructions text NOT NULL CHECK(length(instructions)<=8192),
 result_schema jsonb NOT NULL CHECK(jsonb_typeof(result_schema)='object'),
 status text NOT NULL CHECK(status IN ('planned','claimed','succeeded')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS elements.move_element_links(
 move_id uuid NOT NULL REFERENCES elements.moves(id),
 element_id uuid NOT NULL REFERENCES elements.elements(id),
 revision_id uuid NOT NULL REFERENCES elements.element_revisions(id),
 role text NOT NULL CHECK(role IN ('launch','input','output','accept')),
 required boolean NOT NULL DEFAULT true,
 position integer NOT NULL DEFAULT 0 CHECK(position>=0),
 PRIMARY KEY(move_id,element_id,role)
);
CREATE TABLE IF NOT EXISTS elements.move_attempts(
 id uuid PRIMARY KEY,
 owner_id text NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 255),
 move_id uuid NOT NULL REFERENCES elements.moves(id),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 255),
 executor_kind text NOT NULL CHECK(executor_kind IN ('human','agent','system')),
 executor_id text CHECK(executor_id IS NULL OR length(executor_id) BETWEEN 1 AND 255),
 status text NOT NULL CHECK(status IN ('running','succeeded','failed')),
 input jsonb NOT NULL CHECK(jsonb_typeof(input)='object'),
 result jsonb,
 error_code text CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 UNIQUE(owner_id,move_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS elements.outbox(
 id uuid PRIMARY KEY,
 event_type text NOT NULL CHECK(event_type~'^[a-z][a-z0-9_.]{1,95}$'),
 subject text NOT NULL,
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS elements_parent_order ON elements.elements(owner_id,parent_id,created_at,id);
CREATE INDEX IF NOT EXISTS elements_links_element ON elements.move_element_links(element_id,role,position);
CREATE INDEX IF NOT EXISTS elements_attempts_move_status ON elements.move_attempts(owner_id,move_id,status,started_at DESC);
CREATE INDEX IF NOT EXISTS elements_outbox_pending ON elements.outbox(published_at,next_attempt_at,created_at);
COMMENT ON SCHEMA elements IS 'Собственная БД графа Elements и Moves; не читает чужие базы';
COMMENT ON TABLE elements.elements IS 'Текущая иерархия Level, Mission, Quest, Goal и Task';
COMMENT ON TABLE elements.element_revisions IS 'Неизменяемые версии описаний Elements';
COMMENT ON TABLE elements.moves IS 'Планы Action и Operation с контрактом результата';
COMMENT ON TABLE elements.move_element_links IS 'Типизированные связи Moves с конкретными ревизиями Elements';
COMMENT ON TABLE elements.move_attempts IS 'Идемпотентные попытки выполнения Moves';
COMMENT ON TABLE elements.outbox IS 'Транзакционные события до PubAck JetStream';
INSERT INTO elements.migrations(version) VALUES(1) ON CONFLICT(version) DO NOTHING;
