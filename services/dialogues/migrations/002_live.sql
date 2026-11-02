-- ABOUTME: Добавляет live-хранилище прямого MCP отдельно от прежнего импорта.
-- ABOUTME: Не изменяет таблицы и права архивной схемы dialogues.
CREATE SCHEMA IF NOT EXISTS dialogues_live;
CREATE SEQUENCE IF NOT EXISTS dialogues_live.change_seq;
CREATE TABLE IF NOT EXISTS dialogues_live.migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS dialogues_live.dialogues(
 owner_id text NOT NULL,id text NOT NULL,channel text NOT NULL,title text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner_id,id)
);
CREATE TABLE IF NOT EXISTS dialogues_live.turns(
 owner_id text NOT NULL,dialogue_id text NOT NULL,id text NOT NULL,turn_order bigint NOT NULL,
 status text NOT NULL CHECK(status IN('in_progress','completed','interrupted','failed')),
 completion_seq bigint,change_seq bigint NOT NULL,
 PRIMARY KEY(owner_id,dialogue_id,id),UNIQUE(owner_id,dialogue_id,turn_order),
 FOREIGN KEY(owner_id,dialogue_id) REFERENCES dialogues_live.dialogues(owner_id,id)
);
CREATE TABLE IF NOT EXISTS dialogues_live.messages(
 owner_id text NOT NULL,dialogue_id text NOT NULL,turn_id text NOT NULL,id text NOT NULL,
 role text NOT NULL CHECK(role IN('user','assistant')),kind text NOT NULL CHECK(kind IN('input','commentary','final')),
 message_order bigint NOT NULL,item_order bigint NOT NULL,text text NOT NULL,payload jsonb NOT NULL,
 content_hash text NOT NULL,occurred_at timestamptz,source jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT now(),
 change_seq bigint NOT NULL,
 PRIMARY KEY(owner_id,dialogue_id,id),UNIQUE(owner_id,dialogue_id,message_order),
 FOREIGN KEY(owner_id,dialogue_id,turn_id) REFERENCES dialogues_live.turns(owner_id,dialogue_id,id),
 CHECK((role='user')=(kind='input'))
);
CREATE INDEX IF NOT EXISTS messages_turn ON dialogues_live.messages(owner_id,dialogue_id,turn_id,message_order);
CREATE INDEX IF NOT EXISTS messages_change ON dialogues_live.messages(owner_id,change_seq);
CREATE TABLE IF NOT EXISTS dialogues_live.message_summaries(
 owner_id text NOT NULL,dialogue_id text NOT NULL,message_id text NOT NULL,version bigint NOT NULL,
 text text NOT NULL,source_hash text NOT NULL,change_seq bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,dialogue_id,message_id,version),
 FOREIGN KEY(owner_id,dialogue_id,message_id) REFERENCES dialogues_live.messages(owner_id,dialogue_id,id)
);
CREATE TABLE IF NOT EXISTS dialogues_live.dialogue_summaries(
 owner_id text NOT NULL,dialogue_id text NOT NULL,version bigint NOT NULL,text text NOT NULL,
 through_message_id text NOT NULL,through_order bigint NOT NULL,change_seq bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,dialogue_id,version),
 FOREIGN KEY(owner_id,dialogue_id,through_message_id) REFERENCES dialogues_live.messages(owner_id,dialogue_id,id)
);
CREATE TABLE IF NOT EXISTS dialogues_live.requests(
 owner_id text NOT NULL,id text NOT NULL,operation text NOT NULL,hash text NOT NULL,result jsonb NOT NULL,change_seq bigint NOT NULL,
 PRIMARY KEY(owner_id,id)
);
COMMENT ON SCHEMA dialogues_live IS 'Прямое live-хранилище MCP Диалогов; архив dialogues не изменяется';
COMMENT ON TABLE dialogues_live.dialogues IS 'Беседы владельца';
COMMENT ON TABLE dialogues_live.turns IS 'Ходы: обращение, дополнения и итог';
COMMENT ON TABLE dialogues_live.messages IS 'Неизменяемые публичные тексты и происхождение';
COMMENT ON TABLE dialogues_live.message_summaries IS 'Версии коротких представлений сообщений';
COMMENT ON TABLE dialogues_live.dialogue_summaries IS 'Версии свёрток бесед с точным покрытием';
COMMENT ON TABLE dialogues_live.requests IS 'Служебные квитанции безопасных повторов';
COMMENT ON TABLE dialogues_live.migrations IS 'Служебный журнал owner-миграций live';
DO $comments$
DECLARE c record; purpose text;
BEGIN
 FOR c IN SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='dialogues_live' LOOP
 purpose:=CASE c.column_name
 WHEN 'owner_id' THEN 'Владелец из доверенной конфигурации MCP'
 WHEN 'id' THEN 'Устойчивый идентификатор записи'
 WHEN 'dialogue_id' THEN 'Точная ссылка на беседу владельца'
 WHEN 'turn_id' THEN 'Точная ссылка на ход беседы'
 WHEN 'message_id' THEN 'Точная ссылка на исходное сообщение'
 WHEN 'channel' THEN 'Канал происхождения беседы'
 WHEN 'title' THEN 'Название беседы для чтения'
 WHEN 'status' THEN 'Известное состояние хода'
 WHEN 'turn_order' THEN 'Порядок хода внутри беседы'
 WHEN 'message_order' THEN 'Порядок сообщения внутри беседы'
 WHEN 'item_order' THEN 'Исходный порядок элемента внутри хода'
 WHEN 'role' THEN 'Роль автора публичного сообщения'
 WHEN 'kind' THEN 'Вход, промежуточный ответ либо итог'
 WHEN 'text' THEN 'Точный исходный текст либо отдельный производный пересказ'
 WHEN 'payload' THEN 'Нормализованный исходный пакет для проверки повтора'
 WHEN 'content_hash' THEN 'SHA256 неизменяемого содержимого сообщения'
 WHEN 'source_hash' THEN 'SHA256 исходного сообщения саммари'
 WHEN 'source' THEN 'Заявленное происхождение и ссылки без бинарных вложений'
 WHEN 'occurred_at' THEN 'Точное время сообщения, если известно в источнике'
 WHEN 'recorded_at' THEN 'Время сохранения PostgreSQL, не время сообщения'
 WHEN 'created_at' THEN 'Время создания версии PostgreSQL'
 WHEN 'version' THEN 'Последовательная версия производной записи'
 WHEN 'completion_seq' THEN 'Первая подтверждённая запись итога хода'
 WHEN 'change_seq' THEN 'Порядок изменения под транзакционной блокировкой владельца'
 WHEN 'through_message_id' THEN 'Последнее сообщение покрытого префикса беседы'
 WHEN 'through_order' THEN 'Порядок последнего сообщения покрытого префикса'
 WHEN 'operation' THEN 'Операция исходного запроса'
 WHEN 'hash' THEN 'SHA256 исходного запроса для безопасного повтора'
 WHEN 'result' THEN 'Исходная квитанция операции'
 WHEN 'applied_at' THEN 'Время применения owner-миграции'
 ELSE 'Служебное поле live-хранилища'
 END;
 EXECUTE format('COMMENT ON COLUMN dialogues_live.%I.%I IS %L',c.table_name,c.column_name,purpose);
 END LOOP;
END $comments$;
INSERT INTO dialogues_live.migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
