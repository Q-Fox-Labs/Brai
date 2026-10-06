// ABOUTME: Рассчитывает переходы секундомера по намерениям пользователя.
// ABOUTME: Чистое ядро не знает транспортных адресов, хранилища или системных часов.
export type Command = { userId: string; commandId: string; expectedVersion?: number; timerId?: string; startedAt?: string; stoppedAt?: string };
export type Active = { timerId: string; startedAt: string };
export type Interval = Active & { stoppedAt: string; durationMs: number };
export type State = { version: number; active: Active | null };
export type ErrorCode = "INVALID_ARGUMENT" | "VERSION_CONFLICT" | "TIMER_ALREADY_ACTIVE" | "TIMER_NOT_ACTIVE" | "COMMAND_ID_CONFLICT" | "INTERVAL_OVERLAP" | "HISTORY_CHANGED" | "NOT_FOUND";
export type Event = { userId: string; eventId: string; commandId: string | null; version?: number; timerId?: string; startedAt?: string; operation?: "edit" | "delete"; interval?: Interval; correlationId?: string; error?: { code: ErrorCode; message: string; retryable: false; currentVersion?: number } };
export type EventKind = "started" | "stopped" | "edited" | "deleted" | "rejected";
export type Transition = { state: State; event: Event; kind: EventKind; interval?: Interval };
const messages: Record<ErrorCode,string> = {
 INVALID_ARGUMENT: "Некорректная команда", VERSION_CONFLICT: "Версия состояния изменилась",
 TIMER_ALREADY_ACTIVE: "Таймер уже запущен", TIMER_NOT_ACTIVE: "Этот таймер не активен",
 COMMAND_ID_CONFLICT: "Идентификатор команды уже использован с другим содержимым",
 INTERVAL_OVERLAP: "Интервал пересекается с другой сессией", HISTORY_CHANGED: "История изменилась; обновите её",
 NOT_FOUND: "Завершённая сессия не найдена",
};
/** Формирует окончательный отказ; инфраструктурные ошибки сюда не передаются. */
export function rejected(code: ErrorCode, eventId: string, commandId: string | null, correlationId: string, version: number, userId: string): Event {
 return { userId, eventId, commandId, correlationId, error: { code, message: messages[code], retryable: false, currentVersion: version } };
}
/** Рассчитывает переход; legacy CAS и серверное время сохраняют прежнее поведение. */
export function decide(type: "start" | "stop", command: Command, state: State, now: string, context: { eventId: string; timerId: string; timerIdExists?: boolean }): Transition {
 let error: ErrorCode | undefined;
 if (command.expectedVersion !== undefined && command.expectedVersion !== state.version) error = "VERSION_CONFLICT";
 else if (type === "start" && state.active) error = "TIMER_ALREADY_ACTIVE";
 else if (type === "stop" && (!state.active || state.active.timerId !== command.timerId)) error = "TIMER_NOT_ACTIVE";
 else if (type === "start" && context.timerIdExists) error = "INVALID_ARGUMENT";
 else if (type === "stop" && command.stoppedAt && Date.parse(command.stoppedAt) < Date.parse(state.active!.startedAt)) error = "INVALID_ARGUMENT";
 if (error) return { state, kind: "rejected", event: rejected(error, context.eventId, command.commandId, command.commandId, state.version, command.userId) };
 if (!Number.isSafeInteger(state.version + 1)) throw new Error("STATE_VERSION_EXHAUSTED");
 const version = state.version + 1;
 if (type === "start") {
  const active = { timerId: command.timerId ?? context.timerId, startedAt: command.startedAt ?? now };
  return { state: { version, active }, kind: "started", event: { userId: command.userId, eventId: context.eventId, commandId: command.commandId, version, ...active } };
 }
 const active = state.active!;
 // AIDEV-NOTE: Только legacy STOP ограничивает скачок серверных часов; новое намерение неизменно.
 const stoppedAt = command.stoppedAt ?? new Date(Math.max(Date.parse(now), Date.parse(active.startedAt))).toISOString();
 const interval = { ...active, stoppedAt, durationMs: Date.parse(stoppedAt) - Date.parse(active.startedAt) };
 return { state: { version, active: null }, interval, kind: "stopped", event: { userId: command.userId, eventId: context.eventId, commandId: command.commandId, version, interval } };
}

export type MutationCommand = Command & { timerId: string; expectedVersion: number; startedAt?: string; stoppedAt?: string };
/** Рассчитывает edit/delete после блокировки владельца; хранилище проверяет пересечения. */
export function decideMutation(type: "edit" | "delete", command: MutationCommand, state: State, target: Interval | null, overlaps: boolean, eventId: string): Transition {
 const fail=(code:ErrorCode):Transition=>({state,kind:"rejected",event:rejected(code,eventId,command.commandId,command.commandId,state.version,command.userId)});
 if(command.expectedVersion!==state.version)return fail("VERSION_CONFLICT");
 if(!target)return fail("NOT_FOUND");
 if(!Number.isSafeInteger(state.version+1))throw new Error("STATE_VERSION_EXHAUSTED");
 const version=state.version+1;
 if(type==="delete")return {state:{...state,version},kind:"deleted",event:{userId:command.userId,eventId,commandId:command.commandId,version,operation:"delete",timerId:command.timerId}};
 const startedAt=command.startedAt!,stoppedAt=command.stoppedAt!,start=Date.parse(startedAt),stop=Date.parse(stoppedAt);
 if(!Number.isFinite(start)||!Number.isFinite(stop)||start>=stop)return fail("INVALID_ARGUMENT");
 if(overlaps)return fail("INTERVAL_OVERLAP");
 const interval={timerId:target.timerId,startedAt,stoppedAt,durationMs:stop-start};
 return {state:{...state,version},interval,kind:"edited",event:{userId:command.userId,eventId,commandId:command.commandId,version,operation:"edit",interval}};
}
