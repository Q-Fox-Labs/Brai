// ABOUTME: Рассчитывает переходы секундомера по намерениям пользователя.
// ABOUTME: Чистое ядро не знает транспортных адресов, хранилища или системных часов.
export type Command = { commandId: string; expectedVersion?: number; timerId?: string; startedAt?: string; stoppedAt?: string };
export type Active = { timerId: string; startedAt: string };
export type Interval = Active & { stoppedAt: string; durationMs: number };
export type State = { version: number; active: Active | null };
export type ErrorCode = "INVALID_ARGUMENT" | "VERSION_CONFLICT" | "TIMER_ALREADY_ACTIVE" | "TIMER_NOT_ACTIVE" | "COMMAND_ID_CONFLICT";
export type Event = { eventId: string; commandId: string | null; version?: number; timerId?: string; startedAt?: string; interval?: Interval; correlationId?: string; error?: { code: ErrorCode; message: string; retryable: false; currentVersion?: number } };
export type EventKind = "started" | "stopped" | "rejected";
export type Transition = { state: State; event: Event; kind: EventKind; interval?: Interval };
const messages: Record<ErrorCode,string> = {
 INVALID_ARGUMENT: "Некорректная команда", VERSION_CONFLICT: "Версия состояния изменилась",
 TIMER_ALREADY_ACTIVE: "Таймер уже запущен", TIMER_NOT_ACTIVE: "Этот таймер не активен",
 COMMAND_ID_CONFLICT: "Идентификатор команды уже использован с другим содержимым",
};
/** Формирует окончательный отказ; инфраструктурные ошибки сюда не передаются. */
export function rejected(code: ErrorCode, eventId: string, commandId: string | null, correlationId: string, version: number): Event {
 return { eventId, commandId, correlationId, error: { code, message: messages[code], retryable: false, currentVersion: version } };
}
/** Рассчитывает переход; legacy CAS и серверное время сохраняют прежнее поведение. */
export function decide(type: "start" | "stop", command: Command, state: State, now: string, context: { eventId: string; timerId: string; timerIdExists?: boolean }): Transition {
 let error: ErrorCode | undefined;
 if (command.expectedVersion !== undefined && command.expectedVersion !== state.version) error = "VERSION_CONFLICT";
 else if (type === "start" && state.active) error = "TIMER_ALREADY_ACTIVE";
 else if (type === "stop" && (!state.active || state.active.timerId !== command.timerId)) error = "TIMER_NOT_ACTIVE";
 else if (type === "start" && context.timerIdExists) error = "INVALID_ARGUMENT";
 else if (type === "stop" && command.stoppedAt && Date.parse(command.stoppedAt) < Date.parse(state.active!.startedAt)) error = "INVALID_ARGUMENT";
 if (error) return { state, kind: "rejected", event: rejected(error, context.eventId, command.commandId, command.commandId, state.version) };
 if (!Number.isSafeInteger(state.version + 1)) throw new Error("STATE_VERSION_EXHAUSTED");
 const version = state.version + 1;
 if (type === "start") {
  const active = { timerId: command.timerId ?? context.timerId, startedAt: command.startedAt ?? now };
  return { state: { version, active }, kind: "started", event: { eventId: context.eventId, commandId: command.commandId, version, ...active } };
 }
 const active = state.active!;
 // AIDEV-NOTE: Только legacy STOP ограничивает скачок серверных часов; новое намерение неизменно.
 const stoppedAt = command.stoppedAt ?? new Date(Math.max(Date.parse(now), Date.parse(active.startedAt))).toISOString();
 const interval = { ...active, stoppedAt, durationMs: Date.parse(stoppedAt) - Date.parse(active.startedAt) };
 return { state: { version, active: null }, interval, kind: "stopped", event: { eventId: context.eventId, commandId: command.commandId, version, interval } };
}
