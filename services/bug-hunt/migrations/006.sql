-- ABOUTME: Хранит задания и результаты диагностики по ревизиям карточек.
-- ABOUTME: Старые наблюдения, квитанции и результаты v3 сохраняются.
CREATE TABLE IF NOT EXISTS diagnostic_investigation(
 id uuid PRIMARY KEY,
 case_id uuid NOT NULL,
 owner_id text NOT NULL,
 installation_id text NOT NULL,
 case_revision integer NOT NULL CHECK(case_revision > 0),
 actor_id text NOT NULL,
 signature_hash text,
 signature_canonical text,
 state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','completed','failed')),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 FOREIGN KEY(case_id,owner_id,installation_id) REFERENCES bug_case(id,owner_id,installation_id),
 CHECK ((signature_hash IS NULL) = (signature_canonical IS NULL)),
 CHECK ((state = 'running') = (finished_at IS NULL)),
 CHECK ((state = 'completed') = (result IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS diagnostic_investigation_current
 ON diagnostic_investigation(case_id,case_revision) WHERE state IN ('running','completed');
CREATE INDEX IF NOT EXISTS diagnostic_investigation_match
 ON diagnostic_investigation(installation_id,owner_id,signature_hash,finished_at DESC) WHERE state = 'completed';
INSERT INTO sys_capability(capability,version) VALUES ('diagnostic-investigation',1) ON CONFLICT DO NOTHING;

COMMENT ON TABLE diagnostic_investigation IS 'Задание диагностики и его итог, привязанные к ревизии исходной карточки';
COMMENT ON COLUMN diagnostic_investigation.id IS 'Идентификатор задания';
COMMENT ON COLUMN diagnostic_investigation.case_id IS 'Разобранная карточка';
COMMENT ON COLUMN diagnostic_investigation.owner_id IS 'Владелец карточки из доверенного контекста';
COMMENT ON COLUMN diagnostic_investigation.installation_id IS 'Установка Bug Hunt';
COMMENT ON COLUMN diagnostic_investigation.case_revision IS 'Ревизия карточки на момент выдачи задания';
COMMENT ON COLUMN diagnostic_investigation.actor_id IS 'Доверенный исполнитель задания';
COMMENT ON COLUMN diagnostic_investigation.signature_hash IS 'Поисковый ключ точной сигнатуры';
COMMENT ON COLUMN diagnostic_investigation.signature_canonical IS 'Каноническая сигнатура для окончательной проверки совпадения';
COMMENT ON COLUMN diagnostic_investigation.state IS 'Независимое состояние выполнения';
COMMENT ON COLUMN diagnostic_investigation.result IS 'Структурированный вывод диагностики и ссылки на факты';
COMMENT ON COLUMN diagnostic_investigation.created_at IS 'Момент постановки и выдачи задания';
COMMENT ON COLUMN diagnostic_investigation.finished_at IS 'Момент регистрации терминального состояния';
