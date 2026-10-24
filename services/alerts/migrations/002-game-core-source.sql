-- ABOUTME: Переносит уведомления и отметки прочтения на новый ID источника.
-- ABOUTME: UUID, содержимое и обе даты сохраняются; конфликт прерывает транзакцию.
INSERT INTO alerts.notifications(id,service_id,type_id,scope_type,scope_id,title,text,data,occurred_at,recorded_at)
SELECT id,'service_game_core',type_id,scope_type,scope_id,title,text,data,occurred_at,recorded_at
FROM alerts.notifications WHERE service_id='service_elements';
INSERT INTO alerts.read_marks(user_id,service_id,id,read_at)
SELECT user_id,'service_game_core',id,read_at FROM alerts.read_marks WHERE service_id='service_elements';
DELETE FROM alerts.read_marks WHERE service_id='service_elements';
DELETE FROM alerts.notifications WHERE service_id='service_elements';
INSERT INTO alerts.migrations(version) VALUES(2) ON CONFLICT(version) DO NOTHING;
