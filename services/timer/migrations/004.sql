-- ABOUTME: Создаёт принадлежащую timer конфигурацию focus challenge.
-- ABOUTME: Повторный запуск сохраняет совпадающую строку и останавливается при конфликте параметров.
CREATE TABLE IF NOT EXISTS timer.sys_challenge (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 start_date date NOT NULL CHECK (start_date = DATE '2026-10-04'),
 end_date_exclusive date NOT NULL CHECK (end_date_exclusive = DATE '2026-11-01'),
 time_zone text NOT NULL CHECK (time_zone = 'Europe/Moscow'),
 days integer NOT NULL CHECK (days = 28),
 daily_target_ms bigint NOT NULL CHECK (daily_target_ms = 28800000),
 target_ms bigint NOT NULL CHECK (target_ms = 806400000),
 CHECK (end_date_exclusive = start_date + days),
 CHECK (target_ms = days * daily_target_ms)
);

COMMENT ON TABLE timer.sys_challenge IS 'Единственная конфигурация challenge, принадлежащая сервису timer.';
COMMENT ON COLUMN timer.sys_challenge.singleton IS 'Постоянный ключ единственной строки, всегда true.';
COMMENT ON COLUMN timer.sys_challenge.start_date IS 'Включительная календарная дата старта в time_zone.';
COMMENT ON COLUMN timer.sys_challenge.end_date_exclusive IS 'Исключительная календарная дата завершения.';
COMMENT ON COLUMN timer.sys_challenge.time_zone IS 'Часовой пояс IANA для календарных границ challenge.';
COMMENT ON COLUMN timer.sys_challenge.days IS 'Число календарных дней challenge.';
COMMENT ON COLUMN timer.sys_challenge.daily_target_ms IS 'Цель одного календарного дня в миллисекундах.';
COMMENT ON COLUMN timer.sys_challenge.target_ms IS 'Полная цель challenge в миллисекундах.';

DO $$
DECLARE
 configured timer.sys_challenge%ROWTYPE;
BEGIN
 INSERT INTO timer.sys_challenge(singleton,start_date,end_date_exclusive,time_zone,days,daily_target_ms,target_ms)
 VALUES(true,DATE '2026-10-04',DATE '2026-11-01','Europe/Moscow',28,28800000,806400000)
 ON CONFLICT (singleton) DO NOTHING;

 SELECT * INTO configured FROM timer.sys_challenge WHERE singleton=true;
 IF NOT FOUND OR configured.start_date IS DISTINCT FROM DATE '2026-10-04'
    OR configured.end_date_exclusive IS DISTINCT FROM DATE '2026-11-01'
    OR configured.time_zone IS DISTINCT FROM 'Europe/Moscow'
    OR configured.days IS DISTINCT FROM 28
    OR configured.daily_target_ms IS DISTINCT FROM 28800000
    OR configured.target_ms IS DISTINCT FROM 806400000 THEN
  RAISE EXCEPTION 'TIMER_CHALLENGE_CONFIGURATION_CONFLICT';
 END IF;
END $$;

INSERT INTO timer.migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
