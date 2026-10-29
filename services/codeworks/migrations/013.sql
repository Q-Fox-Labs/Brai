-- ABOUTME: Сохраняет подтверждения завершения записи до проверки дерева.
-- ABOUTME: Не снимает блокировку писателя по таймеру или состоянию выпуска.
ALTER TABLE codeworks.write_calls ADD COLUMN completion_input_sha256 text
  CHECK (completion_input_sha256 IS NULL OR completion_input_sha256 ~ '^[a-f0-9]{64}$');
ALTER TABLE codeworks.execution_control ADD COLUMN completion_spool_cursor text
  CHECK (completion_spool_cursor IS NULL OR completion_spool_cursor ~ '^[a-f0-9]{64}$');
CREATE TABLE codeworks.write_completions (
  write_call_id uuid PRIMARY KEY REFERENCES codeworks.write_calls(id),
  receipt_sha256 text NOT NULL CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  notification jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','waiting_decision')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX write_completions_pending ON codeworks.write_completions(next_attempt_at,write_call_id) WHERE state='pending';
COMMENT ON TABLE codeworks.write_completions IS 'Неизменные метаданные native Post и состояние их повторяемой обработки; содержимое файлов и вывод не сохраняются.';
