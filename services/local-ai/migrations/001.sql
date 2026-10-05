-- ABOUTME: Создаёт собственное хранилище каталога, установок, настроек и metadata outbox.
-- ABOUTME: Выполняется только отдельным владельцем БД; runtime DDL не запускает.
CREATE SCHEMA IF NOT EXISTS local_ai;

CREATE TABLE IF NOT EXISTS local_ai.migrations (
  version integer PRIMARY KEY,
  name text NOT NULL UNIQUE,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE local_ai.migrations IS 'Журнал отдельно запущенных миграций local-ai.';
COMMENT ON COLUMN local_ai.migrations.version IS 'Монотонный номер применённой миграции.';
COMMENT ON COLUMN local_ai.migrations.name IS 'Закреплённое имя файла миграции.';
COMMENT ON COLUMN local_ai.migrations.applied_at IS 'Время фиксации миграции в UTC.';

CREATE TABLE IF NOT EXISTS local_ai.models (
  model_id text PRIMARY KEY CHECK (length(model_id) BETWEEN 1 AND 255),
  revision text NOT NULL CHECK (length(revision) BETWEEN 1 AND 255),
  supported boolean NOT NULL,
  operations jsonb NOT NULL CHECK (jsonb_typeof(operations) = 'array'),
  input_kinds jsonb NOT NULL CHECK (jsonb_typeof(input_kinds) = 'array'),
  output_kinds jsonb NOT NULL CHECK (jsonb_typeof(output_kinds) = 'array'),
  languages jsonb NOT NULL CHECK (jsonb_typeof(languages) = 'array'),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  CHECK (document->>'modelId' = model_id AND document->>'revision' = revision
    AND (document->>'supported')::boolean = supported
    AND document->'operations' = operations AND document->'inputKinds' = input_kinds
    AND document->'outputKinds' = output_kinds AND document->'languages' = languages)
);
COMMENT ON TABLE local_ai.models IS 'Каталог local-ai и закреплённые возможности моделей.';
COMMENT ON COLUMN local_ai.models.model_id IS 'Стабильный идентификатор модели; не содержит локального пути.';
COMMENT ON COLUMN local_ai.models.revision IS 'Закреплённая исходная ревизия модели.';
COMMENT ON COLUMN local_ai.models.supported IS 'Признак наличия проверенного профиля исполнителя.';
COMMENT ON COLUMN local_ai.models.operations IS 'Разрешённые операции из каталожной записи.';
COMMENT ON COLUMN local_ai.models.input_kinds IS 'Поддержанные виды входа из каталожной записи.';
COMMENT ON COLUMN local_ai.models.output_kinds IS 'Поддержанные виды результата из каталожной записи.';
COMMENT ON COLUMN local_ai.models.languages IS 'Поддержанные языки из каталожной записи.';
COMMENT ON COLUMN local_ai.models.document IS 'Полная закрытая запись ModelRecord без состояния процесса или установки.';

CREATE TABLE IF NOT EXISTS local_ai.installations (
  model_id text NOT NULL,
  revision text NOT NULL,
  profile_id text NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 255),
  directory text NOT NULL CHECK (directory LIKE '/%'),
  files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  installed_at timestamptz NOT NULL,
  PRIMARY KEY (model_id, revision)
);
COMMENT ON TABLE local_ai.installations IS 'Готовые неизменяемые установки с приватным каталогом и проверенным манифестом.';
COMMENT ON COLUMN local_ai.installations.model_id IS 'Идентификатор записи каталога моделей.';
COMMENT ON COLUMN local_ai.installations.revision IS 'Установленная закреплённая ревизия.';
COMMENT ON COLUMN local_ai.installations.profile_id IS 'Закреплённый профиль, соответствующий установленной ревизии.';
COMMENT ON COLUMN local_ai.installations.directory IS 'Внутренний абсолютный путь; никогда не возвращается публичным DTO.';
COMMENT ON COLUMN local_ai.installations.files IS 'Относительные пути, размеры и SHA-256 проверенных файлов.';
COMMENT ON COLUMN local_ai.installations.installed_at IS 'Время публикации готовой установки.';

CREATE TABLE IF NOT EXISTS local_ai.installation_operations (
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 255),
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 255),
  model_id text NOT NULL,
  record jsonb NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (operation_id, owner_id),
  CHECK (record->>'operationId' = operation_id AND record->>'ownerId' = owner_id
    AND record->>'modelId' = model_id)
);
CREATE INDEX IF NOT EXISTS installation_operations_model_idx ON local_ai.installation_operations(model_id, updated_at DESC);
COMMENT ON TABLE local_ai.installation_operations IS 'Метаданные состояния и прогресса установки без входных данных загрузки.';
COMMENT ON COLUMN local_ai.installation_operations.operation_id IS 'Идентификатор операции установки.';
COMMENT ON COLUMN local_ai.installation_operations.owner_id IS 'Доверенная область владельца операции.';
COMMENT ON COLUMN local_ai.installation_operations.model_id IS 'Идентификатор устанавливаемой модели.';
COMMENT ON COLUMN local_ai.installation_operations.record IS 'Закрытая запись InstallationOperation без тел запросов и ответов.';
COMMENT ON COLUMN local_ai.installation_operations.created_at IS 'Время принятия операции.';
COMMENT ON COLUMN local_ai.installation_operations.updated_at IS 'Время последнего перехода состояния или прогресса.';

CREATE TABLE IF NOT EXISTS local_ai.settings (
  model_id text PRIMARY KEY,
  idle_unload_seconds integer CHECK (idle_unload_seconds IS NULL OR idle_unload_seconds > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE local_ai.settings IS 'Сохранённые настройки простоя по модели; отсутствие строки означает значение по умолчанию.';
COMMENT ON COLUMN local_ai.settings.model_id IS 'Идентификатор записи каталога моделей.';
COMMENT ON COLUMN local_ai.settings.idle_unload_seconds IS 'Секунды до выгрузки; NULL отключает выгрузку по простою.';
COMMENT ON COLUMN local_ai.settings.updated_at IS 'Время последнего изменения настройки.';

CREATE TABLE IF NOT EXISTS local_ai.outbox (
  event_id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('reserved', 'pending', 'sending', 'failed')),
  event jsonb,
  reservation_operation_id text,
  recovery_seed jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retry_at timestamptz,
  claim_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  last_error_at timestamptz,
  CHECK ((state = 'reserved') = (event IS NULL)),
  CHECK ((state = 'reserved') = (recovery_seed IS NOT NULL)),
  CHECK ((state = 'reserved') = (reservation_operation_id IS NOT NULL)),
  CHECK ((state = 'sending' AND claim_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state <> 'sending' AND claim_token IS NULL AND lease_until IS NULL)),
  CHECK ((state = 'failed') OR retry_at IS NULL),
  CHECK (last_error_code IS NULL OR last_error_code IN ('HISTORY_UNAVAILABLE','HISTORY_REJECTED','DELIVERY_INTERNAL')),
  CHECK (event IS NULL OR (jsonb_typeof(event) = 'object' AND event->>'id' = event_id::text
    AND octet_length(event::text) <= 65536))
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_one_reservation_per_operation_idx
  ON local_ai.outbox(reservation_operation_id) WHERE state = 'reserved';
CREATE INDEX IF NOT EXISTS outbox_delivery_idx ON local_ai.outbox(state, retry_at, lease_until, created_at)
  WHERE state <> 'reserved';
COMMENT ON TABLE local_ai.outbox IS 'Ограниченная очередь только разрешённых метаданных для service_history; резерв завершения занимает слот заранее.';
COMMENT ON COLUMN local_ai.outbox.event_id IS 'Стабильный ID события, назначенный до его первой отправки.';
COMMENT ON COLUMN local_ai.outbox.state IS 'Состояние: резерв, ожидание, аренда доставки или постоянная/повторяемая ошибка.';
COMMENT ON COLUMN local_ai.outbox.event IS 'Закрытый объект разрешённого history event; отсутствует у записи-резерва.';
COMMENT ON COLUMN local_ai.outbox.reservation_operation_id IS 'ID активной операции; используется только для одноразового terminal reserve.';
COMMENT ON COLUMN local_ai.outbox.recovery_seed IS 'Только безопасные metadata для terminal interrupted при старте; не содержит запросов или результатов.';
COMMENT ON COLUMN local_ai.outbox.created_at IS 'Время создания события или резерва.';
COMMENT ON COLUMN local_ai.outbox.retry_at IS 'Время следующей попытки; NULL для постоянной ошибки.';
COMMENT ON COLUMN local_ai.outbox.claim_token IS 'Уникальный fencing token текущей аренды доставки.';
COMMENT ON COLUMN local_ai.outbox.lease_until IS 'Срок аренды; после него запись может получить новый claim token.';
COMMENT ON COLUMN local_ai.outbox.attempts IS 'Число выданных аренд доставки.';
COMMENT ON COLUMN local_ai.outbox.last_error_code IS 'Последний безопасный код ошибки без сообщения PostgreSQL или payload.';
COMMENT ON COLUMN local_ai.outbox.last_error_at IS 'Время последней ошибки доставки.';

INSERT INTO local_ai.migrations(version, name) VALUES (1, '001_local_ai_storage')
ON CONFLICT (version) DO NOTHING;
