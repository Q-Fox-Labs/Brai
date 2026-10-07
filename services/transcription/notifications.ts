// ABOUTME: Формирует безопасные уведомления transcription по закрытым причинам.
// ABOUTME: Не зависит от NATS или БД и не принимает текст распознавания и сырой exception.
import { assertDto } from '#transcription-contracts';

export const incidentKeys = ['storage', 'local_ai', 'artifacts', 'history', 'recovery', 'delivery', 'capacity'] as const;
export type IncidentKey = typeof incidentKeys[number];
const titles: Record<IncidentKey, string> = {
  storage: 'Хранилище транскрибаций недоступно', local_ai: 'Сервис распознавания недоступен',
  artifacts: 'Хранилище аудио недоступно', history: 'Не удалось сохранить историю транскрибаций',
  recovery: 'Не удалось восстановить состояние транскрибаций',
  delivery: 'Доставка уведомлений транскрибаций задерживается', capacity: 'Очередь транскрибаций заполнена',
};

/** Создаёт обезличенное общее событие; повтор сохраняет ID и время. */
export function incidentEvent(key: IncidentKey, id: string, occurredAt: string): any {
  return assertDto('AlertEvent', { id, service_id: 'transcription', type_id: key === 'capacity' ? 3 : 2,
    scope_type: 'system', scope_id: 'global', title: titles[key], text: '', data: { reason: key }, occurred_at: occurredAt });
}

/** Проецирует только разрешённые метаданные; системное событие не раскрывает IDs. */
export function requestEvent(record: any, id: string, occurredAt: string): any {
  const lost = record.resultState === 'lost';
  const failed = record.taskState === 'failed';
  const personal = record.scope.scopeType === 'user';
  return assertDto('AlertEvent', { id, service_id: 'transcription', type_id: failed ? 1 : 3,
    scope_type: personal ? 'user' : 'system', scope_id: personal ? record.ownerId : 'global',
    title: lost ? 'Результат транскрибации потерян' : failed ? 'Не удалось выполнить транскрибацию' : 'Исход транскрибации неизвестен',
    text: lost ? 'Текст больше недоступен из-за сбоя.' : failed ? 'Запрос завершился ошибкой.' : 'Обработка могла продолжиться. Автоматический повтор не выполняется.',
    data: personal ? { requestId: record.requestId, attemptId: record.currentAttemptId, errorCode: record.errorCode } : {},
    occurred_at: occurredAt });
}
