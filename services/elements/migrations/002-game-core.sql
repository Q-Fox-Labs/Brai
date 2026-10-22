-- ABOUTME: Хранит канонические записи game-core в существующей БД Elements.
-- ABOUTME: Порядок исполнения задают UUID предшественников; исторические даты могут отсутствовать.
CREATE SCHEMA IF NOT EXISTS game_core;
CREATE TABLE IF NOT EXISTS game_core.elements (
 id uuid PRIMARY KEY, owner_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('level','mission','quest','goal','task')),
 parent_id uuid, current_revision_id uuid, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','completed','cancelled')),
 outcome text, provenance jsonb NOT NULL DEFAULT '{}', UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,parent_id) REFERENCES game_core.elements(owner_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS game_core.element_revisions (
 id uuid PRIMARY KEY, owner_id text NOT NULL, element_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
 title text NOT NULL CHECK(length(trim(title))>0), description text NOT NULL DEFAULT '', fields jsonb NOT NULL DEFAULT '{}',
 created_by_attempt_id uuid, recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,id), UNIQUE(element_id,revision),
 FOREIGN KEY(owner_id,element_id) REFERENCES game_core.elements(owner_id,id) DEFERRABLE INITIALLY DEFERRED
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='game_core_current_revision') THEN
 ALTER TABLE game_core.elements ADD CONSTRAINT game_core_current_revision FOREIGN KEY(owner_id,current_revision_id) REFERENCES game_core.element_revisions(owner_id,id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS game_core.moves (
 id uuid PRIMARY KEY, owner_id text NOT NULL, element_id uuid NOT NULL, target_element_id uuid NOT NULL, previous_move_id uuid,
 kind text NOT NULL CHECK(kind IN ('operation','action')), purpose text NOT NULL DEFAULT 'work', title text NOT NULL CHECK(length(trim(title))>0),
 instructions text NOT NULL DEFAULT '', fields jsonb NOT NULL DEFAULT '{}', conditions jsonb NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','claimed','succeeded','cancelled')), UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,element_id) REFERENCES game_core.elements(owner_id,id),
 FOREIGN KEY(owner_id,target_element_id) REFERENCES game_core.elements(owner_id,id),
 FOREIGN KEY(owner_id,previous_move_id) REFERENCES game_core.moves(owner_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(previous_move_id IS DISTINCT FROM id)
);
CREATE TABLE IF NOT EXISTS game_core.move_attempts (
 id uuid PRIMARY KEY, owner_id text NOT NULL, move_id uuid NOT NULL, executor_kind text NOT NULL CHECK(executor_kind IN ('human','agent','system')),
 executor_id text, idempotency_key text NOT NULL CHECK(length(idempotency_key)>0), status text NOT NULL CHECK(status IN ('running','succeeded','failed')),
 result jsonb, error_code text, started_at timestamptz, finished_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,id), UNIQUE(owner_id,move_id,idempotency_key),
 FOREIGN KEY(owner_id,move_id) REFERENCES game_core.moves(owner_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS game_core_running_move ON game_core.move_attempts(move_id) WHERE status='running';
CREATE TABLE IF NOT EXISTS game_core.resources (
 id uuid PRIMARY KEY, owner_id text NOT NULL, created_by_attempt_id uuid, title text NOT NULL CHECK(length(trim(title))>0), content text NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}', artifact_ids uuid[] NOT NULL DEFAULT '{}', UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,created_by_attempt_id) REFERENCES game_core.move_attempts(owner_id,id)
);
CREATE TABLE IF NOT EXISTS game_core.attempt_resources (
 owner_id text NOT NULL, attempt_id uuid NOT NULL, resource_id uuid NOT NULL, PRIMARY KEY(attempt_id,resource_id),
 FOREIGN KEY(owner_id,attempt_id) REFERENCES game_core.move_attempts(owner_id,id),
 FOREIGN KEY(owner_id,resource_id) REFERENCES game_core.resources(owner_id,id)
);
CREATE TABLE IF NOT EXISTS game_core.element_resources (
 owner_id text NOT NULL, element_id uuid NOT NULL, resource_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('input','output')),
 PRIMARY KEY(element_id,resource_id,role), FOREIGN KEY(owner_id,element_id) REFERENCES game_core.elements(owner_id,id),
 FOREIGN KEY(owner_id,resource_id) REFERENCES game_core.resources(owner_id,id)
);
CREATE TABLE IF NOT EXISTS game_core.outbox (
 id uuid PRIMARY KEY, owner_id text NOT NULL, event_type text NOT NULL, subject text NOT NULL, payload jsonb NOT NULL,
 published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t record; c record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='game_core' LOOP
 EXECUTE format('COMMENT ON TABLE game_core.%I IS %L',t.tablename,'game-core: '||t.tablename||'; канонические записи одного владельца');
 FOR c IN SELECT column_name FROM information_schema.columns WHERE table_schema='game_core' AND table_name=t.tablename LOOP
 EXECUTE format('COMMENT ON COLUMN game_core.%I.%I IS %L',t.tablename,c.column_name,'game-core: '||c.column_name);
 END LOOP; END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS game_core_revision_element ON game_core.element_revisions(owner_id,id,element_id);
ALTER TABLE game_core.elements DROP CONSTRAINT IF EXISTS game_core_current_revision;
ALTER TABLE game_core.elements ADD CONSTRAINT game_core_current_revision FOREIGN KEY(owner_id,current_revision_id,id) REFERENCES game_core.element_revisions(owner_id,id,element_id) DEFERRABLE INITIALLY DEFERRED;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='game_core_revision_attempt') THEN
 ALTER TABLE game_core.element_revisions ADD CONSTRAINT game_core_revision_attempt FOREIGN KEY(owner_id,created_by_attempt_id) REFERENCES game_core.move_attempts(owner_id,id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
