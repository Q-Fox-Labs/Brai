-- ABOUTME: Создаёт закрытую схему неизменяемых источников, снимков и сообщений.
-- ABOUTME: Только owner запускает миграцию; app получает SELECT/INSERT без прав изменения и удаления.
BEGIN;

SET LOCAL dialogues.app_role TO :'dialogues_app_role';

DO $preflight$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database() AND pg_get_userbyid(datdba)=current_user) THEN
  RAISE EXCEPTION 'DIALOGUES_DATABASE_OWNER_REQUIRED';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_setting('dialogues.app_role') AND rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)) THEN
  RAISE EXCEPTION 'DIALOGUES_APP_ROLE_INVALID';
 END IF;
END
$preflight$;

CREATE SCHEMA IF NOT EXISTS dialogues AUTHORIZATION CURRENT_USER;
DO $schema_owner$
BEGIN
 IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='dialogues') <> current_user THEN
  RAISE EXCEPTION 'DIALOGUES_SCHEMA_OWNER_CONFLICT';
 END IF;
END
$schema_owner$;

CREATE TABLE IF NOT EXISTS dialogues.migrations (
 version integer PRIMARY KEY CHECK (version > 0),
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS dialogues.sources (
 source_id text PRIMARY KEY CHECK (length(source_id) > 0),
 source_kind text NOT NULL CHECK (source_kind IN ('chatgpt_export','codex_thread','continuation_file'))
);

CREATE TABLE IF NOT EXISTS dialogues.source_snapshots (
 snapshot_id text PRIMARY KEY CHECK (length(snapshot_id) > 0),
 source_id text NOT NULL REFERENCES dialogues.sources(source_id),
 original_sha256 text NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
 original_bytes bytea NOT NULL,
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (snapshot_id, source_id)
);

CREATE TABLE IF NOT EXISTS dialogues.dialogues (
 source_id text NOT NULL REFERENCES dialogues.sources(source_id),
 dialogue_id text NOT NULL CHECK (length(dialogue_id) > 0),
 external_id text NOT NULL CHECK (length(external_id) > 0),
 PRIMARY KEY (source_id, dialogue_id)
);

CREATE TABLE IF NOT EXISTS dialogues.messages (
 source_id text NOT NULL,
 dialogue_id text NOT NULL,
 message_id text NOT NULL CHECK (length(message_id) > 0),
 turn_id text NOT NULL CHECK (length(turn_id) > 0),
 message_order bigint NOT NULL CHECK (message_order >= 0),
 turn_order bigint NOT NULL CHECK (turn_order >= 0),
 item_order integer NOT NULL CHECK (item_order >= 0),
 role text NOT NULL CHECK (length(role) > 0),
 original_text text,
 original_payload jsonb NOT NULL,
 original_payload_utf8 bytea NOT NULL,
 text_sha256 text CHECK (text_sha256 IS NULL OR text_sha256 ~ '^[0-9a-f]{64}$'),
 payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
 message_time timestamptz,
 message_time_original jsonb,
 turn_started_at jsonb,
 turn_completed_at jsonb,
 timestamp_provenance text NOT NULL CHECK (timestamp_provenance IN ('message_exact','turn_only','unknown')),
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (source_id, dialogue_id, message_id),
 UNIQUE (source_id, dialogue_id, message_order),
 FOREIGN KEY (source_id, dialogue_id) REFERENCES dialogues.dialogues(source_id, dialogue_id),
 CHECK ((original_text IS NULL) = (text_sha256 IS NULL))
);

CREATE TABLE IF NOT EXISTS dialogues.source_snapshot_messages (
 snapshot_id text NOT NULL,
 source_id text NOT NULL,
 dialogue_id text NOT NULL,
 message_id text NOT NULL,
 PRIMARY KEY (snapshot_id, source_id, dialogue_id, message_id),
 FOREIGN KEY (snapshot_id, source_id) REFERENCES dialogues.source_snapshots(snapshot_id, source_id),
 FOREIGN KEY (source_id, dialogue_id, message_id) REFERENCES dialogues.messages(source_id, dialogue_id, message_id)
);

COMMENT ON SCHEMA dialogues IS 'Приватное хранилище исходных разговоров сервиса dialogues';
COMMENT ON TABLE dialogues.migrations IS 'Журнал атомарных миграций владельца БД dialogues';
COMMENT ON COLUMN dialogues.migrations.version IS 'Номер применённой миграции владельца';
COMMENT ON COLUMN dialogues.migrations.applied_at IS 'Время фиксации миграции PostgreSQL';
COMMENT ON TABLE dialogues.sources IS 'Стабильные логические источники исходных диалогов';
COMMENT ON COLUMN dialogues.sources.source_id IS 'Стабильный ID выгрузки или Codex thread';
COMMENT ON COLUMN dialogues.sources.source_kind IS 'Тип логического источника: chatgpt_export, codex_thread или continuation_file';
COMMENT ON TABLE dialogues.source_snapshots IS 'Неизменяемые исходные файлы и snapshots логического источника';
COMMENT ON COLUMN dialogues.source_snapshots.snapshot_id IS 'Уникальный ID файла или страницы-источника';
COMMENT ON COLUMN dialogues.source_snapshots.source_id IS 'Логический источник, к которому относится снимок';
COMMENT ON COLUMN dialogues.source_snapshots.original_sha256 IS 'SHA-256 точных байтов исходного snapshot';
COMMENT ON COLUMN dialogues.source_snapshots.original_bytes IS 'Точные исходные байты JSON-файла или страницы';
COMMENT ON COLUMN dialogues.source_snapshots.imported_at IS 'Время вставки snapshot PostgreSQL';
COMMENT ON TABLE dialogues.dialogues IS 'Идентичность диалогов в пределах логического источника';
COMMENT ON COLUMN dialogues.dialogues.source_id IS 'Стабильный логический источник диалога';
COMMENT ON COLUMN dialogues.dialogues.dialogue_id IS 'Стабильный ID диалога в пределах источника';
COMMENT ON COLUMN dialogues.dialogues.external_id IS 'Исходный внешний ID диалога';
COMMENT ON TABLE dialogues.messages IS 'Неизменяемые исходные сообщения с порядком и временной provenance';
COMMENT ON COLUMN dialogues.messages.source_id IS 'Стабильный логический источник сообщения';
COMMENT ON COLUMN dialogues.messages.dialogue_id IS 'ID диалога в пределах логического источника';
COMMENT ON COLUMN dialogues.messages.message_id IS 'Исходный ID сообщения в пределах диалога';
COMMENT ON COLUMN dialogues.messages.turn_id IS 'ID исходного хода, содержащего сообщение';
COMMENT ON COLUMN dialogues.messages.message_order IS 'Порядок сообщения в логическом диалоге';
COMMENT ON COLUMN dialogues.messages.turn_order IS 'Порядок хода в исходном диалоге';
COMMENT ON COLUMN dialogues.messages.item_order IS 'Порядок элемента в исходном ходе';
COMMENT ON COLUMN dialogues.messages.role IS 'Исходная роль сообщения без преобразования';
COMMENT ON COLUMN dialogues.messages.original_text IS 'Исходный текст сообщения; NULL для payload-only элементов';
COMMENT ON COLUMN dialogues.messages.original_payload IS 'Семантическое исходное значение payload в JSONB';
COMMENT ON COLUMN dialogues.messages.original_payload_utf8 IS 'Каноническая UTF-8 сериализация значения original_payload';
COMMENT ON COLUMN dialogues.messages.text_sha256 IS 'SHA-256 UTF-8 текста или NULL вместе с original_text';
COMMENT ON COLUMN dialogues.messages.payload_sha256 IS 'SHA-256 канонических UTF-8 байтов original_payload';
COMMENT ON COLUMN dialogues.messages.message_time IS 'Точное исходное время сообщения; NULL если источник его не задаёт';
COMMENT ON COLUMN dialogues.messages.message_time_original IS 'Исходное значение времени отдельного сообщения';
COMMENT ON COLUMN dialogues.messages.turn_started_at IS 'Исходное значение времени начала содержащего хода';
COMMENT ON COLUMN dialogues.messages.turn_completed_at IS 'Исходное значение времени завершения содержащего хода';
COMMENT ON COLUMN dialogues.messages.timestamp_provenance IS 'Происхождение времени: message_exact, turn_only или unknown';
COMMENT ON COLUMN dialogues.messages.imported_at IS 'Время вставки сообщения PostgreSQL';
COMMENT ON TABLE dialogues.source_snapshot_messages IS 'Членство неизменяемых сообщений в исходных snapshots';
COMMENT ON COLUMN dialogues.source_snapshot_messages.snapshot_id IS 'Snapshot, в котором присутствует сообщение';
COMMENT ON COLUMN dialogues.source_snapshot_messages.source_id IS 'Логический источник snapshot и сообщения';
COMMENT ON COLUMN dialogues.source_snapshot_messages.dialogue_id IS 'Диалог сообщения в пределах источника';
COMMENT ON COLUMN dialogues.source_snapshot_messages.message_id IS 'ID сообщения, присутствующего в snapshot';

REVOKE ALL ON SCHEMA dialogues FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA dialogues FROM PUBLIC, :"dialogues_app_role";
REVOKE ALL ON ALL SEQUENCES IN SCHEMA dialogues FROM PUBLIC, :"dialogues_app_role";
GRANT USAGE ON SCHEMA dialogues TO :"dialogues_app_role";
GRANT SELECT, INSERT ON dialogues.sources, dialogues.source_snapshots, dialogues.dialogues, dialogues.messages, dialogues.source_snapshot_messages TO :"dialogues_app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA dialogues REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA dialogues REVOKE ALL ON SEQUENCES FROM PUBLIC;

INSERT INTO dialogues.migrations(version) VALUES (1) ON CONFLICT (version) DO NOTHING;

DO $verify$
DECLARE
 expected text[] := ARRAY['dialogues','messages','migrations','source_snapshot_messages','source_snapshots','sources'];
 actual text[];
BEGIN
 SELECT array_agg(n.nspname ORDER BY n.nspname) INTO actual FROM pg_namespace n WHERE n.nspname='dialogues';
 IF actual <> ARRAY['dialogues'] THEN RAISE EXCEPTION 'DIALOGUES_SCHEMA_VERIFY_FAILED'; END IF;
 SELECT array_agg(c.relname ORDER BY c.relname) INTO actual FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dialogues' AND c.relkind IN ('r','p');
 IF actual <> expected THEN RAISE EXCEPTION 'DIALOGUES_TABLE_SET_VERIFY_FAILED'; END IF;
 IF EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='dialogues' AND a.grantee=0 AND a.privilege_type IN ('USAGE','CREATE')) THEN RAISE EXCEPTION 'DIALOGUES_PUBLIC_SCHEMA_PRIVILEGE'; END IF;
 IF has_table_privilege(current_setting('dialogues.app_role'),'dialogues.migrations','SELECT') OR has_table_privilege(current_setting('dialogues.app_role'),'dialogues.migrations','INSERT') THEN RAISE EXCEPTION 'DIALOGUES_APP_MIGRATION_ACCESS'; END IF;
 IF has_table_privilege(current_setting('dialogues.app_role'),'dialogues.sources','UPDATE') OR has_table_privilege(current_setting('dialogues.app_role'),'dialogues.sources','DELETE') OR has_table_privilege(current_setting('dialogues.app_role'),'dialogues.sources','TRUNCATE') THEN RAISE EXCEPTION 'DIALOGUES_APP_MUTATION_ACCESS'; END IF;
 IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dialogues' AND c.relkind IN ('r','p') AND pg_get_userbyid(c.relowner) <> current_user) THEN RAISE EXCEPTION 'DIALOGUES_TABLE_OWNER_DRIFT'; END IF;
END
$verify$;

COMMIT;
