-- ABOUTME: Связывает фактические вызовы записи с обязанностью окончательной очистки.
-- ABOUTME: Исторические области сохраняются и требуют новой проверки внешних ресурсов.
ALTER TABLE codeworks.workspaces ADD COLUMN activation_state text NOT NULL DEFAULT 'legacy'
  CHECK(activation_state IN ('legacy','awaiting_first_write','active'));
ALTER TABLE codeworks.workspaces ADD COLUMN first_write_at timestamptz;
ALTER TABLE codeworks.workflow_registry DROP CONSTRAINT workflow_registry_lifecycle_check;
ALTER TABLE codeworks.workflow_registry ADD CONSTRAINT workflow_registry_lifecycle_check
  CHECK(lifecycle IN ('active','closing','removed','cancelled'));
ALTER TABLE codeworks.workflow_registry ADD COLUMN outcome text
  CHECK(outcome IN ('released','cancelled','transferred','unused'));
ALTER TABLE codeworks.workspaces DROP CONSTRAINT workspaces_project_id_workspace_key_key;
ALTER TABLE codeworks.workspaces DROP CONSTRAINT workspaces_project_id_branch_key;
CREATE UNIQUE INDEX live_workspace_key ON codeworks.workspaces(project_id,workspace_key) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX live_workspace_branch ON codeworks.workspaces(project_id,branch) WHERE removed_at IS NULL;
ALTER TABLE codeworks.operations DROP CONSTRAINT operations_kind_admission_check;
ALTER TABLE codeworks.operations ADD CONSTRAINT operations_kind_admission_check CHECK(archived OR kind IN
  ('prepare','sync','release','cleanup','rollout','release.close','workspace.cancel','workspace.transfer'));
CREATE TABLE codeworks.write_calls (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES codeworks.projects(id),
  workspace_id uuid REFERENCES codeworks.workspaces(id),
  operation_id uuid REFERENCES codeworks.operations(id),
  executor_id text NOT NULL,
  session_id text NOT NULL,
  turn_id text NOT NULL,
  tool_use_id text NOT NULL,
  tool_name text NOT NULL,
  workspace_key text NOT NULL,
  kind text NOT NULL,
  request_key text NOT NULL,
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  targets jsonb NOT NULL CHECK(jsonb_typeof(targets)='array'),
  state text NOT NULL CHECK(state IN ('preparing','denied_pending','in_flight','finished','uncertain')),
  rewritten_sha256 text CHECK(rewritten_sha256 ~ '^[a-f0-9]{64}$'),
  tool_result jsonb,
  baseline_head text,
  ready_at timestamptz,
  admitted_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,executor_id,session_id,turn_id,tool_use_id)
);
CREATE INDEX workspace_writers ON codeworks.write_calls(workspace_id,state);
CREATE TABLE codeworks.cleanup_obligations (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES codeworks.projects(id),
  workspace_id uuid REFERENCES codeworks.workspaces(id),
  subject_key text NOT NULL,
  source_operation_id uuid REFERENCES codeworks.operations(id),
  outcome text NOT NULL CHECK(outcome IN ('released','cancelled','transferred','unused')),
  step text NOT NULL DEFAULT 'inspect',
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','retry','waiting_decision','done')),
  evidence jsonb NOT NULL DEFAULT '{}',
  expected jsonb NOT NULL DEFAULT '{}',
  owner_workflow_id text,
  epoch bigint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  blocker text,
  result jsonb,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_cleanup_subject ON codeworks.cleanup_obligations(project_id,subject_key) WHERE state<>'done';
CREATE INDEX cleanup_due ON codeworks.cleanup_obligations(project_id,next_attempt_at) WHERE state IN ('pending','running','retry');
-- AIDEV-NOTE: Только служебная очистка может поступить в уже закрывающийся root.
CREATE OR REPLACE FUNCTION codeworks.admit_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE control codeworks.execution_control; registry codeworks.workflow_registry; identity text;
BEGIN
  SELECT * INTO control FROM codeworks.execution_control WHERE project_id=NEW.project_id FOR SHARE;
  IF FOUND AND control.mutations_paused THEN RAISE EXCEPTION 'CODEWORKS_MUTATIONS_PAUSED' USING ERRCODE='55P03'; END IF;
  IF control.owner IS NULL OR control.owner='legacy' OR NEW.archived THEN RETURN NEW; END IF;
  identity := 'codeworks/' || control.instance_id || '/' || NEW.project_id || '/' ||
    CASE WHEN NEW.workspace_id IS NULL THEN 'rollout/' || NEW.id::text ELSE 'workspace/' || NEW.workspace_id::text END;
  INSERT INTO codeworks.workflow_registry(workflow_id,project_id,workspace_id,operation_id,owner)
    VALUES(identity,NEW.project_id,NEW.workspace_id,CASE WHEN NEW.workspace_id IS NULL THEN NEW.id END,'temporal') ON CONFLICT(workflow_id) DO NOTHING;
  SELECT * INTO registry FROM codeworks.workflow_registry WHERE workflow_id=identity FOR UPDATE;
  IF registry.owner <> 'temporal' OR NOT ((registry.state='open' AND registry.lifecycle='active') OR
     (NEW.kind='cleanup' AND registry.state='draining' AND registry.lifecycle='closing') OR
     (NEW.kind IN ('workspace.cancel','workspace.transfer') AND registry.state='draining' AND registry.lifecycle='closing'
      AND EXISTS(SELECT 1 FROM codeworks.cleanup_obligations o WHERE o.workspace_id=NEW.workspace_id AND o.step='inspect'
        AND o.state='waiting_decision' AND o.evidence->>'route_pending'='true'))) THEN
    RAISE EXCEPTION 'CODEWORKS_TASK_CLOSED' USING ERRCODE='23505';
  END IF;
  UPDATE codeworks.workflow_registry SET next_sequence=next_sequence+1,updated_at=now() WHERE workflow_id=identity RETURNING * INTO registry;
  INSERT INTO codeworks.commands(operation_id,workflow_id,sequence,generation,kind,admitted_request,requested_sha)
    VALUES(NEW.id,identity,registry.next_sequence,registry.generation,NEW.kind,NEW.request,NEW.request->>'commit_sha');
  RETURN NEW;
END $$;
COMMENT ON TABLE codeworks.write_calls IS 'Native вызовы: только identity, пути и digest, без текста правок и вывода инструмента.';
COMMENT ON TABLE codeworks.cleanup_obligations IS 'Обязанность Temporal до нового подтверждённого отсутствия всех временных ресурсов.';
