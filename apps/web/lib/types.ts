// ABOUTME: Задаёт потребительские типы таймера для страницы и шлюза.
// ABOUTME: Wire-формат принадлежит services/timer/schemas; runtime проверяет схемы владельца.
export type Active = { timerId: string; startedAt: string };
export type Interval = Active & { stoppedAt: string; durationMs: number };
export type Snapshot = { active: Active | null; version: number; serverTime: string; totalCompletedMs?: number; historyRevision?: number; recentCompleted: Interval[]; nextCursor: string | null };
export type History = { items: Interval[]; nextCursor: string | null; historyRevision?: number };
export type Day = { date: string; completedMs: number; targetMs: 28_800_000; percent: number; achieved: boolean };
export type Challenge = {
 startDate: "2026-10-04";
 endDateExclusive: "2026-11-01";
 timeZone: "Europe/Moscow";
 days: 28;
 dailyTargetMs: 28_800_000;
 targetMs: 806_400_000;
 completedMs: number;
 remainingMs: number;
 percent: number;
 remainingDays: number;
 requiredDailyMs: number;
 achieved: boolean;
 closedDays: number;
 daily: Day[];
};
export type Statistics = {
 userId: string;
 version: number;
 serverTime: string;
 timeZone: "Europe/Moscow";
 totalCompletedMs: number;
 daily: Day[];
 challenge: Challenge;
};
export type ServiceError = { code: string; message: string; retryable: boolean; currentVersion?: number };
export type TimerEvent = { userId: string; eventId: string; commandId: string | null } & (
 { version: number; timerId: string; startedAt: string } |
 { version: number; interval: Interval } |
 { version: number; operation: "edit"; interval: Interval } |
 { version: number; operation: "delete"; timerId: string } |
 { correlationId: string; error: ServiceError });
export type Pending = { commandId: string; type: "start" | "stop" | "edit" | "delete"; expectedVersion?: number; timerId?: string; startedAt?: string; stoppedAt?: string };
export type CommandResult = { commandId: string; status: "completed"; result: TimerEvent };
