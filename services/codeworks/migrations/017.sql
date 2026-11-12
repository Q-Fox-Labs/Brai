-- ABOUTME: Отделяет выбор задачи от учёта возможных писателей без изменения прежних записей.
-- ABOUTME: Порядок выбора выделяется под session lock; завершение старого вызова не переключает задачу.
CREATE SEQUENCE codeworks.write_selection_order;
ALTER TABLE codeworks.write_calls
  ADD COLUMN select_workspace boolean NOT NULL DEFAULT true,
  ADD COLUMN selection_order bigint;
ALTER TABLE codeworks.write_calls ALTER COLUMN selection_order
  SET DEFAULT nextval('codeworks.write_selection_order');
COMMENT ON COLUMN codeworks.write_calls.select_workspace IS 'Вызов выбирает область задачи; false сохраняет только учёт возможной записи.';
COMMENT ON COLUMN codeworks.write_calls.selection_order IS 'Порядок однократного выбора под session lock; NULL сохраняет историческую семантику.';
