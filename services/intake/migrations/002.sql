-- ABOUTME: Фиксирует идентичность управляющего события атомарно с изменением пакета.
-- ABOUTME: Реестр не исполняет очереди и не содержит сырые результаты или credentials.
CREATE TABLE IF NOT EXISTS intake.intake_control_events (
 source text NOT NULL,
 event_id text NOT NULL,
 owner_id text NOT NULL,
 input_hash text NOT NULL,
 packet_id uuid NOT NULL REFERENCES intake.intake_packets(id),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source,event_id)
);
COMMENT ON TABLE intake.intake_control_events IS 'Принятые operation.result и processing.resume: ключ и хеш атомарного перехода';
COMMENT ON COLUMN intake.intake_control_events.source IS 'Подтверждённая идентичность издателя';
COMMENT ON COLUMN intake.intake_control_events.event_id IS 'Неизменяемый ID события в пределах источника';
COMMENT ON COLUMN intake.intake_control_events.owner_id IS 'Владелец проверенного пакета';
COMMENT ON COLUMN intake.intake_control_events.input_hash IS 'Канонический SHA-256 полного события';
COMMENT ON COLUMN intake.intake_control_events.packet_id IS 'Пакет, изменённый этим событием';
COMMENT ON COLUMN intake.intake_control_events.recorded_at IS 'Время фиксации принятого события';
REVOKE ALL ON intake.intake_control_events FROM PUBLIC;
