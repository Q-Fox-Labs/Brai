-- ABOUTME: Закрепляет PR в собственной БД независимо от редактируемого описания GitHub.
-- ABOUTME: Переносит известные номера из durable sync/release; конфликт истории останавливает миграцию.
CREATE TABLE codeworks.pull_requests (
  workspace_id uuid NOT NULL,
  project_id text NOT NULL,
  repository text NOT NULL CHECK (repository = lower(repository)),
  branch text NOT NULL,
  target text NOT NULL CHECK (target IN ('dev','main')),
  pr_number bigint NOT NULL CHECK (pr_number > 0 AND pr_number <= 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,repository,pr_number),
  UNIQUE (workspace_id,project_id,repository,target,pr_number),
  FOREIGN KEY (workspace_id,project_id) REFERENCES codeworks.workspaces(id,project_id)
);
COMMENT ON TABLE codeworks.pull_requests IS 'Неизменяемая связь рабочей области с GitHub PR для одной целевой ветки.';
COMMENT ON COLUMN codeworks.pull_requests.repository IS 'Закреплённый owner/repository в нижнем регистре.';
COMMENT ON COLUMN codeworks.pull_requests.pr_number IS 'Подтверждённый номер PR; описание не удостоверяет владение.';
CREATE TABLE codeworks.pull_request_heads (
  workspace_id uuid NOT NULL,
  project_id text NOT NULL,
  repository text NOT NULL,
  target text NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  pr_number bigint NOT NULL,
  PRIMARY KEY (workspace_id,target,head_sha),
  FOREIGN KEY (workspace_id,project_id,repository,target,pr_number)
    REFERENCES codeworks.pull_requests(workspace_id,project_id,repository,target,pr_number)
);
COMMENT ON TABLE codeworks.pull_request_heads IS 'Неизменяемая привязка проверенного SHA области к конкретному PR.';
WITH legs AS (
  SELECT r.workspace_id,entry.value AS leg FROM codeworks.releases r
    CROSS JOIN LATERAL jsonb_each(r.details) entry WHERE entry.key IN ('primary','backport')
  UNION ALL
  SELECT o.workspace_id,o.result->'primary' FROM codeworks.operations o WHERE o.kind='sync'
), bindings AS (
  SELECT DISTINCT w.id AS workspace_id,w.project_id,lower(p.config#>>'{github,repository}') AS repository,
    leg->>'branch' AS branch,leg->>'target' AS target,leg->>'head' AS head_sha,(leg->>'pr_number')::bigint AS pr_number
  FROM legs JOIN codeworks.workspaces w ON w.id=legs.workspace_id JOIN codeworks.projects p ON p.id=w.project_id
  WHERE w.removed_at IS NULL AND leg->>'pr_number' ~ '^[1-9][0-9]*$' AND p.config#>>'{github,repository}' IS NOT NULL
), identities AS (
  INSERT INTO codeworks.pull_requests(workspace_id,project_id,repository,branch,target,pr_number)
  SELECT DISTINCT workspace_id,project_id,repository,branch,target,pr_number FROM bindings
  RETURNING workspace_id,project_id,repository,target,pr_number
)
INSERT INTO codeworks.pull_request_heads(workspace_id,project_id,repository,target,head_sha,pr_number)
SELECT DISTINCT b.workspace_id,b.project_id,b.repository,b.target,b.head_sha,b.pr_number
FROM bindings b JOIN identities i USING (workspace_id,project_id,repository,target,pr_number);
-- AIDEV-NOTE: Удалённая область может иметь несколько прежних PR; новой рабочей привязки ей не нужно.
