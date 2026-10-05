-- ABOUTME: Создаёт собственную схему хранения artifacts версии 1.
-- ABOUTME: Связи и записи сохраняются после удаления байтов; runtime не применяет DDL.
CREATE SCHEMA artifacts;
CREATE TABLE artifacts.migrations(version integer PRIMARY KEY);
CREATE TABLE artifacts.artifacts (
  artifact_id uuid PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  owner_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('original','copy')),
  status text NOT NULL CHECK(status IN ('pending','ready','deleting','deleted','failed')),
  source text NOT NULL,
  size_bytes bigint CHECK(size_bytes>=0),
  created_at timestamptz NOT NULL,
  upload_token text NOT NULL UNIQUE,
  document jsonb NOT NULL
);
CREATE INDEX artifacts_owner_page ON artifacts.artifacts(owner_id,created_at,artifact_id);
CREATE INDEX artifacts_owner_size ON artifacts.artifacts(owner_id,size_bytes,artifact_id);
CREATE INDEX artifacts_unfinished ON artifacts.artifacts(artifact_id) WHERE status IN ('pending','failed','deleting');
CREATE TABLE artifacts.artifact_links (
  link_id text PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  artifact_id uuid NOT NULL REFERENCES artifacts.artifacts(artifact_id),
  token text NOT NULL UNIQUE,
  document jsonb NOT NULL
);
CREATE TABLE artifacts.artifact_relations (
  model_artifact_id uuid NOT NULL REFERENCES artifacts.artifacts(artifact_id),
  original_artifact_id uuid NOT NULL REFERENCES artifacts.artifacts(artifact_id),
  document jsonb NOT NULL,
  PRIMARY KEY(model_artifact_id,original_artifact_id)
);
CREATE INDEX artifact_relations_original ON artifacts.artifact_relations(original_artifact_id);
CREATE TABLE artifacts.artifact_references (
  owner_id text NOT NULL,
  project_id text NOT NULL,
  thread_id text NOT NULL,
  operation_id text NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY(owner_id,project_id,thread_id,operation_id)
);
CREATE INDEX artifact_references_native_item ON artifacts.artifact_references(owner_id,project_id,thread_id,(document->>'itemId'));
INSERT INTO artifacts.migrations(version) VALUES(1);
