-- ABOUTME: Сохраняет идентичность событий при переименовании их источника.
-- ABOUTME: Конфликт UUID с новым источником откатывает миграцию целиком.
UPDATE history.events SET source='service_game_core' WHERE source='service_elements';
INSERT INTO history.migrations(version) VALUES(2) ON CONFLICT(version) DO NOTHING;
