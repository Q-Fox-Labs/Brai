-- ABOUTME: Хранит неизменяемые связи результатов native сообщений отдельно от incoming ledger.
-- ABOUTME: Ключ включает owner/project/thread/item; удаление байтов не удаляет историю.
CREATE TABLE artifacts.artifact_output_bindings (
  owner_id text NOT NULL,
  project_id text NOT NULL,
  thread_id text NOT NULL,
  item_id text NOT NULL,
  document jsonb NOT NULL,
  PRIMARY KEY(owner_id,project_id,thread_id,item_id)
);
COMMENT ON TABLE artifacts.artifact_output_bindings IS 'Неизменяемые связи результатов native сообщений с артефактами; входящие references хранятся отдельно';
COMMENT ON COLUMN artifacts.artifact_output_bindings.owner_id IS 'Проверенный владелец артефактов';
COMMENT ON COLUMN artifacts.artifact_output_bindings.project_id IS 'Непрозрачный ID проекта native сообщения';
COMMENT ON COLUMN artifacts.artifact_output_bindings.thread_id IS 'Непрозрачный ID native чата';
COMMENT ON COLUMN artifacts.artifact_output_bindings.item_id IS 'Точный ID native сообщения в пределах чата';
COMMENT ON COLUMN artifacts.artifact_output_bindings.document IS 'ArtifactOutputBinding: turnId, упорядоченные уникальные artifactIds, область и createdAt';
INSERT INTO artifacts.migrations(version) VALUES(2);
