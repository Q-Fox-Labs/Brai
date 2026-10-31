-- ABOUTME: Создаёт собственное версионное хранилище Каналов и устойчивые квитанции.
-- ABOUTME: Исторические данные append-only; runtime меняет только указатели текущих версий.
CREATE SCHEMA IF NOT EXISTS channels;
REVOKE ALL ON SCHEMA channels FROM PUBLIC;
CREATE TABLE IF NOT EXISTS channels.sys_channel_types (
 code text NOT NULL, version integer NOT NULL CHECK(version>0), name text NOT NULL, descriptor jsonb NOT NULL, PRIMARY KEY(code,version)
);
CREATE TABLE IF NOT EXISTS channels.channel_connections (
 id uuid PRIMARY KEY, owner_id text NOT NULL, type_code text NOT NULL, type_version integer NOT NULL,
 source_id text NOT NULL UNIQUE, bot_id text NOT NULL UNIQUE, current_version integer NOT NULL CHECK(current_version>0), body jsonb NOT NULL,
 UNIQUE(id,owner_id), FOREIGN KEY(type_code,type_version) REFERENCES channels.sys_channel_types(code,version)
);
CREATE TABLE IF NOT EXISTS channels.channel_connection_versions (
 connection_id uuid NOT NULL REFERENCES channels.channel_connections(id), version integer NOT NULL CHECK(version>0),
 effective_at timestamptz NOT NULL, actor_id text, reason text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(connection_id,version),
 UNIQUE(connection_id,effective_at)
);
CREATE TABLE IF NOT EXISTS channels.channels (
 id uuid PRIMARY KEY, owner_id text NOT NULL, connection_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('dialog','topic')),
 chat_id text NOT NULL, thread_id text, parent_id uuid REFERENCES channels.channels(id), current_version integer NOT NULL CHECK(current_version>0), body jsonb NOT NULL,
 FOREIGN KEY(connection_id,owner_id) REFERENCES channels.channel_connections(id,owner_id),
 CHECK((kind='dialog' AND thread_id IS NULL AND parent_id IS NULL) OR (kind='topic' AND thread_id IS NOT NULL)),
 UNIQUE NULLS NOT DISTINCT(connection_id,chat_id,thread_id)
);
CREATE TABLE IF NOT EXISTS channels.channel_versions (
 channel_id uuid NOT NULL REFERENCES channels.channels(id), version integer NOT NULL CHECK(version>0),
 effective_at timestamptz NOT NULL, actor_id text, reason text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(channel_id,version),
 UNIQUE(channel_id,effective_at)
);
CREATE TABLE IF NOT EXISTS channels.channel_resolutions (
 id uuid PRIMARY KEY, caller_id text NOT NULL, owner_id text NOT NULL, operation_id text NOT NULL,
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'), input jsonb NOT NULL, result jsonb NOT NULL,
 UNIQUE(caller_id,owner_id,operation_id)
);
CREATE TABLE IF NOT EXISTS channels.channel_operation_receipts (
 caller_id text NOT NULL, owner_id text NOT NULL, request_id uuid NOT NULL,
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'), body jsonb NOT NULL, PRIMARY KEY(caller_id,owner_id,request_id)
);
COMMENT ON TABLE channels.sys_channel_types IS 'Собственные данные Каналов: sys_channel_types';
COMMENT ON COLUMN channels.sys_channel_types.code IS 'Стабильный код типа';
COMMENT ON COLUMN channels.sys_channel_types.version IS 'Неизменяемая версия профиля';
COMMENT ON COLUMN channels.sys_channel_types.name IS 'Редактируемая владельцем подпись';
COMMENT ON COLUMN channels.sys_channel_types.descriptor IS 'Поставляемые схемы и capabilities';
COMMENT ON TABLE channels.channel_connections IS 'Собственные данные Каналов: channel_connections';
COMMENT ON COLUMN channels.channel_connections.id IS 'Устойчивый ID подключения';
COMMENT ON COLUMN channels.channel_connections.owner_id IS 'Владелец данных';
COMMENT ON COLUMN channels.channel_connections.type_code IS 'Код установленного профиля';
COMMENT ON COLUMN channels.channel_connections.type_version IS 'Версия установленного профиля';
COMMENT ON COLUMN channels.channel_connections.source_id IS 'Не переиспользуемый подтверждённый источник входа';
COMMENT ON COLUMN channels.channel_connections.bot_id IS 'Внешняя идентичность бота';
COMMENT ON COLUMN channels.channel_connections.current_version IS 'Текущая опубликованная версия';
COMMENT ON COLUMN channels.channel_connections.body IS 'Неизменяемая идентичность без секретов';
COMMENT ON TABLE channels.channel_connection_versions IS 'Собственные данные Каналов: channel_connection_versions';
COMMENT ON COLUMN channels.channel_connection_versions.connection_id IS 'Идентичность подключения';
COMMENT ON COLUMN channels.channel_connection_versions.version IS 'Порядковый номер версии';
COMMENT ON COLUMN channels.channel_connection_versions.effective_at IS 'Начало действия версии';
COMMENT ON COLUMN channels.channel_connection_versions.actor_id IS 'Заявленный инициатор';
COMMENT ON COLUMN channels.channel_connection_versions.reason IS 'Основание изменения';
COMMENT ON COLUMN channels.channel_connection_versions.body IS 'Полный DTO версии';
COMMENT ON TABLE channels.channels IS 'Собственные данные Каналов: channels';
COMMENT ON COLUMN channels.channels.id IS 'Устойчивый ID канала';
COMMENT ON COLUMN channels.channels.owner_id IS 'Владелец данных';
COMMENT ON COLUMN channels.channels.connection_id IS 'Подключение канала';
COMMENT ON COLUMN channels.channels.kind IS 'Диалог или конкретная тема';
COMMENT ON COLUMN channels.channels.chat_id IS 'Внешний ID чата строкой';
COMMENT ON COLUMN channels.channels.thread_id IS 'ID темы либо NULL для диалога';
COMMENT ON COLUMN channels.channels.parent_id IS 'Организационный родитель без наследования правил';
COMMENT ON COLUMN channels.channels.current_version IS 'Текущая опубликованная версия';
COMMENT ON COLUMN channels.channels.body IS 'Неизменяемые признаки канала';
COMMENT ON TABLE channels.channel_versions IS 'Собственные данные Каналов: channel_versions';
COMMENT ON COLUMN channels.channel_versions.channel_id IS 'Идентичность канала';
COMMENT ON COLUMN channels.channel_versions.version IS 'Порядковый номер версии';
COMMENT ON COLUMN channels.channel_versions.effective_at IS 'Начало действия версии';
COMMENT ON COLUMN channels.channel_versions.actor_id IS 'Заявленный инициатор';
COMMENT ON COLUMN channels.channel_versions.reason IS 'Основание изменения';
COMMENT ON COLUMN channels.channel_versions.body IS 'Полные настройки и правила';
COMMENT ON TABLE channels.channel_resolutions IS 'Собственные данные Каналов: channel_resolutions';
COMMENT ON COLUMN channels.channel_resolutions.id IS 'ID неизменяемого результата';
COMMENT ON COLUMN channels.channel_resolutions.caller_id IS 'Подтверждённый вызывающий';
COMMENT ON COLUMN channels.channel_resolutions.owner_id IS 'Область владельца';
COMMENT ON COLUMN channels.channel_resolutions.operation_id IS 'Устойчивый ключ разрешения';
COMMENT ON COLUMN channels.channel_resolutions.input_hash IS 'Хеш нормализованного запроса';
COMMENT ON COLUMN channels.channel_resolutions.input IS 'Минимальные признаки без текста и файлов';
COMMENT ON COLUMN channels.channel_resolutions.result IS 'Неизменяемый Resolution без credentialsRef';
COMMENT ON TABLE channels.channel_operation_receipts IS 'Собственные данные Каналов: channel_operation_receipts';
COMMENT ON COLUMN channels.channel_operation_receipts.caller_id IS 'Подтверждённый вызывающий';
COMMENT ON COLUMN channels.channel_operation_receipts.owner_id IS 'Область владельца';
COMMENT ON COLUMN channels.channel_operation_receipts.request_id IS 'Общий для операций ключ команды';
COMMENT ON COLUMN channels.channel_operation_receipts.input_hash IS 'Хеш операции и нормализованного запроса';
COMMENT ON COLUMN channels.channel_operation_receipts.body IS 'Результат COMMIT и неизменяемый факт для Истории';
REVOKE ALL ON ALL TABLES IN SCHEMA channels FROM PUBLIC;
