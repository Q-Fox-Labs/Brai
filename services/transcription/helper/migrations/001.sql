-- ABOUTME: Создаёт только metadata таблицы и устойчивый reserve истории transcription.
-- ABOUTME: DDL выполняет отдельный владелец БД; рабочая роль не владеет схемой или миграциями.
CREATE SCHEMA IF NOT EXISTS transcription;
CREATE TABLE IF NOT EXISTS transcription.migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS transcription.settings(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL CHECK(revision>0),
 settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object')
);
INSERT INTO transcription.settings(singleton,revision,settings) VALUES(true,1,'{"defaultLocalModel":null,"allowReplacement":false,"policyVersion":1}') ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS transcription.requests(
 request_id uuid PRIMARY KEY,
 scope_type text NOT NULL CHECK(scope_type IN ('user','system')),
 scope_id text NOT NULL CHECK(scope_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]*$' AND length(scope_id)<=128),
 owner_id text NOT NULL CHECK(owner_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+-]*$' AND length(owner_id)<=128),
 client_key uuid NOT NULL,
 input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[0-9a-f]{64}$'),
 revision bigint NOT NULL CHECK(revision>0),
 task_state text NOT NULL CHECK(task_state IN ('accepted','dispatching','running','succeeded','failed','outcome_unknown','cancelled')),
 claim_token uuid,
 worker_id text,
 lease_expires_at timestamptz,
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object' AND NOT(metadata ?| ARRAY['text','segments','audio','bytes','url','errorMessage','secret'])),
 UNIQUE(scope_type,scope_id,owner_id,client_key),
 CHECK((claim_token IS NULL)=(lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS transcription_requests_claim ON transcription.requests(task_state,request_id);
CREATE TABLE IF NOT EXISTS transcription.attempts(
 attempt_id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES transcription.requests(request_id),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object' AND NOT(metadata ?| ARRAY['text','segments','audio','bytes','url','errorMessage','secret'])),
 cost_amount numeric CHECK(cost_amount IS NULL OR cost_amount>=0),
 cost_currency text CHECK(cost_currency IS NULL OR cost_currency ~ '^[A-Z]{3}$'),
 CHECK((cost_amount IS NULL)=(cost_currency IS NULL))
);
CREATE TABLE IF NOT EXISTS transcription.history_outbox(
 delivery_id uuid PRIMARY KEY,
 request_id uuid REFERENCES transcription.requests(request_id),
 terminal_slot boolean NOT NULL DEFAULT false,
 state text NOT NULL CHECK(state IN ('reserved','pending','claimed','acknowledged','failed')),
 event jsonb CHECK(event IS NULL OR (jsonb_typeof(event)='object' AND NOT(event->'data' ?| ARRAY['text','segments','audio','bytes','url','errorMessage','secret']))),
 claim_token uuid,
 lease_expires_at timestamptz,
 error_code text,
 CHECK((state='reserved')=(event IS NULL)),
 CHECK((claim_token IS NULL)=(lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS transcription_terminal_slot ON transcription.history_outbox(request_id) WHERE terminal_slot;
CREATE INDEX IF NOT EXISTS transcription_history_delivery ON transcription.history_outbox(state,lease_expires_at,delivery_id);
COMMENT ON SCHEMA transcription IS 'Собственные разрешённые метаданные сервиса расшифровки; содержимого аудио и текста нет';
COMMENT ON TABLE transcription.migrations IS 'Миграции отдельного владельца схемы';
COMMENT ON TABLE transcription.settings IS 'Настройки нынешнего локального выпуска с optimistic revision';
COMMENT ON TABLE transcription.requests IS 'Запросы, trusted область, client identity и metadata-only snapshot';
COMMENT ON TABLE transcription.attempts IS 'Отдельные попытки и известная точная стоимость без transcript';
COMMENT ON TABLE transcription.history_outbox IS 'Неизменяемые факты history, терминальные резервы и fenced delivery';
DO $comments$
DECLARE item record;
BEGIN
 FOR item IN SELECT c.relname,a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
  WHERE c.relnamespace='transcription'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
 LOOP
  EXECUTE format('COMMENT ON COLUMN transcription.%I.%I IS %L',item.relname,item.attname,
   CASE item.attname WHEN 'metadata' THEN 'Закрытый owner DTO с метаданными; текст/аудио/секреты запрещены'
    WHEN 'event' THEN 'Закрытый history append DTO; reserved slot не имеет события до завершения'
    WHEN 'cost_amount' THEN 'Точная десятичная стоимость NUMERIC; неизвестная равна NULL'
    WHEN 'claim_token' THEN 'UUID текущего lease claim; просроченный отправитель не меняет новый claim'
    WHEN 'lease_expires_at' THEN 'Срок текущего claim по времени PostgreSQL'
    ELSE 'Метаданные владельца transcription: '||item.attname END);
 END LOOP;
END $comments$;
INSERT INTO transcription.migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
