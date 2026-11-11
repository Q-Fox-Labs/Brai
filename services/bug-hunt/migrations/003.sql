-- ABOUTME: Создаёт устойчивую очередь, попытки, бюджеты и векторы bug-hunt.
-- ABOUTME: Требует уже установленный pgvector; runtime не выполняет DDL и не меняет исходные report.
DO $extension$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector') THEN RAISE EXCEPTION 'VECTOR_EXTENSION_REQUIRED'; END IF;
END $extension$;
CREATE TABLE IF NOT EXISTS processing_job(
 id uuid PRIMARY KEY,installation_id text NOT NULL,owner_id text NOT NULL,report_id uuid NOT NULL,case_id uuid NOT NULL,
 branch text NOT NULL CHECK(branch IN('local','embedding','classification')),pipeline_version text NOT NULL,input_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','waiting_dependency','succeeded','blocked_policy','input_too_large','outcome_unknown','failed','budget_exhausted')),
 lease_until timestamptz,fence integer NOT NULL DEFAULT 0 CHECK(fence>=0),available_at timestamptz NOT NULL DEFAULT now(),
 priority text NOT NULL CHECK(priority IN('new','backfill')),technical_attempts integer NOT NULL DEFAULT 0 CHECK(technical_attempts>=0),
 business_attempt_id uuid NOT NULL,retry_reason text,code text,coverage text CHECK(coverage IN('complete','partial')),
 claimed_at timestamptz,registered_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(report_id,case_id,owner_id,installation_id) REFERENCES report(id,case_id,owner_id,installation_id),
 UNIQUE(installation_id,owner_id,report_id,pipeline_version,branch),UNIQUE(id,owner_id,installation_id)
);
CREATE INDEX IF NOT EXISTS processing_job_ready ON processing_job(installation_id,state,available_at,priority,registered_at);
CREATE TABLE IF NOT EXISTS processing_attempt(
 id uuid PRIMARY KEY,job_id uuid NOT NULL,installation_id text NOT NULL,owner_id text NOT NULL,
 business_attempt_id uuid NOT NULL,unit integer NOT NULL CHECK(unit BETWEEN 0 AND 63),
 operation_id uuid NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=131072),body_hash text NOT NULL,input_hash text NOT NULL,
 deadline_at timestamptz NOT NULL,model_id text NOT NULL,model_revision text NOT NULL,profile_id text NOT NULL,
 question_version text,projection_version text NOT NULL,metadata jsonb NOT NULL,
 phase text NOT NULL CHECK(phase IN('dispatching','succeeded','not_sent','failed','outcome_unknown')),
 result jsonb CHECK(result IS NULL OR octet_length(result::text)<=131072),usage jsonb,
 registered_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 FOREIGN KEY(job_id,owner_id,installation_id) REFERENCES processing_job(id,owner_id,installation_id),
 UNIQUE(installation_id,owner_id,operation_id),UNIQUE(id,owner_id,installation_id)
);
CREATE INDEX IF NOT EXISTS processing_attempt_job ON processing_attempt(job_id,business_attempt_id,unit,registered_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS processing_budget(
 installation_id text NOT NULL,branch text NOT NULL CHECK(branch IN('embedding','classification')),budget_day date NOT NULL,
 scope text NOT NULL CHECK(scope IN('owner','global')),owner_key text NOT NULL,reserved_calls integer NOT NULL DEFAULT 0 CHECK(reserved_calls>=0),
 PRIMARY KEY(installation_id,branch,budget_day,scope,owner_key),CHECK(scope<>'global' OR owner_key='')
);
CREATE TABLE IF NOT EXISTS processing_control(
 installation_id text PRIMARY KEY,paused boolean NOT NULL DEFAULT false,claim_counter bigint NOT NULL DEFAULT 0,
 derivative_bytes bigint NOT NULL DEFAULT 0 CHECK(derivative_bytes>=0),actor_id text,reason text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS processing_operator_action(
 id uuid PRIMARY KEY,installation_id text NOT NULL,owner_id text NOT NULL,job_id uuid NOT NULL,
 business_attempt_id uuid NOT NULL,actor_id text NOT NULL,reason text NOT NULL,registered_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(job_id,owner_id,installation_id) REFERENCES processing_job(id,owner_id,installation_id),
 UNIQUE(job_id,business_attempt_id)
);
CREATE TABLE IF NOT EXISTS embedding_chunk(
 installation_id text NOT NULL,owner_id text NOT NULL,report_id uuid NOT NULL,case_id uuid NOT NULL,
 generation text NOT NULL,projection_version text NOT NULL,input_hash text NOT NULL,chunk_index integer NOT NULL CHECK(chunk_index BETWEEN 0 AND 63),
 start_offset integer NOT NULL CHECK(start_offset>=0),end_offset integer NOT NULL CHECK(end_offset>start_offset),chunk_hash text NOT NULL,
 model_id text NOT NULL,model_revision text NOT NULL,profile_id text NOT NULL,purpose text NOT NULL CHECK(purpose='symmetric'),
 embedding vector(768) NOT NULL CHECK(abs(vector_norm(embedding)-1)<0.001),norm double precision NOT NULL CHECK(abs(norm-1)<0.001),
 coverage text NOT NULL CHECK(coverage IN('complete','partial')),attempt_id uuid NOT NULL,
 registered_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(installation_id,owner_id,report_id,generation,chunk_index),
 FOREIGN KEY(report_id,case_id,owner_id,installation_id) REFERENCES report(id,case_id,owner_id,installation_id),
 FOREIGN KEY(attempt_id,owner_id,installation_id) REFERENCES processing_attempt(id,owner_id,installation_id)
);
CREATE INDEX IF NOT EXISTS embedding_chunk_scope ON embedding_chunk(installation_id,owner_id,generation,model_id,model_revision,profile_id,purpose);
ALTER TABLE similarity_proposal ADD COLUMN IF NOT EXISTS coverage text NOT NULL DEFAULT 'partial' CHECK(coverage IN('complete','partial'));
COMMENT ON COLUMN similarity_proposal.coverage IS 'Полнота исходного модельного текста: partial нельзя выдавать за полный анализ';
INSERT INTO sys_capability(capability,version) VALUES('model-systematization',3) ON CONFLICT DO NOTHING;
DO $capability$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM sys_capability WHERE capability='model-systematization' AND version=3) THEN RAISE EXCEPTION 'CAPABILITY_VERSION_CONFLICT'; END IF;
END $capability$;
COMMENT ON TABLE processing_job IS 'Обязательство независимой ветви для неизменяемого scoped report и версии pipeline';
COMMENT ON COLUMN processing_job.id IS 'Стабильный идентификатор записи';
COMMENT ON COLUMN processing_job.installation_id IS 'Установка, входящая в область изоляции';
COMMENT ON COLUMN processing_job.owner_id IS 'Владелец неизменяемого наблюдения';
COMMENT ON COLUMN processing_job.report_id IS 'Исходное наблюдение в той же области';
COMMENT ON COLUMN processing_job.case_id IS 'Карточка исходного наблюдения';
COMMENT ON COLUMN processing_job.branch IS 'Независимая ветвь обработки';
COMMENT ON COLUMN processing_job.pipeline_version IS 'Версия алгоритма очереди';
COMMENT ON COLUMN processing_job.input_hash IS 'SHA256 канонического неизменяемого оригинала';
COMMENT ON COLUMN processing_job.state IS 'Явное состояние обработки без скрытых повторов';
COMMENT ON COLUMN processing_job.lease_until IS 'Срок аренды, после которого старый writer теряет право записи';
COMMENT ON COLUMN processing_job.fence IS 'Монотонное поколение аренды для compare-and-swap';
COMMENT ON COLUMN processing_job.available_at IS 'Самое раннее время нового claim';
COMMENT ON COLUMN processing_job.priority IS 'Новый report либо историческое восстановление';
COMMENT ON COLUMN processing_job.technical_attempts IS 'Количество зарезервированных технических отправок текущего business attempt';
COMMENT ON COLUMN processing_job.business_attempt_id IS 'Новый UUID только после явного операторского повтора';
COMMENT ON COLUMN processing_job.retry_reason IS 'Объяснение явной повторной бизнес-попытки';
COMMENT ON COLUMN processing_job.code IS 'Закрытый безопасный код без исходного текста';
COMMENT ON COLUMN processing_job.coverage IS 'Полнота покрытого текста';
COMMENT ON COLUMN processing_job.claimed_at IS 'Последнее получение аренды для справедливости владельцев';
COMMENT ON COLUMN processing_job.registered_at IS 'Время первого сохранения записи';
COMMENT ON COLUMN processing_job.updated_at IS 'Время последнего изменения служебного состояния';
COMMENT ON TABLE processing_attempt IS 'Долговечный неизменяемый intent; изменяемы только ограниченные фаза и итог';
COMMENT ON COLUMN processing_attempt.id IS 'Стабильный идентификатор записи';
COMMENT ON COLUMN processing_attempt.job_id IS 'Scoped задание-владелец';
COMMENT ON COLUMN processing_attempt.installation_id IS 'Установка, входящая в область изоляции';
COMMENT ON COLUMN processing_attempt.owner_id IS 'Владелец неизменяемого наблюдения';
COMMENT ON COLUMN processing_attempt.business_attempt_id IS 'Новый UUID только после явного операторского повтора';
COMMENT ON COLUMN processing_attempt.unit IS 'Номер части embedding либо ноль для Jev';
COMMENT ON COLUMN processing_attempt.operation_id IS 'Точный UUID внешней операции, не переиспользуется для invoke';
COMMENT ON COLUMN processing_attempt.body IS 'Точный неизменяемый request body для расследования неизвестного исхода';
COMMENT ON COLUMN processing_attempt.body_hash IS 'SHA256 точного канонического тела запроса';
COMMENT ON COLUMN processing_attempt.input_hash IS 'SHA256 канонического неизменяемого оригинала';
COMMENT ON COLUMN processing_attempt.deadline_at IS 'Исходный абсолютный дедлайн, входящий в hash Providers';
COMMENT ON COLUMN processing_attempt.model_id IS 'Точный закреплённый model ID';
COMMENT ON COLUMN processing_attempt.model_revision IS 'Точная закреплённая revision модели';
COMMENT ON COLUMN processing_attempt.profile_id IS 'Закреплённый runtime profile либо provider';
COMMENT ON COLUMN processing_attempt.question_version IS 'Версия критериев предварительной классификации';
COMMENT ON COLUMN processing_attempt.projection_version IS 'Версия производной проекции';
COMMENT ON COLUMN processing_attempt.metadata IS 'Ограниченные версии и исключённые поля проекции';
COMMENT ON COLUMN processing_attempt.phase IS 'Фаза intent и единственного терминального результата';
COMMENT ON COLUMN processing_attempt.result IS 'Закрытый ограниченный результат без свободного модельного текста';
COMMENT ON COLUMN processing_attempt.usage IS 'Фактические счётчики либо null, никогда выдуманная стоимость';
COMMENT ON COLUMN processing_attempt.registered_at IS 'Время первого сохранения записи';
COMMENT ON COLUMN processing_attempt.finished_at IS 'Время терминального результата';
COMMENT ON TABLE processing_budget IS 'Атомарно зарезервированные суточные вызовы; unknown считается возможным расходом';
COMMENT ON COLUMN processing_budget.installation_id IS 'Установка, входящая в область изоляции';
COMMENT ON COLUMN processing_budget.branch IS 'Независимая ветвь обработки';
COMMENT ON COLUMN processing_budget.budget_day IS 'UTC день атомарного резервирования';
COMMENT ON COLUMN processing_budget.scope IS 'Раздельный счётчик владельца либо всей установки';
COMMENT ON COLUMN processing_budget.owner_key IS 'Владелец для owner; пустая строка для global';
COMMENT ON COLUMN processing_budget.reserved_calls IS 'Количество возможных расходов, включая неизвестные исходы';
COMMENT ON TABLE processing_control IS 'Постоянная операторская пауза, доля backfill и консервативный бюджет производных байтов';
COMMENT ON COLUMN processing_control.installation_id IS 'Установка, входящая в область изоляции';
COMMENT ON COLUMN processing_control.paused IS 'Запрет новых dispatch, intake и чтение остаются доступны';
COMMENT ON COLUMN processing_control.claim_counter IS 'Счётчик проходов для гарантированной доли backfill';
COMMENT ON COLUMN processing_control.derivative_bytes IS 'Консервативный расход производных байтов с запасом';
COMMENT ON COLUMN processing_control.actor_id IS 'Проверенный оператор действия';
COMMENT ON COLUMN processing_control.reason IS 'Обязательное объяснение оператора';
COMMENT ON COLUMN processing_control.updated_at IS 'Время последнего изменения служебного состояния';
COMMENT ON TABLE processing_operator_action IS 'Неизменяемое объяснение явной новой бизнес-попытки после unknown';
COMMENT ON COLUMN processing_operator_action.id IS 'Стабильный идентификатор записи';
COMMENT ON COLUMN processing_operator_action.installation_id IS 'Установка, входящая в область изоляции';
COMMENT ON COLUMN processing_operator_action.owner_id IS 'Владелец неизменяемого наблюдения';
COMMENT ON COLUMN processing_operator_action.job_id IS 'Scoped задание-владелец';
COMMENT ON COLUMN processing_operator_action.business_attempt_id IS 'Новый UUID только после явного операторского повтора';
COMMENT ON COLUMN processing_operator_action.actor_id IS 'Проверенный оператор действия';
COMMENT ON COLUMN processing_operator_action.reason IS 'Обязательное объяснение оператора';
COMMENT ON COLUMN processing_operator_action.registered_at IS 'Время первого сохранения записи';
COMMENT ON TABLE embedding_chunk IS 'Scoped нормированный вектор отдельного фрагмента точной версии Gemma2 без ANN индекса';
COMMENT ON COLUMN embedding_chunk.installation_id IS 'Установка, входящая в область изоляции';
COMMENT ON COLUMN embedding_chunk.owner_id IS 'Владелец неизменяемого наблюдения';
COMMENT ON COLUMN embedding_chunk.report_id IS 'Исходное наблюдение в той же области';
COMMENT ON COLUMN embedding_chunk.case_id IS 'Карточка исходного наблюдения';
COMMENT ON COLUMN embedding_chunk.generation IS 'Совместимое поколение embedding';
COMMENT ON COLUMN embedding_chunk.projection_version IS 'Версия производной проекции';
COMMENT ON COLUMN embedding_chunk.input_hash IS 'SHA256 канонического неизменяемого оригинала';
COMMENT ON COLUMN embedding_chunk.chunk_index IS 'Порядковый номер фрагмента до 64';
COMMENT ON COLUMN embedding_chunk.start_offset IS 'Начало в UTF-16 единицах полного текста';
COMMENT ON COLUMN embedding_chunk.end_offset IS 'Конец в UTF-16 единицах полного текста';
COMMENT ON COLUMN embedding_chunk.chunk_hash IS 'SHA256 точных UTF-8 байтов фрагмента';
COMMENT ON COLUMN embedding_chunk.model_id IS 'Точный закреплённый model ID';
COMMENT ON COLUMN embedding_chunk.model_revision IS 'Точная закреплённая revision модели';
COMMENT ON COLUMN embedding_chunk.profile_id IS 'Закреплённый runtime profile либо provider';
COMMENT ON COLUMN embedding_chunk.purpose IS 'Только symmetric, префикс добавляет Local AI';
COMMENT ON COLUMN embedding_chunk.embedding IS 'Конечный нормированный vector(768)';
COMMENT ON COLUMN embedding_chunk.norm IS 'Измеренная L2-норма';
COMMENT ON COLUMN embedding_chunk.coverage IS 'Полнота покрытого текста';
COMMENT ON COLUMN embedding_chunk.attempt_id IS 'Scoped intent, результат которого сохранён';
COMMENT ON COLUMN embedding_chunk.registered_at IS 'Время первого сохранения записи';
