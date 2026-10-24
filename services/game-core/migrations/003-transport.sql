-- ABOUTME: Переносит адреса ожидающих публикации событий на транспорт game-core.
-- ABOUTME: UUID, payload и отметки доставки остаются прежними; повтор безопасен.
UPDATE game_core.outbox
SET subject = 'brai.game-core.v1.events.' || substring(subject FROM length('brai.elements.v1.events.') + 1)
WHERE subject LIKE 'brai.elements.v1.events.%';
