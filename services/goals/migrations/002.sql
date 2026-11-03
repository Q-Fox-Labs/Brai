-- ABOUTME: Добавляет родительскую связь целей с изоляцией владельцев.
-- ABOUTME: Существующие цели остаются корнями без изменения версии и истории.
ALTER TABLE goals.goals ADD COLUMN parent_goal_id uuid;
ALTER TABLE goals.goals ADD CONSTRAINT goals_parent_same_owner
 FOREIGN KEY(owner_id,parent_goal_id) REFERENCES goals.goals(owner_id,id);
ALTER TABLE goals.goals ADD CONSTRAINT goals_parent_not_self CHECK (parent_goal_id IS NULL OR parent_goal_id <> id);
CREATE INDEX goals_by_parent ON goals.goals(owner_id,parent_goal_id);
COMMENT ON COLUMN goals.goals.parent_goal_id IS 'Необязательная группирующая родительская цель того же владельца.';
