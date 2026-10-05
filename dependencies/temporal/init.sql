-- ABOUTME: Создаёт отдельную visibility-БД при первом запуске PostgreSQL Temporal.
-- ABOUTME: Выполняется только для нового кластера; существующие данные не меняет.
CREATE DATABASE temporal_visibility OWNER temporal;
