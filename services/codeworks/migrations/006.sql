-- ABOUTME: Разрешает commit в существующей durable очереди Git операций.
-- ABOUTME: Владение writer остаётся в прежних workspace и epoch.
ALTER TABLE codeworks.operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE codeworks.operations ADD CHECK(kind IN ('prepare-write','attach-or-transfer','commit','request-release','rollout'));
CREATE UNIQUE INDEX one_active_commit ON codeworks.operations(workspace_id) WHERE kind='commit' AND status IN ('pending','running');
