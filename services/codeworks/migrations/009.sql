-- ABOUTME: Сохраняет владение и состояние необязательного индекса рабочей области.
-- ABOUTME: Не меняет готовность Git-области и результаты выпуска.
ALTER TABLE codeworks.workspaces ADD COLUMN code_index jsonb;
