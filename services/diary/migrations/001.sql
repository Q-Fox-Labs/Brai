-- ABOUTME: Создаёт собственное хранилище записей и устойчивую очередь Дневника.
-- ABOUTME: Роли runtime не владеют схемой; публичное чтение ограничено RLS.
CREATE SCHEMA IF NOT EXISTS diary;
CREATE TABLE IF NOT EXISTS diary.entries(
 id uuid PRIMARY KEY, owner_id text NOT NULL, request_id uuid NOT NULL,
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('awaiting_upload','transcribing','correcting','ready','needs_attention')),
 document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), available_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,request_id)
);
COMMENT ON TABLE diary.entries IS 'Записи личного дневника, происхождение текста и очередь обработки; аудио принадлежит Artifacts.';
COMMENT ON COLUMN diary.entries.owner_id IS 'Канонический userId только из доверенной Auth-привязки.';
COMMENT ON COLUMN diary.entries.request_id IS 'Ключ точного повтора владельца.';
COMMENT ON COLUMN diary.entries.document IS 'Исходный текст, исправление Luna, дата и происхождение; не журналируется.';
COMMENT ON COLUMN diary.entries.input_hash IS 'Хеш нормализованных параметров создания для запрета изменённого повтора.';
COMMENT ON COLUMN diary.entries.state IS 'Состояние серверного задания, независимое от браузера.';
COMMENT ON COLUMN diary.entries.available_at IS 'Не раньше какого времени worker повторяет безопасный шаг.';
COMMENT ON COLUMN diary.entries.id IS 'Стабильный идентификатор записи.';
COMMENT ON COLUMN diary.entries.created_at IS 'Время приёма, не дата события.';
COMMENT ON COLUMN diary.entries.updated_at IS 'Время последнего сохранения шага.';
CREATE INDEX IF NOT EXISTS diary_entries_queue ON diary.entries(available_at,updated_at) WHERE state IN ('awaiting_upload','transcribing','correcting');
ALTER TABLE diary.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE diary.entries FORCE ROW LEVEL SECURITY;
