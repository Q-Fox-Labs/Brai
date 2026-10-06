-- ABOUTME: Создаёт собственные таблицы уведомлений, прочтений и системных справочников.
-- ABOUTME: Повтор сохраняет ручные названия и цвета; конфликт стабильных ID/code/category завершает миграцию.
CREATE SCHEMA IF NOT EXISTS alerts;
CREATE TABLE IF NOT EXISTS alerts.migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE IF NOT EXISTS alerts.sys_categories(
 id integer PRIMARY KEY CHECK(id>0),
 code text NOT NULL UNIQUE CHECK(code~'^[a-z][a-z0-9_]{0,63}$'),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
 description text NOT NULL CHECK(length(description)<=512),
 color text NOT NULL CHECK(color~'^#[0-9A-Fa-f]{6}$'),
 importance smallint NOT NULL CHECK(importance IN (1,2,3))
);
CREATE TABLE IF NOT EXISTS alerts.sys_types(
 id integer PRIMARY KEY CHECK(id>0),category_id integer NOT NULL REFERENCES alerts.sys_categories(id),
 code text NOT NULL UNIQUE CHECK(code~'^[a-z][a-z0-9_]{0,63}$'),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 128),description text NOT NULL CHECK(length(description)<=512)
);
CREATE TABLE IF NOT EXISTS alerts.notifications(
 id uuid NOT NULL,service_id text COLLATE "C" NOT NULL CHECK(length(service_id) BETWEEN 1 AND 255),
 type_id integer NOT NULL REFERENCES alerts.sys_types(id),scope_type text NOT NULL CHECK(scope_type IN ('user','system')),
 scope_id text NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 255),title text NOT NULL CHECK(length(title) BETWEEN 1 AND 256),
 text text NOT NULL CHECK(length(text)<=8192),data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(data)='object'),
 occurred_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(service_id,id),CHECK(scope_type<>'system' OR scope_id='global')
);
CREATE TABLE IF NOT EXISTS alerts.read_marks(
 user_id text NOT NULL CHECK(length(user_id) BETWEEN 1 AND 255),service_id text COLLATE "C" NOT NULL,id uuid NOT NULL,
 read_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(user_id,service_id,id),
 FOREIGN KEY(service_id,id) REFERENCES alerts.notifications(service_id,id)
);
ALTER TABLE alerts.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts.read_marks ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS alerts_notifications_order ON alerts.notifications(recorded_at DESC,service_id DESC,id DESC);
CREATE INDEX IF NOT EXISTS alerts_notifications_scope_order ON alerts.notifications(scope_type,scope_id,recorded_at DESC,service_id DESC,id DESC);
CREATE INDEX IF NOT EXISTS alerts_types_category ON alerts.sys_types(category_id,id);
COMMENT ON SCHEMA alerts IS 'Собственная база уведомлений; не использует таблицы истории или пользователей';
COMMENT ON TABLE alerts.migrations IS 'Атомарные миграции владельца уведомлений';
COMMENT ON COLUMN alerts.migrations.version IS 'Номер миграции';
COMMENT ON COLUMN alerts.migrations.applied_at IS 'Серверное время применения';
COMMENT ON TABLE alerts.sys_categories IS 'Системные категории: стабильны ID и code, редактируются владельцем';
COMMENT ON COLUMN alerts.sys_categories.id IS 'Стабильный ID категории';
COMMENT ON COLUMN alerts.sys_categories.code IS 'Стабильный код категории';
COMMENT ON COLUMN alerts.sys_categories.name IS 'Публичное название';
COMMENT ON COLUMN alerts.sys_categories.description IS 'Публичное описание';
COMMENT ON COLUMN alerts.sys_categories.color IS 'Цвет категории #RRGGBB; не заменяет смысл важности';
COMMENT ON COLUMN alerts.sys_categories.importance IS 'Важность: 3 критическая, 2 важная, 1 обычная';
COMMENT ON TABLE alerts.sys_types IS 'Системные типы: стабильны ID, code и category_id';
COMMENT ON COLUMN alerts.sys_types.id IS 'Стабильный ID типа';
COMMENT ON COLUMN alerts.sys_types.category_id IS 'Неизменяемая категория типа';
COMMENT ON COLUMN alerts.sys_types.code IS 'Стабильный код типа';
COMMENT ON COLUMN alerts.sys_types.name IS 'Публичное название';
COMMENT ON COLUMN alerts.sys_types.description IS 'Публичное описание';
COMMENT ON TABLE alerts.notifications IS 'Неизменяемые уведомления: общие записи хранятся один раз';
COMMENT ON COLUMN alerts.notifications.id IS 'UUID источника, сохраняется при повторе';
COMMENT ON COLUMN alerts.notifications.service_id IS 'Заявленный строковой ID источника; не удостоверенная личность';
COMMENT ON COLUMN alerts.notifications.type_id IS 'Тип из собственного справочника';
COMMENT ON COLUMN alerts.notifications.scope_type IS 'user для личных или system для общих';
COMMENT ON COLUMN alerts.notifications.scope_id IS 'Строковой пользовательский ID или global';
COMMENT ON COLUMN alerts.notifications.title IS 'Короткий заголовок';
COMMENT ON COLUMN alerts.notifications.text IS 'Текст уведомления';
COMMENT ON COLUMN alerts.notifications.data IS 'Дополнительный JSON-объект без секретов';
COMMENT ON COLUMN alerts.notifications.occurred_at IS 'Время события у источника';
COMMENT ON COLUMN alerts.notifications.recorded_at IS 'Время записи, назначенное PostgreSQL';
COMMENT ON TABLE alerts.read_marks IS 'Отдельные неизменяемые индивидуальные отметки прочтения';
COMMENT ON COLUMN alerts.read_marks.user_id IS 'Строковой ID пользователя; нет FK в чужую базу';
COMMENT ON COLUMN alerts.read_marks.service_id IS 'Источник уведомления';
COMMENT ON COLUMN alerts.read_marks.id IS 'UUID уведомления';
COMMENT ON COLUMN alerts.read_marks.read_at IS 'Время явной команды прочтения на сервере';
DO $seed$
DECLARE
 categories CONSTANT jsonb := '[{"id":1,"code":"critical","name":"Критические","description":"Требуют немедленного внимания","color":"#FF3B30","importance":3},{"id":2,"code":"important","name":"Важные","description":"Требуют внимания","color":"#FFC107","importance":2},{"id":3,"code":"standard","name":"Стандартные","description":"Результаты и сведения","color":"#22C55E","importance":1}]';
 types CONSTANT jsonb := '[{"id":1,"category_id":1,"code":"failure","name":"Сбой","description":"Операция завершилась с ошибкой"},{"id":2,"category_id":1,"code":"unavailable","name":"Недоступность","description":"Ресурс недоступен"},{"id":3,"category_id":2,"code":"attention_required","name":"Требуется внимание","description":"Необходимо действие пользователя"},{"id":4,"category_id":2,"code":"limit_approaching","name":"Приближение к лимиту","description":"Ресурс приближается к лимиту"},{"id":5,"category_id":3,"code":"completed","name":"Завершение","description":"Операция завершена"},{"id":6,"category_id":3,"code":"information","name":"Информация","description":"Информационное сообщение"}]';
 row jsonb;
BEGIN
 FOR row IN SELECT value FROM jsonb_array_elements(categories) LOOP
  IF EXISTS(SELECT 1 FROM alerts.sys_categories WHERE (id=(row->>'id')::int OR code=row->>'code') AND (id<>(row->>'id')::int OR code<>row->>'code')) THEN RAISE EXCEPTION 'ALERTS_SEED_CATEGORY_CONFLICT'; END IF;
  INSERT INTO alerts.sys_categories(id,code,name,description,color,importance) VALUES((row->>'id')::int,row->>'code',row->>'name',row->>'description',row->>'color',(row->>'importance')::int) ON CONFLICT(id) DO NOTHING;
 END LOOP;
 FOR row IN SELECT value FROM jsonb_array_elements(types) LOOP
  IF EXISTS(SELECT 1 FROM alerts.sys_types WHERE (id=(row->>'id')::int OR code=row->>'code') AND (id<>(row->>'id')::int OR code<>row->>'code' OR category_id<>(row->>'category_id')::int)) THEN RAISE EXCEPTION 'ALERTS_SEED_TYPE_CONFLICT'; END IF;
  INSERT INTO alerts.sys_types(id,category_id,code,name,description) VALUES((row->>'id')::int,(row->>'category_id')::int,row->>'code',row->>'name',row->>'description') ON CONFLICT(id) DO NOTHING;
 END LOOP;
END $seed$;
INSERT INTO alerts.migrations(version) VALUES(1) ON CONFLICT(version) DO NOTHING;
