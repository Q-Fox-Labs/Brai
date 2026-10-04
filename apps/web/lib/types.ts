// ABOUTME: Задаёт потребительские типы таймера для страницы и шлюза.
// ABOUTME: Wire-формат принадлежит services/timer/schemas; runtime проверяет схемы владельца.
export type Active = { timerId: string; startedAt: string };
export type Interval = Active & { stoppedAt: string; durationMs: number };
export type Snapshot = { active: Active | null; version: number; serverTime: string; totalCompletedMs?: number; recentCompleted: Interval[]; nextCursor: string | null };
export type History = { items: Interval[]; nextCursor: string | null };
export type ServiceError = { code: string; message: string; retryable: boolean; currentVersion?: number };
export type TimerEvent = { userId: string; eventId: string; commandId: string | null } & (
 { version: number; timerId: string; startedAt: string } |
 { version: number; interval: Interval } |
 { correlationId: string; error: ServiceError });
export type Pending = { commandId: string; type: "start" | "stop"; expectedVersion?: number; timerId?: string; startedAt?: string; stoppedAt?: string };
export type CommandResult = { commandId: string; status: "completed"; result: TimerEvent };
