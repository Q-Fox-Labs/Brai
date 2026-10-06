// ABOUTME: Рассчитывает общую, дневную и challenge-статистику по завершённым интервалам.
// ABOUTME: Чистое ядро получает один полный согласованный снимок и не обращается к БД или времени процесса.

export type CompletedInterval = Readonly<{
  startedAt: string;
  stoppedAt: string;
  durationMs: number;
}>;

export type ChallengeConfig = Readonly<{
  startDate: string;
  endDateExclusive: string;
  timeZone: string;
  days: number;
  dailyTargetMs: number;
  targetMs: number;
}>;

export type DayStatistics = {
  date: string;
  completedMs: number;
  targetMs: number;
  percent: number;
  achieved: boolean;
};

export type Statistics = {
  userId: string;
  version: number;
  serverTime: string;
  timeZone: string;
  totalCompletedMs: number;
  daily: DayStatistics[];
  challenge: ChallengeConfig & {
    completedMs: number;
    remainingMs: number;
    percent: number;
    remainingDays: number;
    requiredDailyMs: number;
    achieved: boolean;
    closedDays: number;
    daily: DayStatistics[];
  };
};

export type StatisticsInput = Readonly<{
  userId: string;
  version: number;
  serverTime: string;
  timeZone: string;
  completedIntervals: readonly CompletedInterval[];
  challenge: ChallengeConfig;
}>;

const millisecondsPerDay = 86_400_000;

function invalid(): never {
  throw new Error("INVALID_STATISTICS_INPUT");
}

function exhausted(): never {
  throw new Error("STATISTICS_EXHAUSTED");
}

function addSafe(total: number, value: number): number {
  const sum = total + value;
  if (!Number.isSafeInteger(sum) || sum < 0) exhausted();
  return sum;
}

function parseDate(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) invalid();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const milliseconds = Date.UTC(year, month - 1, day);
  if (new Date(milliseconds).toISOString().slice(0, 10) !== date) invalid();
  return milliseconds;
}

function addCalendarDays(date: string, days: number): string {
  return new Date(parseDate(date) + days * millisecondsPerDay).toISOString().slice(0, 10);
}

function dayDistance(from: string, to: string): number {
  return (parseDate(to) - parseDate(from)) / millisecondsPerDay;
}

function dateAt(milliseconds: number, formatter: Intl.DateTimeFormat): string {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(milliseconds)).map(part => [part.type, part.value]));
  return parts.year + "-" + parts.month + "-" + parts.day;
}

/** Ищет первую миллисекунду следующей местной даты, включая дни перехода DST. */
function nextLocalDateBoundary(
  cursor: number,
  end: number,
  currentDate: string,
  formatter: Intl.DateTimeFormat,
): number {
  if (dateAt(end, formatter) <= currentDate) return end;
  let low = cursor + 1;
  let high = end;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (dateAt(middle, formatter) > currentDate) high = middle;
    else low = middle + 1;
  }
  return low;
}

function validate(input: StatisticsInput): Intl.DateTimeFormat {
  if (!input || typeof input.userId !== "string" || input.userId.length < 1 || input.userId.length > 128) invalid();
  if (!Number.isSafeInteger(input.version) || input.version < 0) invalid();
  if (typeof input.serverTime !== "string" || !Number.isSafeInteger(Date.parse(input.serverTime))) invalid();
  if (!Number.isSafeInteger(input.challenge.days) || input.challenge.days < 1) invalid();
  if (!Number.isSafeInteger(input.challenge.dailyTargetMs) || input.challenge.dailyTargetMs < 1) invalid();
  if (!Number.isSafeInteger(input.challenge.targetMs) || input.challenge.targetMs < 1) invalid();
  if (input.challenge.days * input.challenge.dailyTargetMs !== input.challenge.targetMs) invalid();
  if (addCalendarDays(input.challenge.startDate, input.challenge.days) !== input.challenge.endDateExclusive) invalid();
  if (input.challenge.timeZone !== input.timeZone) invalid();
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: input.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return invalid();
  }
}

function validateIntervals(intervals: readonly CompletedInterval[]): { intervals: CompletedInterval[]; totalCompletedMs: number } {
  if (!Array.isArray(intervals)) invalid();
  let totalCompletedMs = 0;
  const checked: CompletedInterval[] = [];
  for (const interval of intervals) {
    if (typeof interval?.startedAt !== "string" || typeof interval.stoppedAt !== "string") invalid();
    const start = Date.parse(interval.startedAt);
    const stop = Date.parse(interval.stoppedAt);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop) || stop < start) invalid();
    if (!Number.isSafeInteger(interval.durationMs) || interval.durationMs < 0 || stop - start !== interval.durationMs) invalid();
    totalCompletedMs = addSafe(totalCompletedMs, interval.durationMs);
    checked.push(interval);
  }
  return { intervals: checked, totalCompletedMs };
}

/**
 * Рассчитывает DTO по полной истории завершённых интервалов одного владельца.
 *
 * @param input Интервалы должны быть неудалёнными, завершёнными и полученными одним read-only снимком.
 * Все длительности и границы задаются целыми миллисекундами; percent и requiredDailyMs могут быть дробными.
 * @returns Дневные суммы полной истории и показатели челленджа для согласованных serverTime и параметров.
 * @throws Error с INVALID_STATISTICS_INPUT при некорректных входах или STATISTICS_EXHAUSTED при небезопасной сумме.
 */
export function calculateStatistics(input: StatisticsInput): Statistics {
  const formatter = validate(input);
  const { intervals, totalCompletedMs } = validateIntervals(input.completedIntervals);
  const completedByDate = new Map<string, number>();

  for (const interval of intervals) {
    const start = Date.parse(interval.startedAt);
    const end = Date.parse(interval.stoppedAt);
    let cursor = start;
    while (cursor < end) {
      const date = dateAt(cursor, formatter);
      const boundary = nextLocalDateBoundary(cursor, end, date, formatter);
      const chunkEnd = Math.min(end, boundary);
      const chunkMs = chunkEnd - cursor;
      completedByDate.set(date, addSafe(completedByDate.get(date) ?? 0, chunkMs));
      cursor = chunkEnd;
    }
  }

  const challengeDates = Array.from(
    { length: input.challenge.days },
    (_, index) => addCalendarDays(input.challenge.startDate, index),
  );
  const dailyDates = new Set([
    ...[...completedByDate].filter(([, completedMs]) => completedMs > 0).map(([date]) => date),
    ...challengeDates,
  ]);
  const day = (date: string): DayStatistics => {
    const completedMs = completedByDate.get(date) ?? 0;
    return {
      date,
      completedMs,
      targetMs: input.challenge.dailyTargetMs,
      percent: (completedMs / input.challenge.dailyTargetMs) * 100,
      achieved: completedMs >= input.challenge.dailyTargetMs,
    };
  };
  const daily = [...dailyDates].sort().map(day);
  const challengeDaily = challengeDates.map(day);
  let challengeCompletedMs = 0;
  let closedDays = 0;
  for (const entry of challengeDaily) {
    challengeCompletedMs = addSafe(challengeCompletedMs, entry.completedMs);
    if (entry.achieved) closedDays++;
  }

  const remainingMs = Math.max(0, input.challenge.targetMs - challengeCompletedMs);
  const currentDate = dateAt(Date.parse(input.serverTime), formatter);
  const remainingDays = currentDate < input.challenge.startDate
    ? input.challenge.days
    : currentDate >= input.challenge.endDateExclusive
      ? 0
      : dayDistance(currentDate, input.challenge.endDateExclusive);
  const achieved = challengeCompletedMs >= input.challenge.targetMs;

  return {
    userId: input.userId,
    version: input.version,
    serverTime: input.serverTime,
    timeZone: input.timeZone,
    totalCompletedMs,
    daily,
    challenge: {
      ...input.challenge,
      completedMs: challengeCompletedMs,
      remainingMs,
      percent: (challengeCompletedMs / input.challenge.targetMs) * 100,
      remainingDays,
      requiredDailyMs: achieved || remainingDays === 0 ? 0 : remainingMs / remainingDays,
      achieved,
      closedDays,
      daily: challengeDaily,
    },
  };
}
