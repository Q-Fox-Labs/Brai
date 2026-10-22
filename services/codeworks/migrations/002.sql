-- ABOUTME: Добавляет Git flow и доверенные подтверждения установленных версий.
-- ABOUTME: Данные принадлежат Codeworks; ссылки game-core не копируются.
ALTER TABLE codeworks.workspaces DROP CONSTRAINT workspaces_kind_check;
ALTER TABLE codeworks.workspaces ADD CHECK(kind IN ('feature','hotfix','promotion'));
ALTER TABLE codeworks.operations DROP CONSTRAINT operations_status_check;
ALTER TABLE codeworks.operations ADD CHECK(status IN ('pending','running','succeeded','failed','awaiting_execution','awaiting_ci','awaiting_deployment','awaiting_reconciliation'));
ALTER TABLE codeworks.releases DROP CONSTRAINT releases_state_check;
ALTER TABLE codeworks.releases ADD CHECK(state IN ('awaiting_execution','pending','running','succeeded','failed','awaiting_ci','awaiting_deployment','awaiting_reconciliation'));
ALTER TABLE codeworks.releases ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
CREATE TABLE codeworks.deployment_evidence (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES codeworks.projects(id),
  target text NOT NULL CHECK(target IN ('dev','prod')),
  commit_sha text NOT NULL CHECK(commit_sha ~ '^[0-9a-f]{40}$'),
  evidence_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX deployment_evidence_report ON codeworks.deployment_evidence(project_id,target,evidence_url);
CREATE INDEX deployment_evidence_current ON codeworks.deployment_evidence(project_id,target,created_at DESC);
CREATE UNIQUE INDEX one_active_release ON codeworks.operations(workspace_id) WHERE kind='request-release' AND status IN ('pending','running','awaiting_ci','awaiting_deployment','awaiting_reconciliation');
COMMENT ON TABLE codeworks.deployment_evidence IS 'Доверенные отчёты verifier: проверенная фактически установленная версия, не факт merge.';
