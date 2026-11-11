-- ABOUTME: Добавляет независимые поколения embedding без изменения исходников и intent.
-- ABOUTME: Старое поколение остаётся активным до явной проверенной операторской активации.
ALTER TABLE processing_job ADD COLUMN IF NOT EXISTS index_generation text NOT NULL DEFAULT 'gemma2-symmetric-v1';
DO $keys$
DECLARE constraint_name text;
BEGIN
 FOR constraint_name IN SELECT conname FROM pg_constraint
 WHERE conrelid='processing_job'::regclass AND contype='u'
 AND pg_get_constraintdef(oid)='UNIQUE (installation_id, owner_id, report_id, pipeline_version, branch)'
 LOOP EXECUTE format('ALTER TABLE processing_job DROP CONSTRAINT %I',constraint_name); END LOOP;
END $keys$;
CREATE UNIQUE INDEX IF NOT EXISTS processing_job_generation_key ON processing_job(installation_id,owner_id,report_id,pipeline_version,branch,index_generation);
CREATE TABLE IF NOT EXISTS embedding_generation(
 installation_id text NOT NULL,generation text NOT NULL CHECK(generation ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),registered_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(installation_id,generation)
);
CREATE TABLE IF NOT EXISTS embedding_generation_control(
 installation_id text PRIMARY KEY,active_generation text NOT NULL,activation_revision integer NOT NULL DEFAULT 0 CHECK(activation_revision>=0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(installation_id,active_generation) REFERENCES embedding_generation(installation_id,generation)
);
CREATE TABLE IF NOT EXISTS embedding_generation_activation(
 id uuid PRIMARY KEY,installation_id text NOT NULL,generation text NOT NULL,previous_generation text NOT NULL,
 activation_revision integer NOT NULL CHECK(activation_revision>0),actor_id text NOT NULL,reason text NOT NULL,
 total_reports integer NOT NULL CHECK(total_reports>=0),indexed_reports integer NOT NULL CHECK(indexed_reports=total_reports),
 registered_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(installation_id,generation) REFERENCES embedding_generation(installation_id,generation),
 FOREIGN KEY(installation_id,previous_generation) REFERENCES embedding_generation(installation_id,generation),
 UNIQUE(installation_id,activation_revision)
);
COMMENT ON COLUMN processing_job.index_generation IS 'Поколение embedding; для local/classification неизменный legacy ключ, не версия модели';
COMMENT ON TABLE embedding_generation IS 'Неизменяемые точные метаданные поколения embedding; старые поколения сохраняются';
COMMENT ON COLUMN embedding_generation.installation_id IS 'Установка, входящая в область изоляции';
COMMENT ON COLUMN embedding_generation.generation IS 'Стабильное имя поколения, заданное защищённой конфигурацией';
COMMENT ON COLUMN embedding_generation.metadata IS 'Точные model/revision/profile, projection/chunking/purpose/dimensions/pipeline';
COMMENT ON COLUMN embedding_generation.registered_at IS 'Время первой подготовки поколения';
COMMENT ON TABLE embedding_generation_control IS 'Активный указатель; build не меняет его автоматически';
COMMENT ON COLUMN embedding_generation_control.installation_id IS 'Установка, входящая в область изоляции';
COMMENT ON COLUMN embedding_generation_control.active_generation IS 'Единственное поколение для пользовательского similar';
COMMENT ON COLUMN embedding_generation_control.activation_revision IS 'Монотонная версия переключения для инвалидирования signed cursor';
COMMENT ON COLUMN embedding_generation_control.updated_at IS 'Время последнего явного переключения';
COMMENT ON TABLE embedding_generation_activation IS 'Неизменяемый аудит проверенного явного переключения поколения';
COMMENT ON COLUMN embedding_generation_activation.id IS 'Стабильный UUID действия';
COMMENT ON COLUMN embedding_generation_activation.installation_id IS 'Установка, входящая в область изоляции';
COMMENT ON COLUMN embedding_generation_activation.generation IS 'Активированное поколение';
COMMENT ON COLUMN embedding_generation_activation.previous_generation IS 'Предыдущее активное поколение, сохраняемое для отката';
COMMENT ON COLUMN embedding_generation_activation.activation_revision IS 'Порядковая версия активации в установке';
COMMENT ON COLUMN embedding_generation_activation.actor_id IS 'Проверенный оператор из доверенного транспорта';
COMMENT ON COLUMN embedding_generation_activation.reason IS 'Обязательное объяснение явного переключения';
COMMENT ON COLUMN embedding_generation_activation.total_reports IS 'Весь корпус установки при проверке активации';
COMMENT ON COLUMN embedding_generation_activation.indexed_reports IS 'Проверенный полный корпус, равен total_reports';
COMMENT ON COLUMN embedding_generation_activation.registered_at IS 'Время фиксации действия';
INSERT INTO sys_capability(capability,version) VALUES('embedding-generations',4) ON CONFLICT DO NOTHING;
DO $capability$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM sys_capability WHERE capability='embedding-generations' AND version=4) THEN RAISE EXCEPTION 'CAPABILITY_VERSION_CONFLICT'; END IF;
END $capability$;
-- Существующие векторы доступны сразу после upgrade, даже при выключенном worker.
INSERT INTO embedding_generation(installation_id,generation,metadata)
SELECT DISTINCT installation_id,'gemma2-symmetric-v1',
 '{"model_id":"embeddinggemma-2-q8","model_revision":"bfcd298762cc34d0357ece5ebdd31791a3a374d8","profile_id":"embeddinggemma2_llama_cpp","projection_version":"1","chunking_version":"utf8-1200-64-65536-v1","purpose":"symmetric","dimensions":768,"pipeline_version":"2"}'::jsonb
FROM report ON CONFLICT DO NOTHING;
INSERT INTO embedding_generation_control(installation_id,active_generation)
SELECT installation_id,generation FROM embedding_generation WHERE generation='gemma2-symmetric-v1'
ON CONFLICT DO NOTHING;
