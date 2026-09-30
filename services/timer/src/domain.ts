// ABOUTME: Определяет переходы общего секундомера и сохранённые события.
// ABOUTME: Не знает о PostgreSQL, NATS или времени системных часов.
export type Command = { commandId: string; expectedVersion: number; timerId?: string };
export type Active = { timerId: string; startedAt: string };
export type Interval = Active & { stoppedAt: string; durationMs: number };
export type State = { version: number; active: Active | null };
export type ErrorCode = "INVALID_ARGUMENT" | "VERSION_CONFLICT" | "TIMER_ALREADY_ACTIVE" | "TIMER_NOT_ACTIVE" | "COMMAND_ID_CONFLICT";
export type Event = { eventId: string; commandId: string | null; version?: number; timerId?: string; startedAt?: string; interval?: Interval; correlationId?: string; error?: { code: ErrorCode; message: string; retryable: false; currentVersion?: number } };
export type Saved = { subject: string; event: Event; duplicate: boolean };
export type Transition = { state: State; event: Event; subject: string; interval?: Interval };
const prefix = "brai.timer.v1.event.";
const messages: Record<ErrorCode,string> = {
  INVALID_ARGUMENT: "Некорректная команда", VERSION_CONFLICT: "Версия состояния изменилась",
  TIMER_ALREADY_ACTIVE: "Таймер уже запущен", TIMER_NOT_ACTIVE: "Этот таймер не активен",
  COMMAND_ID_CONFLICT: "Идентификатор команды уже использован с другим содержимым",
};
/** Формирует окончательный отказ; инфраструктурные ошибки сюда не передаются. */
export function rejected(code: ErrorCode, eventId: string, commandId: string | null, correlationId: string, version: number): Event {
  return { eventId, commandId, correlationId, error: { code, message: messages[code], retryable: false, currentVersion: version } };
}
/** Рассчитывает один переход после проверки повтора; now — UTC с точностью миллисекунд. */
export function decide(subject: string, command: Command, state: State, now: string, ids: { eventId: string; timerId: string }): Transition {
  let error: ErrorCode | undefined;
  if (command.expectedVersion !== state.version) error = "VERSION_CONFLICT";
  else if (subject.endsWith(".start") && state.active) error = "TIMER_ALREADY_ACTIVE";
  else if (subject.endsWith(".stop") && (!state.active || state.active.timerId !== command.timerId)) error = "TIMER_NOT_ACTIVE";
  if (error) return { state, subject: prefix+"rejected", event: rejected(error, ids.eventId, command.commandId, command.commandId, state.version) };
  if (!Number.isSafeInteger(state.version + 1)) throw new Error("STATE_VERSION_EXHAUSTED");
  const version = state.version + 1;
  if (subject.endsWith(".start")) {
    const active = { timerId: ids.timerId, startedAt: now };
    return { state: { version, active }, subject: prefix+"started", event: { eventId: ids.eventId, commandId: command.commandId, version, ...active } };
  }
  const active = state.active!;
  // AIDEV-NOTE: Скачок часов назад не создаёт отрицательную длительность или дату до начала.
  const stoppedAt = new Date(Math.max(Date.parse(now), Date.parse(active.startedAt))).toISOString();
  const interval = { ...active, stoppedAt, durationMs: Date.parse(stoppedAt) - Date.parse(active.startedAt) };
  return { state: { version, active: null }, interval, subject: prefix+"stopped", event: { eventId: ids.eventId, commandId: command.commandId, version, interval } };
}
