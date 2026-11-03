-- ABOUTME: Хранит ограниченные слоты веб-превью и намерения их публикации.
-- ABOUTME: Очередь и поколения переживают перезапуск; proof остаётся собственностью CI verifier.
CREATE SEQUENCE codeworks.web_preview_ticket;
CREATE TABLE codeworks.web_previews (
  id uuid PRIMARY KEY,
  project_id text NOT NULL REFERENCES codeworks.projects(id),
  workspace_id uuid NOT NULL UNIQUE,
  desired_sha text,
  pending_sha text,
  pending_cancel boolean NOT NULL DEFAULT false,
  deployed_sha text,
  image_reference text,
  deployed_image_reference text,
  ci_proof jsonb,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  deployed_generation bigint CHECK (deployed_generation > 0),
  slot_id text,
  state text NOT NULL CHECK (state IN ('waiting_ci','queued','publishing','ready','failed','expired','unsupported','removing')),
  queue_ticket bigint,
  published_at timestamptz,
  expires_at timestamptz,
  last_sync_operation_id uuid REFERENCES codeworks.operations(id),
  action text CHECK (action IN ('publish','remove')),
  action_generation bigint,
  backend_changed boolean NOT NULL DEFAULT false,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES codeworks.workspaces(id, project_id),
  CHECK ((action IS NULL) = (action_generation IS NULL)),
  CHECK (desired_sha IS NULL OR desired_sha ~ '^[0-9a-f]{40}$'),
  CHECK (pending_sha IS NULL OR pending_sha ~ '^[0-9a-f]{40}$'),
  CHECK (deployed_sha IS NULL OR deployed_sha ~ '^[0-9a-f]{40}$')
);
CREATE UNIQUE INDEX web_preview_slot_owner ON codeworks.web_previews(project_id,slot_id) WHERE slot_id IS NOT NULL;
CREATE INDEX web_preview_queue ON codeworks.web_previews(project_id,queue_ticket) WHERE state='queued';
COMMENT ON TABLE codeworks.web_previews IS 'Слоты и durable намерения публикации веба отдельных рабочих областей.';
COMMENT ON SEQUENCE codeworks.web_preview_ticket IS 'FIFO порядок готовых к публикации превью.';
