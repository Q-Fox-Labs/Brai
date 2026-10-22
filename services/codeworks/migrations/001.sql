-- ABOUTME: Создаёт собственный реестр проектов, областей и намерений Codeworks.
-- ABOUTME: Данные game-core не копируются; ссылки не имеют внешних ключей в чужую БД.
CREATE SCHEMA IF NOT EXISTS codeworks;
CREATE TABLE codeworks.projects (
  id text PRIMARY KEY,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX project_repository ON codeworks.projects((config->>'common_dir'));
CREATE UNIQUE INDEX project_workspace_root ON codeworks.projects((config->>'workspace_root'));
CREATE TABLE codeworks.workspaces (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES codeworks.projects(id),
  workspace_key text NOT NULL,
  element_id uuid,
  kind text NOT NULL CHECK (kind IN ('feature','hotfix')),
  base_ref text NOT NULL,
  base_sha text NOT NULL,
  branch text NOT NULL,
  path text NOT NULL UNIQUE,
  ownership_token uuid NOT NULL UNIQUE,
  preparation_state text NOT NULL DEFAULT 'intent' CHECK (preparation_state IN ('intent','branch','checkout','dependencies','ready','failed')),
  writer jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,workspace_key),
  UNIQUE(project_id,branch),
  UNIQUE(id,project_id)
);
CREATE TABLE codeworks.operations (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES codeworks.projects(id),
  workspace_id uuid,
  executor_id text NOT NULL,
  actor_id text,
  kind text NOT NULL CHECK (kind IN ('prepare-write','attach-or-transfer','request-release')),
  status text NOT NULL CHECK (status IN ('pending','running','succeeded','failed','awaiting_execution')),
  step text NOT NULL,
  request jsonb NOT NULL,
  result jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,project_id) REFERENCES codeworks.workspaces(id,project_id)
);
CREATE UNIQUE INDEX one_preparation ON codeworks.operations(workspace_id) WHERE kind='prepare-write' AND status IN ('pending','running');
CREATE TABLE codeworks.requests (
  project_id text NOT NULL REFERENCES codeworks.projects(id),
  executor_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload_sha256 text NOT NULL,
  operation_id uuid NOT NULL REFERENCES codeworks.operations(id),
  PRIMARY KEY(project_id,executor_id,idempotency_key)
);
CREATE TABLE codeworks.attachments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES codeworks.workspaces(id),
  executor_id text NOT NULL,
  session_id text NOT NULL,
  move_id uuid,
  attempt_id uuid,
  writer_epoch integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE codeworks.releases (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES codeworks.workspaces(id),
  operation_id uuid NOT NULL UNIQUE REFERENCES codeworks.operations(id),
  target text NOT NULL CHECK (target IN ('dev','prod')),
  requested_sha text NOT NULL,
  state text NOT NULL DEFAULT 'awaiting_execution' CHECK (state='awaiting_execution'),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON SCHEMA codeworks IS 'Собственные данные разработки и регистрации выпусков Codeworks.';
COMMENT ON TABLE codeworks.projects IS 'Неизменяемая политика разрешённых репозиториев и исполнителей.';
COMMENT ON TABLE codeworks.workspaces IS 'Рабочие области с закреплённой базой и единственным правом записи.';
COMMENT ON TABLE codeworks.operations IS 'Durable намерения: фиксируются до внешнего изменения Git.';
COMMENT ON TABLE codeworks.requests IS 'Ключи безопасных повторов, связанные с первоначальной операцией.';
COMMENT ON TABLE codeworks.attachments IS 'Отдельные ссылки попыток и сессий на область; не копия задачи.';
COMMENT ON TABLE codeworks.releases IS 'Запросы выпуска; исполнение на первом этапе отсутствует.';
