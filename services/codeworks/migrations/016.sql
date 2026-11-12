-- ABOUTME: Добавляет журнал операторского ремонта, run fencing и устойчивое ожидание GitHub.
-- ABOUTME: Прежние результаты, proofs и tombstones не изменяются; ремонт не создаёт новый workflow.
ALTER TABLE codeworks.execution_control ADD COLUMN github_retry_at timestamptz;
ALTER TABLE codeworks.execution_control ADD COLUMN github_reason_code text;
ALTER TABLE codeworks.workflow_registry ADD COLUMN execution_run_id text;
ALTER TABLE codeworks.verified_ci ADD COLUMN catalog_state text NOT NULL DEFAULT 'legacy' CHECK(catalog_state IN ('legacy','pending','published'));
ALTER TABLE codeworks.verified_ci ADD COLUMN catalog_attempts integer NOT NULL DEFAULT 0 CHECK(catalog_attempts>=0);
ALTER TABLE codeworks.verified_ci ADD COLUMN catalog_next_attempt_at timestamptz;
ALTER TABLE codeworks.verified_ci ADD COLUMN catalog_reason_code text;
ALTER TABLE codeworks.verified_ci ADD COLUMN catalog_result jsonb;
ALTER TABLE codeworks.verified_ci ADD COLUMN catalog_published_at timestamptz;
ALTER TABLE codeworks.operations DROP CONSTRAINT operations_kind_admission_check;
ALTER TABLE codeworks.operations ADD CONSTRAINT operations_kind_admission_check CHECK(archived OR kind IN
  ('prepare','sync','release','cleanup','rollout','release.close','workspace.cancel','workspace.transfer','repair'));
CREATE OR REPLACE FUNCTION codeworks.admit_command() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE control codeworks.execution_control; registry codeworks.workflow_registry; identity text;
BEGIN
  SELECT * INTO control FROM codeworks.execution_control WHERE project_id=NEW.project_id FOR SHARE;
  IF FOUND AND control.mutations_paused THEN RAISE EXCEPTION 'CODEWORKS_MUTATIONS_PAUSED' USING ERRCODE='55P03'; END IF;
  IF NEW.kind='repair' THEN
    IF NEW.executor_id<>'codeworks_owner' OR NEW.workspace_id IS NOT NULL OR control.owner IS DISTINCT FROM 'temporal' THEN
      RAISE EXCEPTION 'CODEWORKS_REPAIR_OWNER_REQUIRED' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
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
