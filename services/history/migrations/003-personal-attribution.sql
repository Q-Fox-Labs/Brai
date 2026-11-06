-- ABOUTME: Добавляет закрытый журнал переноса и отдельную привязку чтения событий.
-- ABOUTME: Исходные события не меняются; рабочие роли не назначают владельцев.
CREATE TABLE IF NOT EXISTS history.personal_transfers (
 id uuid PRIMARY KEY,
 source_hash text NOT NULL CHECK (source_hash ~ '^[a-f0-9]{64}$'),
 plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK (state IN ('applied','rolled_back')),
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 rolled_back_at timestamptz,
 CHECK ((state='applied' AND rolled_back_at IS NULL) OR
        (state='rolled_back' AND rolled_back_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS history.personal_event_bindings (
 source text NOT NULL,
 id uuid NOT NULL,
 transfer_id uuid NOT NULL REFERENCES history.personal_transfers(id),
 row_sha256 text NOT NULL CHECK (row_sha256 ~ '^[a-f0-9]{64}$'),
 scope_id text CHECK (scope_id ~ '^brai-personal-v1:[a-f0-9]{64}$'),
 proof_sha256 text CHECK (proof_sha256 ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(source,id),
 FOREIGN KEY(source,id) REFERENCES history.events(source,id),
 CHECK ((scope_id IS NULL) = (proof_sha256 IS NULL))
);
ALTER TABLE history.personal_event_bindings ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS history_personal_bindings_scope
 ON history.personal_event_bindings(scope_id,source,id) WHERE scope_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS history_personal_bindings_transfer
 ON history.personal_event_bindings(transfer_id);
COMMENT ON TABLE history.personal_transfers IS 'Закрытые квитанции операторского переноса; не команды для воспроизведения';
COMMENT ON TABLE history.personal_event_bindings IS 'Защищённая область чтения исходного события; NULL scope означает закрытый архив';
COMMENT ON COLUMN history.personal_event_bindings.row_sha256 IS 'SHA256 исходного PostgreSQL JSONB-текста строки без преобразования чисел в JavaScript';
COMMENT ON COLUMN history.personal_event_bindings.proof_sha256 IS 'Хеш проверенного внешнего доказательства владельца; actor_id и общий технический owner доказательством не являются';
INSERT INTO history.migrations(version) VALUES(3) ON CONFLICT(version) DO NOTHING;
