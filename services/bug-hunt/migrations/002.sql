-- ABOUTME: Добавляет локальный индекс, группы и неизменяемые ручные решения.
-- ABOUTME: Не меняет исходные v1 записи и не требует моделей или расширений PostgreSQL.
CREATE TABLE IF NOT EXISTS sys_capability(
 capability text PRIMARY KEY,version integer NOT NULL CHECK(version>0),applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO sys_capability(capability,version) VALUES('local-systematization',2) ON CONFLICT DO NOTHING;
DO $capability$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM sys_capability WHERE capability='local-systematization' AND version=2) THEN
  RAISE EXCEPTION 'CAPABILITY_VERSION_CONFLICT';
 END IF;
END $capability$;
CREATE UNIQUE INDEX IF NOT EXISTS report_system_scope ON report(id,case_id,owner_id,installation_id);
CREATE TABLE IF NOT EXISTS search_document(
 installation_id text NOT NULL,owner_id text NOT NULL,report_id uuid NOT NULL,case_id uuid NOT NULL,
 projection_version text NOT NULL,text text NOT NULL,document tsvector NOT NULL,source_hash text NOT NULL,
 PRIMARY KEY(installation_id,owner_id,report_id,projection_version),
 FOREIGN KEY(case_id,owner_id,installation_id) REFERENCES bug_case(id,owner_id,installation_id),
 FOREIGN KEY(report_id,case_id,owner_id,installation_id) REFERENCES report(id,case_id,owner_id,installation_id),
 UNIQUE(installation_id,owner_id,case_id,projection_version)
);
CREATE INDEX IF NOT EXISTS search_document_text ON search_document USING gin(document);
CREATE TABLE IF NOT EXISTS observation_group(
 id uuid PRIMARY KEY,installation_id text NOT NULL,owner_id text NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 signature_hash text,signature_canonical text,created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 UNIQUE(id,owner_id,installation_id),UNIQUE(installation_id,owner_id,signature_hash),
 CHECK((signature_hash IS NULL)=(signature_canonical IS NULL))
);
CREATE TABLE IF NOT EXISTS report_signature(
 installation_id text NOT NULL,owner_id text NOT NULL,report_id uuid NOT NULL,case_id uuid NOT NULL,
 algorithm_version text NOT NULL,signature_hash text,canonical text,
 PRIMARY KEY(installation_id,owner_id,report_id,algorithm_version),
 FOREIGN KEY(report_id,case_id,owner_id,installation_id) REFERENCES report(id,case_id,owner_id,installation_id),
 FOREIGN KEY(case_id,owner_id,installation_id) REFERENCES bug_case(id,owner_id,installation_id),
 CHECK((signature_hash IS NULL)=(canonical IS NULL))
);
CREATE TABLE IF NOT EXISTS group_membership(
 installation_id text NOT NULL,owner_id text NOT NULL,case_id uuid NOT NULL,group_id uuid NOT NULL,
 method text NOT NULL CHECK(method IN('exact','manual')),registered_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 PRIMARY KEY(installation_id,owner_id,case_id),
 FOREIGN KEY(case_id,owner_id,installation_id) REFERENCES bug_case(id,owner_id,installation_id),
 FOREIGN KEY(group_id,owner_id,installation_id) REFERENCES observation_group(id,owner_id,installation_id)
);
CREATE INDEX IF NOT EXISTS group_membership_group ON group_membership(installation_id,owner_id,group_id,case_id);
CREATE TABLE IF NOT EXISTS grouping_decision(
 id uuid PRIMARY KEY,installation_id text NOT NULL,owner_id text NOT NULL,case_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),excluded_from_auto boolean NOT NULL,actor_id text NOT NULL,explanation text NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 FOREIGN KEY(case_id,owner_id,installation_id) REFERENCES bug_case(id,owner_id,installation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS grouping_decision_latest ON grouping_decision(installation_id,owner_id,case_id,revision DESC);
CREATE TABLE IF NOT EXISTS group_audit(
 id uuid PRIMARY KEY,installation_id text NOT NULL,owner_id text NOT NULL,group_id uuid NOT NULL,actor_id text NOT NULL,
 operation text NOT NULL,explanation text NOT NULL,old_revision integer NOT NULL,new_revision integer NOT NULL,
 case_ids uuid[] NOT NULL,registered_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 FOREIGN KEY(group_id,owner_id,installation_id) REFERENCES observation_group(id,owner_id,installation_id),
 UNIQUE(group_id,new_revision),CHECK(new_revision=old_revision+1)
);
CREATE INDEX IF NOT EXISTS group_audit_page ON group_audit(installation_id,owner_id,group_id,registered_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS similarity_proposal(
 id uuid PRIMARY KEY,installation_id text NOT NULL,owner_id text NOT NULL,case_id uuid NOT NULL,candidate_case_id uuid NOT NULL,
 generation text NOT NULL,method text NOT NULL,score double precision NOT NULL CHECK(score BETWEEN -1 AND 1),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','accepted','rejected','stale')),
 registered_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 FOREIGN KEY(case_id,owner_id,installation_id) REFERENCES bug_case(id,owner_id,installation_id),
 FOREIGN KEY(candidate_case_id,owner_id,installation_id) REFERENCES bug_case(id,owner_id,installation_id),
 UNIQUE(installation_id,owner_id,case_id,candidate_case_id,generation),CHECK(case_id<>candidate_case_id)
);
-- AIDEV-NOTE: Рабочий writer держит scoped lock; trigger также защищает предел от другого writer.
CREATE OR REPLACE FUNCTION bug_hunt_proposal_limit() RETURNS trigger LANGUAGE plpgsql AS $limit$
BEGIN
 IF NEW.state='pending' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.installation_id||':'||NEW.owner_id||':'||NEW.case_id::text||':'||NEW.generation,31));
  IF (SELECT count(*) FROM similarity_proposal WHERE installation_id=NEW.installation_id AND owner_id=NEW.owner_id
   AND case_id=NEW.case_id AND generation=NEW.generation AND state='pending' AND id<>NEW.id)>=20 THEN
   RAISE EXCEPTION 'PROPOSAL_LIMIT' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $limit$;
DROP TRIGGER IF EXISTS bug_hunt_proposal_limit ON similarity_proposal;
CREATE TRIGGER bug_hunt_proposal_limit BEFORE INSERT OR UPDATE ON similarity_proposal FOR EACH ROW EXECUTE FUNCTION bug_hunt_proposal_limit();
CREATE TABLE IF NOT EXISTS classification(
 id uuid PRIMARY KEY,installation_id text NOT NULL,owner_id text NOT NULL,report_id uuid NOT NULL,case_id uuid NOT NULL,
 generation text NOT NULL,input_hash text NOT NULL,model_id text NOT NULL,model_revision text NOT NULL,
 profile_id text NOT NULL,question_version text NOT NULL,projection_version text NOT NULL,payload jsonb NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 FOREIGN KEY(case_id,owner_id,installation_id) REFERENCES bug_case(id,owner_id,installation_id),
 FOREIGN KEY(report_id,case_id,owner_id,installation_id) REFERENCES report(id,case_id,owner_id,installation_id),
 UNIQUE(installation_id,owner_id,report_id,generation,input_hash)
);
CREATE TABLE IF NOT EXISTS classification_override(
 id uuid PRIMARY KEY,installation_id text NOT NULL,owner_id text NOT NULL,case_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 actor_id text NOT NULL,labels jsonb NOT NULL,explanation text NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
 FOREIGN KEY(case_id,owner_id,installation_id) REFERENCES bug_case(id,owner_id,installation_id),
 UNIQUE(installation_id,owner_id,case_id,revision)
);
CREATE TABLE IF NOT EXISTS v2_mutation(
 installation_id text NOT NULL,owner_id text NOT NULL,actor_id text NOT NULL,operation text NOT NULL,
 request_id text NOT NULL,input_hash text NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(installation_id,owner_id,actor_id,operation,request_id)
);
DO $comments$
DECLARE r record;
BEGIN
 FOR r IN SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN(
 'sys_capability','search_document','report_signature','observation_group','group_membership','grouping_decision',
 'group_audit','similarity_proposal','classification','classification_override','v2_mutation')
 LOOP
  EXECUTE format('COMMENT ON TABLE %I IS %L',r.table_name,CASE r.table_name
   WHEN 'sys_capability' THEN 'Фактически применённые возможности схемы; не готовность моделей'
   WHEN 'search_document' THEN 'Пересоздаваемая полная локальная текстовая проекция'
   WHEN 'report_signature' THEN 'Версионные scoped сигнатуры; hash требует сравнения canonical'
   WHEN 'observation_group' THEN 'Стабильные группы наблюдений одного владельца и установки'
   WHEN 'group_membership' THEN 'Текущее единственное членство исходной карточки'
   WHEN 'grouping_decision' THEN 'Неизменяемые ручные исключения автоматической группировки'
   WHEN 'group_audit' THEN 'Неизменяемый аудит версий состава группы'
   WHEN 'similarity_proposal' THEN 'До двадцати pending предложений на карточку и поколение'
   WHEN 'classification' THEN 'Неизменяемые модельные предположения; не проверка дефекта'
   WHEN 'classification_override' THEN 'Неизменяемые ручные поправки меток с собственной revision'
   ELSE 'Неизменяемые первоначальные квитанции отдельного v2 пространства повторов' END);
  EXECUTE format('COMMENT ON COLUMN %I.%I IS %L',r.table_name,r.column_name,
   CASE r.column_name WHEN 'owner_id' THEN 'Канонический владелец; все связи ограничены scope'
   WHEN 'installation_id' THEN 'Стабильная установка; данные не соединяются между установками'
   WHEN 'canonical' THEN 'Точная каноническая сигнатура для проверки совпадения hash'
   WHEN 'source_hash' THEN 'SHA-256 неизменённой поисковой проекции'
   WHEN 'revision' THEN 'Версия для конкурентного ручного изменения'
   WHEN 'result' THEN 'Исходная квитанция принятия; повтор не переписывает её'
   WHEN 'payload' THEN 'Исходные допустимые модельные ответы, provenance и ограничения'
   ELSE 'Поле '||r.column_name||' объекта '||r.table_name END);
 END LOOP;
END $comments$;
