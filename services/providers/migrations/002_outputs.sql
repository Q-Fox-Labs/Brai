-- ABOUTME: Ограничивает временные image bytes собственным journal providers.
-- ABOUTME: Резерв до dispatch ограничивает суммарное место32MiB; готовые файлы принадлежат artifacts.
ALTER TABLE providers_operations DROP CONSTRAINT IF EXISTS providers_operations_phase_check;
ALTER TABLE providers_operations ADD CONSTRAINT providers_operations_phase_check CHECK(phase IN ('accepted','dispatching','output_pending','succeeded','failed','cancelled','outcome_unknown'));
CREATE TABLE IF NOT EXISTS providers_pending_outputs (
 owner_id varchar(255) NOT NULL,
 operation_id uuid NOT NULL,
 input_hash char(64) NOT NULL,
 request_id varchar(128) NOT NULL UNIQUE,
 bytes bytea CHECK(octet_length(bytes)<=16777216),
 sha256 char(64),
 metadata jsonb CHECK(octet_length(metadata::text)<=16384),
 expires_at bigint NOT NULL,
 PRIMARY KEY(owner_id,operation_id),
 FOREIGN KEY(owner_id,operation_id) REFERENCES providers_operations(owner_id,operation_id) ON DELETE CASCADE,
 CHECK((bytes IS NULL AND sha256 IS NULL AND metadata IS NULL) OR (bytes IS NOT NULL AND sha256 IS NOT NULL AND metadata IS NOT NULL))
);
COMMENT ON TABLE providers_pending_outputs IS 'Providers-only temporary image recovery; at most2 reserved16MiB slots; TTL24h';
COMMENT ON COLUMN providers_pending_outputs.owner_id IS 'Trusted operation owner';
COMMENT ON COLUMN providers_pending_outputs.operation_id IS 'Own operation/output relation, no agent reference ledger';
COMMENT ON COLUMN providers_pending_outputs.input_hash IS 'Immutable originating request hash';
COMMENT ON COLUMN providers_pending_outputs.request_id IS 'Stable artifacts prepare idempotency key before any prepare send';
COMMENT ON COLUMN providers_pending_outputs.bytes IS 'Exact PNG bytes before repeatable upload, never regenerated';
COMMENT ON COLUMN providers_pending_outputs.sha256 IS 'SHA256 exact immutable bytes';
COMMENT ON COLUMN providers_pending_outputs.metadata IS 'Bounded model identity and raw usage, no prompt';
COMMENT ON COLUMN providers_pending_outputs.expires_at IS 'UTC epoch milliseconds; terminal failure before byte deletion';
