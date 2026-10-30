-- ABOUTME: Создаёт только предметное хранилище Приёма и устойчивые ключи повторов.
-- ABOUTME: Очередь, расписание и журнал повторов принадлежат JetStream/Temporal.
CREATE SCHEMA IF NOT EXISTS intake;
REVOKE ALL ON SCHEMA intake FROM PUBLIC;
CREATE TABLE IF NOT EXISTS intake.intake_receipts (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL,
 source text NOT NULL,
 material_id text NOT NULL,
 current_revision integer NOT NULL CHECK(current_revision > 0),
 UNIQUE(owner_id,source,material_id)
);
CREATE TABLE IF NOT EXISTS intake.intake_packets (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL,
 source text NOT NULL,
 event_id text NOT NULL,
 input_hash text NOT NULL CHECK(input_hash ~ '^[0-9a-f]{64}$'),
 receipt_id uuid REFERENCES intake.intake_receipts(id),
 body jsonb NOT NULL,
 UNIQUE(source,event_id)
);
CREATE TABLE IF NOT EXISTS intake.intake_rejections (
 stream text NOT NULL,
 sequence bigint NOT NULL,
 source text NOT NULL,
 owner_id text,
 event_id text,
 input_hash text NOT NULL,
 code text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(stream,sequence)
);
COMMENT ON SCHEMA intake IS 'Данные Приёма; не общая БД сервисов и не планировщик';
COMMENT ON TABLE intake.intake_receipts IS 'Логические материалы с текущей ревизией';
COMMENT ON COLUMN intake.intake_receipts.id IS 'Внутренний устойчивый UUID материала';
COMMENT ON COLUMN intake.intake_receipts.owner_id IS 'Владелец из доверенной привязки источника';
COMMENT ON COLUMN intake.intake_receipts.source IS 'Идентичность разрешённого источника';
COMMENT ON COLUMN intake.intake_receipts.material_id IS 'Ключ исходного логического сообщения';
COMMENT ON COLUMN intake.intake_receipts.current_revision IS 'Максимальная принятая ревизия исходника';
COMMENT ON TABLE intake.intake_packets IS 'Неизменяемый оригинал и текущее предметное состояние события';
COMMENT ON COLUMN intake.intake_packets.id IS 'UUID конкретного пакета';
COMMENT ON COLUMN intake.intake_packets.owner_id IS 'Подтверждённый владелец пакета';
COMMENT ON COLUMN intake.intake_packets.source IS 'Источник, подтверждённый NATS ACL и subject';
COMMENT ON COLUMN intake.intake_packets.event_id IS 'Устойчивый ID события у источника';
COMMENT ON COLUMN intake.intake_packets.input_hash IS 'SHA-256 канонического исходного события';
COMMENT ON COLUMN intake.intake_packets.receipt_id IS 'Материал; NULL для самостоятельного события';
COMMENT ON COLUMN intake.intake_packets.body IS 'Оригинал, snapshot, сценарий, jobs, подтверждения и состояние; без секретов';
COMMENT ON TABLE intake.intake_rejections IS 'Безопасная диагностика отказа, без сырого сообщения';
COMMENT ON COLUMN intake.intake_rejections.stream IS 'Входной stream';
COMMENT ON COLUMN intake.intake_rejections.sequence IS 'Последовательность доставки в stream';
COMMENT ON COLUMN intake.intake_rejections.source IS 'Заявленный subject источника';
COMMENT ON COLUMN intake.intake_rejections.owner_id IS 'Проверенный владелец либо NULL';
COMMENT ON COLUMN intake.intake_rejections.event_id IS 'Известный ID события либо NULL';
COMMENT ON COLUMN intake.intake_rejections.input_hash IS 'Хеш пакета для диагностики без копии содержимого';
COMMENT ON COLUMN intake.intake_rejections.code IS 'Безопасный код отказа';
COMMENT ON COLUMN intake.intake_rejections.recorded_at IS 'Время фиксации отказа';
REVOKE ALL ON ALL TABLES IN SCHEMA intake FROM PUBLIC;
