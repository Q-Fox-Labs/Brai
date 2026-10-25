-- ABOUTME: Добавляет durable доставку, владение исполнением и очередь контуров без изменения прежних доказательств.
-- ABOUTME: Передача legacy областей выполняется отдельной остановленной Ansible операцией; миграция её не подменяет.
CREATE TABLE codeworks.execution_control (
  project_id text PRIMARY KEY REFERENCES codeworks.projects(id),
  instance_id text NOT NULL CHECK(instance_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  owner text NOT NULL CHECK(owner IN ('legacy','temporal')),
  mutations_paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE codeworks.workflow_registry (
  workflow_id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES codeworks.projects(id),
  workspace_id uuid UNIQUE REFERENCES codeworks.workspaces(id),
  operation_id uuid UNIQUE REFERENCES codeworks.operations(id),
  owner text NOT NULL CHECK(owner IN ('legacy','temporal')),
  generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','draining','completed')),
  lifecycle text NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','removed','cancelled')),
  next_sequence bigint NOT NULL DEFAULT 0,
  position bigint NOT NULL DEFAULT 0,
  executor_state text NOT NULL DEFAULT 'waiting',
  last_stage text,
  blocked_reason text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK((workspace_id IS NULL) <> (operation_id IS NULL))
);
CREATE TABLE codeworks.commands (
  operation_id uuid PRIMARY KEY REFERENCES codeworks.operations(id),
  workflow_id text NOT NULL REFERENCES codeworks.workflow_registry(workflow_id),
  sequence bigint NOT NULL,
  generation bigint NOT NULL,
  kind text NOT NULL,
  admitted_request jsonb NOT NULL,
  requested_sha text,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','reconciliation')),
  delivered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workflow_id,sequence)
);
CREATE INDEX command_delivery ON codeworks.commands(workflow_id,sequence) WHERE delivered_at IS NULL AND state <> 'done';
CREATE TABLE codeworks.release_queue (
  ticket bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id text NOT NULL REFERENCES codeworks.projects(id),
  target text NOT NULL CHECK(target IN ('dev','prod')),
  operation_id uuid NOT NULL REFERENCES codeworks.operations(id),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','held','released','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id,target)
);
CREATE UNIQUE INDEX one_target_holder ON codeworks.release_queue(project_id,target) WHERE state='held';
ALTER TABLE codeworks.deployments ADD COLUMN release_operation_id uuid REFERENCES codeworks.operations(id);
ALTER TABLE codeworks.releases ADD COLUMN retry_of uuid REFERENCES codeworks.operations(id);
ALTER TABLE codeworks.releases ADD COLUMN closed_at timestamptz;
ALTER TABLE codeworks.releases ADD COLUMN close_reason text;
DO $$
DECLARE prior_name text;
BEGIN
  SELECT conname INTO STRICT prior_name FROM pg_constraint
    WHERE conrelid='codeworks.operations'::regclass AND contype='c' AND cardinality(conkey)=2
      AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='codeworks.operations'::regclass AND attname='kind'),(SELECT attnum FROM pg_attribute WHERE attrelid='codeworks.operations'::regclass AND attname='archived')]::smallint[];
  EXECUTE format('ALTER TABLE codeworks.operations DROP CONSTRAINT %I',prior_name);
END $$;
ALTER TABLE codeworks.operations ADD CONSTRAINT operations_kind_admission_check CHECK(archived OR kind IN ('prepare','sync','release','cleanup','rollout','release.close','workspace.cancel'));
-- AIDEV-NOTE: Постоянная очередь заменяет запрет на сам приём второго rollout.
DROP INDEX codeworks.one_active_rollout;
CREATE FUNCTION codeworks.admit_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE control codeworks.execution_control; registry codeworks.workflow_registry; identity text;
BEGIN
  SELECT * INTO control FROM codeworks.execution_control WHERE project_id=NEW.project_id FOR SHARE;
  IF FOUND AND control.mutations_paused THEN RAISE EXCEPTION 'CODEWORKS_MUTATIONS_PAUSED' USING ERRCODE='55P03'; END IF;
  IF control.owner IS NULL OR control.owner='legacy' OR NEW.archived THEN RETURN NEW; END IF;
  identity := 'codeworks/' || control.instance_id || '/' || NEW.project_id || '/' ||
    CASE WHEN NEW.workspace_id IS NULL THEN 'rollout/' || NEW.id::text ELSE 'workspace/' || NEW.workspace_id::text END;
  INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,operation_id,owner)
    VALUES(identity,NEW.project_id,NEW.workspace_id,CASE WHEN NEW.workspace_id IS NULL THEN NEW.id END,'temporal')
    ON CONFLICT(workflow_id) DO NOTHING;
  SELECT * INTO registry FROM codeworks.workflow_registry WHERE workflow_id=identity FOR UPDATE;
  IF registry.state <> 'open' OR registry.lifecycle <> 'active' OR registry.owner <> 'temporal' THEN
    RAISE EXCEPTION 'CODEWORKS_TASK_CLOSED' USING ERRCODE='23505';
  END IF;
  UPDATE codeworks.workflow_registry SET next_sequence=next_sequence+1,updated_at=now() WHERE workflow_id=identity RETURNING * INTO registry;
  INSERT INTO codeworks.commands(operation_id,workflow_id,sequence,generation,kind,admitted_request,requested_sha)
    VALUES(NEW.id,identity,registry.next_sequence,registry.generation,NEW.kind,NEW.request,NEW.request->>'commit_sha');
  RETURN NEW;
END $$;
CREATE TRIGGER admit_command AFTER INSERT ON codeworks.operations FOR EACH ROW EXECUTE FUNCTION codeworks.admit_command();
COMMENT ON TABLE codeworks.execution_control IS 'Владелец исполнения проекта; cutover выполняется при остановленном прежнем сервисе.';
COMMENT ON TABLE codeworks.workflow_registry IS 'Постоянная идентичность и terminal tombstone независимо от retention Temporal.';
COMMENT ON TABLE codeworks.commands IS 'Поручения и outbox создаются одной транзакцией с операцией и request_key.';
COMMENT ON TABLE codeworks.release_queue IS 'FIFO контуров; ошибка после merge сохраняет held до безопасного разрешения.';
