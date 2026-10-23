-- ABOUTME: Выводит прежний контроллер агентов из исполнения без удаления рабочих областей и выпусков.
-- ABOUTME: Старые операции и права остаются историей; новые операции не имеют writer/session/epoch.
ALTER TABLE codeworks.operations ADD COLUMN archived boolean NOT NULL DEFAULT false;
UPDATE codeworks.operations SET archived=true;
ALTER TABLE codeworks.deployments ADD COLUMN archived boolean NOT NULL DEFAULT false;
UPDATE codeworks.deployments SET archived=true;
ALTER TABLE codeworks.workspaces RENAME COLUMN writer TO legacy_writer;
ALTER TABLE codeworks.workspaces ALTER COLUMN legacy_writer DROP NOT NULL;
ALTER TABLE codeworks.workspaces ADD COLUMN removed_at timestamptz;
ALTER TABLE codeworks.attachments RENAME TO legacy_attachments;

ALTER TABLE codeworks.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE codeworks.operations ADD CHECK(archived OR kind IN ('prepare','sync','release','cleanup','rollout'));
ALTER TABLE codeworks.workspaces ADD CHECK(legacy_writer IS NOT NULL OR kind IN ('feature','hotfix'));
DROP INDEX codeworks.one_preparation;
DROP INDEX codeworks.one_active_release;
DROP INDEX codeworks.one_active_commit;
DROP INDEX codeworks.one_active_rollout;
DROP INDEX codeworks.original_rollout_identity;
CREATE UNIQUE INDEX one_preparation ON codeworks.operations(workspace_id) WHERE NOT archived AND kind='prepare' AND status IN ('pending','running');
CREATE UNIQUE INDEX one_active_release ON codeworks.operations(workspace_id) WHERE NOT archived AND kind='release' AND status IN ('pending','running','awaiting_ci','awaiting_deployment','awaiting_reconciliation');
CREATE UNIQUE INDEX one_active_rollout ON codeworks.operations(project_id,(request->>'target')) WHERE NOT archived AND kind='rollout' AND status IN ('pending','running','awaiting_deployment');
CREATE UNIQUE INDEX original_rollout_identity ON codeworks.deployments(project_id,target,run_id,attempt) WHERE NOT archived AND retry_of IS NULL;
COMMENT ON TABLE codeworks.workspaces IS 'Рабочие деревья и ветки задач; правами агента сервис не управляет.';
COMMENT ON TABLE codeworks.legacy_attachments IS 'Исторические ссылки старого контроллера. В исполнении не участвуют.';
COMMENT ON COLUMN codeworks.workspaces.legacy_writer IS 'Исторические права старого контроллера, не используются.';
COMMENT ON COLUMN codeworks.workspaces.removed_at IS 'Время подтверждённого удаления собственного дерева, запись области сохраняется.';
COMMENT ON COLUMN codeworks.operations.archived IS 'Историческая операция исключена из исполнения и автоматического восстановления.';
COMMENT ON COLUMN codeworks.deployments.archived IS 'Историческая установка сохранена без повторного автоматического исполнения.';
