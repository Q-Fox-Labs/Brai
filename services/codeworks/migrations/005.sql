-- ABOUTME: Связывает новый trusted retry с terminal failed rollout без повторного исполнения старого ID.
-- ABOUTME: Exact owner proof переиспользуется; одна failed операция имеет не более одного retry child.
ALTER TABLE codeworks.deployments DROP CONSTRAINT deployments_project_id_target_run_id_attempt_key;
ALTER TABLE codeworks.deployments ADD COLUMN retry_of uuid UNIQUE REFERENCES codeworks.deployments(operation_id);
COMMENT ON COLUMN codeworks.deployments.retry_of IS 'Предыдущая terminal failed установка; trusted retry получает новый durable ID, повтор возвращает того же child.';
CREATE UNIQUE INDEX original_rollout_identity ON codeworks.deployments(project_id,target,run_id,attempt) WHERE retry_of IS NULL;
