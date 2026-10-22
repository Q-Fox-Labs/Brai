-- ABOUTME: Связывает observer с существующим lifecycle и ограниченным Alerts outbox.
-- ABOUTME: Payload запросов не копируется; pending marker атомарен с phase, без второго журнала.
ALTER TABLE providers_operations ADD COLUMN IF NOT EXISTS observation_pending boolean NOT NULL DEFAULT false;
ALTER TABLE providers_operations ADD COLUMN IF NOT EXISTS observation_at bigint;
COMMENT ON COLUMN providers_operations.observation_pending IS 'Latest unobserved final/output_pending phase; observer does not rerun model';
COMMENT ON COLUMN providers_operations.observation_at IS 'Finalization or first failed-save UTC epoch milliseconds; orders episode failure/recovery';
CREATE INDEX IF NOT EXISTS providers_observation_pending ON providers_operations(created_at,owner_id,operation_id) WHERE observation_pending;
CREATE OR REPLACE FUNCTION providers_mark_observation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.phase IS DISTINCT FROM OLD.phase AND NEW.phase IN ('succeeded','failed','cancelled','outcome_unknown') THEN NEW.observation_pending=true; NEW.observation_at=NEW.finished_at; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS providers_observation_phase ON providers_operations;
CREATE TRIGGER providers_observation_phase BEFORE UPDATE OF phase ON providers_operations FOR EACH ROW EXECUTE FUNCTION providers_mark_observation();
CREATE TABLE IF NOT EXISTS providers_alert_episodes (
 owner_id varchar(255) NOT NULL,
 provider varchar(64) NOT NULL,
 model varchar(128) NOT NULL,
 expires_at bigint NOT NULL,
 PRIMARY KEY(owner_id,provider,model)
);
COMMENT ON TABLE providers_alert_episodes IS 'At most256 owner/route failure episodes; success closes, TTL7days';
COMMENT ON COLUMN providers_alert_episodes.owner_id IS 'Trusted owner scope, never global';
COMMENT ON COLUMN providers_alert_episodes.provider IS 'Allowlisted provider';
COMMENT ON COLUMN providers_alert_episodes.model IS 'Allowlisted model';
COMMENT ON COLUMN providers_alert_episodes.expires_at IS 'UTC epoch milliseconds episode expiry';
CREATE TABLE IF NOT EXISTS providers_alert_outbox (
 event_id uuid PRIMARY KEY,
 payload jsonb NOT NULL CHECK(octet_length(payload::text)<=8192),
 expires_at bigint NOT NULL
);
COMMENT ON TABLE providers_alert_outbox IS 'At most128 immutable safe Alerts DTOs; TTL24h; stable messageId=event_id until PubAck';
COMMENT ON COLUMN providers_alert_outbox.event_id IS 'Stable Alerts id and JetStream messageId';
COMMENT ON COLUMN providers_alert_outbox.payload IS 'Whitelisted safe owner scoped DTO; no input/output content';
COMMENT ON COLUMN providers_alert_outbox.expires_at IS 'UTC epoch milliseconds; expiry counted as drop';
