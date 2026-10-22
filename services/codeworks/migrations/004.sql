-- ABOUTME: Хранит отдельные durable rollout и подтверждённый установленный состав среды.
-- ABOUTME: Не копирует состояние задач; failed rollout не становится deployment evidence.
ALTER TABLE codeworks.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE codeworks.operations ADD CHECK(kind IN ('prepare-write','attach-or-transfer','request-release','rollout'));
CREATE TABLE codeworks.deployments (
  operation_id uuid PRIMARY KEY REFERENCES codeworks.operations(id),
  project_id text NOT NULL REFERENCES codeworks.projects(id),
  target text NOT NULL CHECK(target IN ('dev','prod')),
  commit_sha text NOT NULL CHECK(commit_sha ~ '^[0-9a-f]{40}$'),
  run_id text NOT NULL,
  attempt text NOT NULL,
  composition_digest text NOT NULL,
  composition jsonb NOT NULL,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(project_id,target,run_id,attempt)
);
CREATE TABLE codeworks.installed (
  project_id text NOT NULL REFERENCES codeworks.projects(id),
  target text NOT NULL CHECK(target IN ('dev','prod')),
  operation_id uuid NOT NULL REFERENCES codeworks.deployments(operation_id),
  composition jsonb NOT NULL,
  previous_composition jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(project_id,target)
);
CREATE UNIQUE INDEX one_active_rollout ON codeworks.operations(project_id,(request->>'target')) WHERE kind='rollout' AND status IN ('pending','running','awaiting_deployment');
COMMENT ON TABLE codeworks.deployments IS 'Durable установка exact owner-verified Actions composition; receipt только доверенного Ansible adapter.';
COMMENT ON TABLE codeworks.installed IS 'Последний успешно проверенный фактический состав; незавершённые и failed установки остаются отдельными операциями.';
