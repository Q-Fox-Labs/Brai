-- ABOUTME: Создаёт собственную схему bug-hunt с неизменяемыми наблюдениями и аудитом.
-- ABOUTME: Миграция запускается владельцем отдельно; runtime получает только ограниченные DML-права.
CREATE TABLE IF NOT EXISTS sys_schema(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS bug_case(
 id uuid PRIMARY KEY, owner_id text NOT NULL, installation_id text NOT NULL,
 title text NOT NULL, component_id text NOT NULL, source text NOT NULL CHECK(source IN('codex','hermes','web')),
 review_state text NOT NULL DEFAULT 'new' CHECK(review_state IN('new','triaged','archived')),
 verification_status text NOT NULL DEFAULT 'unverified' CHECK(verification_status='unverified'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 registered_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 UNIQUE(id,owner_id,installation_id)
);
CREATE TABLE IF NOT EXISTS report(
 id uuid PRIMARY KEY,case_id uuid NOT NULL,owner_id text NOT NULL,installation_id text NOT NULL,
 actor_id text NOT NULL,observation jsonb NOT NULL,registered_at timestamptz NOT NULL,
 FOREIGN KEY(case_id,owner_id,installation_id) REFERENCES bug_case(id,owner_id,installation_id),
 UNIQUE(case_id)
);
CREATE TABLE IF NOT EXISTS review(
 id uuid PRIMARY KEY,case_id uuid NOT NULL,installation_id text NOT NULL,owner_id text NOT NULL,
 actor_id text NOT NULL,explanation text NOT NULL,old_state text NOT NULL,new_state text NOT NULL,
 old_revision integer NOT NULL,new_revision integer NOT NULL,registered_at timestamptz NOT NULL,
 FOREIGN KEY(case_id,owner_id,installation_id) REFERENCES bug_case(id,owner_id,installation_id),
 UNIQUE(case_id,new_revision),CHECK(new_revision=old_revision+1)
);
CREATE TABLE IF NOT EXISTS mutation(
 installation_id text NOT NULL,owner_id text NOT NULL,actor_id text NOT NULL,operation text NOT NULL,
 request_id text NOT NULL,input_hash text NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(installation_id,owner_id,actor_id,operation,request_id)
);
CREATE INDEX IF NOT EXISTS bug_case_owner_page ON bug_case(installation_id,owner_id,registered_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS bug_case_operator_page ON bug_case(installation_id,registered_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS bug_case_state_page ON bug_case(installation_id,review_state,registered_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS bug_case_component_page ON bug_case(installation_id,component_id,registered_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS bug_case_source_page ON bug_case(installation_id,source,registered_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS report_actor_time ON report(installation_id,actor_id,registered_at DESC);
CREATE INDEX IF NOT EXISTS review_case_page ON review(installation_id,case_id,registered_at DESC,id DESC);
INSERT INTO sys_schema(version) VALUES(1) ON CONFLICT DO NOTHING;
COMMENT ON TABLE sys_schema IS 'Применённая схема bug-hunt';
COMMENT ON TABLE bug_case IS 'Карточки ручного разбора непроверенных наблюдений';
COMMENT ON TABLE report IS 'Неизменяемые исходные наблюдения владельцев';
COMMENT ON TABLE review IS 'Неизменяемые ручные решения с версиями карточек';
COMMENT ON TABLE mutation IS 'Сохранённые первоначальные квитанции и ключи повторов';
DO $comments$
DECLARE r record;
BEGIN
 FOR r IN SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN('sys_schema','bug_case','report','review','mutation')
 LOOP EXECUTE format('COMMENT ON COLUMN %I.%I IS %L',r.table_name,r.column_name,
  CASE r.column_name WHEN 'owner_id' THEN 'Канонический владелец Brai из доверенного контекста' WHEN 'installation_id' THEN 'Стабильное происхождение установки' WHEN 'actor_id' THEN 'Стабильный доверенный инициатор' WHEN 'request_id' THEN 'Неизменяемый ключ повтора инициатора' WHEN 'input_hash' THEN 'SHA-256 канонического предметного входа' WHEN 'observation' THEN 'Исходное наблюдение без редактирования' WHEN 'result' THEN 'Квитанция первоначального принятия' WHEN 'verification_status' THEN 'Всегда unverified в первом этапе' WHEN 'registered_at' THEN 'Серверное время регистрации' WHEN 'revision' THEN 'Версия конкурентного ручного разбора' ELSE 'Поле '||r.column_name||' объекта '||r.table_name END);
 END LOOP;
END $comments$;
