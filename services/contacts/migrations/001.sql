-- ABOUTME: Создаёт собственные контакты, идентичности и неизменяемые квитанции.
-- ABOUTME: Не обращается к таблицам соседних сервисов и не удаляет историю.
CREATE SCHEMA IF NOT EXISTS contacts;
REVOKE ALL ON SCHEMA contacts FROM PUBLIC;
CREATE TABLE IF NOT EXISTS contacts.contacts (
 id uuid PRIMARY KEY, owner_id text NOT NULL, created_at timestamptz NOT NULL,
 UNIQUE(id,owner_id), CHECK(length(owner_id) BETWEEN 1 AND 255)
);
CREATE TABLE IF NOT EXISTS contacts.contact_identities (
 id uuid PRIMARY KEY, owner_id text NOT NULL, contact_id uuid NOT NULL UNIQUE,
 namespace text NOT NULL CHECK(namespace='telegram'),
 external_id text NOT NULL CHECK(external_id ~ '^[1-9][0-9]*$' AND length(external_id)<=255),
 name text CHECK(name IS NULL OR length(name) BETWEEN 1 AND 255),
 username text CHECK(username IS NULL OR length(username) BETWEEN 1 AND 255),
 photo_artifact_id uuid, field_origins jsonb NOT NULL,
 first_observed_at timestamptz NOT NULL, last_observed_at timestamptz NOT NULL,
 UNIQUE(owner_id,namespace,external_id),
 FOREIGN KEY(contact_id,owner_id) REFERENCES contacts.contacts(id,owner_id),
 CHECK(first_observed_at<=last_observed_at)
);
CREATE TABLE IF NOT EXISTS contacts.contact_operations (
 caller_id text NOT NULL, owner_id text NOT NULL, operation_id text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('resolve','profile.observe')),
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 request jsonb NOT NULL, result jsonb NOT NULL, committed_at timestamptz NOT NULL,
 history_events jsonb NOT NULL, PRIMARY KEY(caller_id,owner_id,operation_id)
);
COMMENT ON SCHEMA contacts IS 'Данные только сервиса Контактов';
COMMENT ON TABLE contacts.contacts IS 'Устойчивый контакт владельца';
COMMENT ON TABLE contacts.contact_identities IS 'Внешний аккаунт и актуальная проекция наблюдений';
COMMENT ON TABLE contacts.contact_operations IS 'Неизменяемые первоначальные результаты и готовые факты Истории';
DO $comments$
DECLARE row record;
BEGIN
 FOR row IN SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='contacts'
 LOOP
  EXECUTE format('COMMENT ON COLUMN contacts.%I.%I IS %L',row.table_name,row.column_name,
   CASE row.column_name
   WHEN 'id' THEN 'Собственный UUID записи' WHEN 'owner_id' THEN 'Владелец пространства данных'
   WHEN 'created_at' THEN 'Время создания по часам БД' WHEN 'contact_id' THEN 'Принадлежность устойчивому контакту'
   WHEN 'namespace' THEN 'Пространство внешних ID: telegram' WHEN 'external_id' THEN 'Telegram User ID, не ID бота'
   WHEN 'name' THEN 'Текущее имя; null может означать отсутствие наблюдения' WHEN 'username' THEN 'Текущий username, не ключ сопоставления'
   WHEN 'photo_artifact_id' THEN 'Непрозрачная ссылка на проверенный артефакт владельца'
   WHEN 'field_origins' THEN 'Происхождение каждого поля, включая явно наблюдённый null'
   WHEN 'first_observed_at' THEN 'Минимальное время принятого наблюдения' WHEN 'last_observed_at' THEN 'Максимальное время принятого наблюдения'
   WHEN 'caller_id' THEN 'Защищённая привязка NATS вызывающего' WHEN 'operation_id' THEN 'Устойчивый ключ предметной операции'
   WHEN 'operation' THEN 'Вид принятой операции' WHEN 'input_hash' THEN 'SHA-256 нормализованного запроса'
   WHEN 'request' THEN 'Минимальный исходный нормализованный запрос' WHEN 'result' THEN 'Первоначальный неизменяемый результат'
   WHEN 'committed_at' THEN 'Время принятия изменения по часам БД' WHEN 'history_events' THEN 'Готовые неизменяемые append-запросы Истории'
   END);
 END LOOP;
END $comments$;
