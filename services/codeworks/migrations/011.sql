-- ABOUTME: Сохраняет срок следующего безопасного раунда после технических ошибок Activity.
-- ABOUTME: Повтор не меняет исходное поручение, Workflow ID или закреплённый commit.
ALTER TABLE codeworks.commands ADD COLUMN technical_attempts integer NOT NULL DEFAULT 0 CHECK(technical_attempts>=0);
ALTER TABLE codeworks.commands ADD COLUMN retry_at timestamptz;
CREATE INDEX command_retry_due ON codeworks.commands(workflow_id,retry_at) WHERE state='pending';
