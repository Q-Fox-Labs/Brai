-- ABOUTME: Создаёт ограниченную очередь проблем transcription и устойчивые эпизоды сбоев.
-- ABOUTME: Резервы действующих запросов сохраняются; прошлые ошибки не рассылаются.
CREATE TABLE IF NOT EXISTS transcription.alerts_outbox(
 delivery_id uuid PRIMARY KEY,
 request_id uuid UNIQUE REFERENCES transcription.requests(request_id),
 incident_key text UNIQUE CHECK(incident_key IN ('storage','local_ai','artifacts','history','recovery','delivery','capacity')),
 state text NOT NULL CHECK(state IN ('reserved','pending','claimed')),
 event jsonb CHECK(event IS NULL OR (jsonb_typeof(event)='object' AND event->>'service_id'='transcription' AND octet_length(event::text)<=8192)),
 claim_token uuid, lease_expires_at timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((request_id IS NOT NULL)<>(incident_key IS NOT NULL)),
 CHECK((state='reserved')=(event IS NULL)),
 CHECK((state='claimed')=(claim_token IS NOT NULL)),
 CHECK((claim_token IS NULL)=(lease_expires_at IS NULL))
);
CREATE TABLE IF NOT EXISTS transcription.alerts_incidents(
 key text PRIMARY KEY CHECK(key IN ('storage','local_ai','artifacts','history','recovery','delivery','capacity')),
 active boolean NOT NULL,
 event jsonb CHECK(event IS NULL OR (jsonb_typeof(event)='object' AND octet_length(event::text)<=8192)),
 CHECK(active=(event IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS transcription_alerts_delivery ON transcription.alerts_outbox(state,next_attempt_at,lease_expires_at);
INSERT INTO transcription.alerts_outbox(delivery_id,request_id,state)
 SELECT gen_random_uuid(),request_id,'reserved' FROM transcription.requests
 WHERE task_state IN ('accepted','dispatching','running')
 OR (task_state='succeeded' AND metadata->>'resultState' IN ('available','delivery_unknown')
 AND (metadata->>'resultExpiresAt')::timestamptz>clock_timestamp())
 ON CONFLICT(request_id) DO NOTHING;
COMMENT ON TABLE transcription.alerts_outbox IS 'Стабильные безопасные уведомления, резервы запросов и fenced доставка до PubAck';
COMMENT ON TABLE transcription.alerts_incidents IS 'Один активный эпизод на закрытую причину; восстановление не создаёт уведомлений';
DO $comments$
DECLARE item record;
BEGIN
 FOR item IN SELECT c.relname,a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
 WHERE c.relnamespace='transcription'::regnamespace AND c.relname IN ('alerts_outbox','alerts_incidents') AND a.attnum>0 AND NOT a.attisdropped
 LOOP
 EXECUTE format('COMMENT ON COLUMN transcription.%I.%I IS %L',item.relname,item.attname,
 CASE item.attname WHEN 'event' THEN 'Неизменяемая закрытая проекция owner alerts ingest без текста распознавания'
 WHEN 'claim_token' THEN 'UUID актуального lease; stale ack/fail отклоняются'
 WHEN 'next_attempt_at' THEN 'Следующая доставка по времени БД; повтор 1–30 секунд'
 ELSE 'Метаданные уведомлений transcription: '||item.attname END);
 END LOOP;
END $comments$;
INSERT INTO transcription.migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
