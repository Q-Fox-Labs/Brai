-- ABOUTME: Хранит только owner-scoped ключ, lifecycle и ограниченный итог providers.
-- ABOUTME: БД и роль providers выделяются оператором; исходный state здесь не хранится.
CREATE TABLE IF NOT EXISTS providers_operations (
  owner_id varchar(255) NOT NULL,
  operation_id uuid NOT NULL,
  input_hash char(64) NOT NULL,
  phase text NOT NULL CHECK (phase IN ('accepted','dispatching','succeeded','failed','cancelled','outcome_unknown')),
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  finished_at bigint,
  key_expires_at bigint NOT NULL,
  result_expires_at bigint,
  route jsonb NOT NULL CHECK (octet_length(route::text) <= 2048),
  result jsonb CHECK (octet_length(result::text) <= 131072),
  error_code varchar(64),
  PRIMARY KEY(owner_id, operation_id)
);
CREATE INDEX IF NOT EXISTS providers_operations_expiry ON providers_operations(key_expires_at);
COMMENT ON TABLE providers_operations IS 'Owner providers: key TTL7days, result TTL24h; no input prompts';
COMMENT ON COLUMN providers_operations.owner_id IS 'Trusted caller scope, never inferred from UUID';
COMMENT ON COLUMN providers_operations.operation_id IS 'Caller idempotency key within owner';
COMMENT ON COLUMN providers_operations.input_hash IS 'SHA256 canonical full request including deadline';
COMMENT ON COLUMN providers_operations.phase IS 'Durable dispatch intent precedes model port; restart dispatching becomes unknown';
COMMENT ON COLUMN providers_operations.cancel_requested IS 'Cancellation request does not prove billing stopped';
COMMENT ON COLUMN providers_operations.created_at IS 'Acceptance UTC epoch milliseconds';
COMMENT ON COLUMN providers_operations.finished_at IS 'Local finalization UTC epoch milliseconds';
COMMENT ON COLUMN providers_operations.key_expires_at IS 'Dedupe key UTC epoch milliseconds;7days from acceptance';
COMMENT ON COLUMN providers_operations.result_expires_at IS 'Result expiry UTC epoch milliseconds;24h from finalization';
COMMENT ON COLUMN providers_operations.route IS 'Selected provider/model/catalog version; no credentials';
COMMENT ON COLUMN providers_operations.result IS 'Bounded response JSON, removed after result TTL';
COMMENT ON COLUMN providers_operations.error_code IS 'Safe code only; never upstream body';
