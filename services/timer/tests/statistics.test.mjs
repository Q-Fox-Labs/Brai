// ABOUTME: Проверяет полную дневную разбивку, границы календаря и формулы челленджа.
// ABOUTME: Использует чистое ядро без PostgreSQL, NATS и системных часов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateStatistics } from '../dist/statistics.js';

const moscowChallenge = {
  startDate: '2026-10-04',
  endDateExclusive: '2026-11-01',
  timeZone: 'Europe/Moscow',
  days: 28,
  dailyTargetMs: 28_800_000,
  targetMs: 806_400_000,
};

function calculate(completedIntervals, serverTime = '2026-10-05T12:00:00.000Z', challenge = moscowChallenge) {
  return calculateStatistics({
    userId: 'user-a',
    version: 41,
    serverTime,
    timeZone: challenge.timeZone,
    completedIntervals,
    challenge,
  });
}

function interval(startedAt, stoppedAt) {
  return { startedAt, stoppedAt, durationMs: Date.parse(stoppedAt) - Date.parse(startedAt) };
}

test('statistics uses all completed history, combines challenge zero-days, and preserves milliseconds', () => {
  const history = Array.from({ length: 60 }, (_, index) => {
    const start = Date.parse('2026-09-01T00:00:00.000Z') + index * 2_000;
    return interval(new Date(start).toISOString(), new Date(start + 1_000).toISOString());
  });
  const result = calculate(history);
  const challengeDates = Array.from({ length: 28 }, (_, index) =>
    new Date(Date.UTC(2026, 9, 4 + index)).toISOString().slice(0, 10));

  assert.equal(result.totalCompletedMs, 60_000);
  assert.deepEqual(result.daily.map(entry => entry.date), ['2026-09-01', ...challengeDates]);
  assert.equal(result.daily[0].completedMs, 60_000);
  assert.equal(result.challenge.daily.length, 28);
  assert.ok(result.challenge.daily.every(entry => entry.completedMs === 0));
  assert.equal(result.challenge.remainingDays, 27);
});

test('splits an interval exactly at Moscow local midnight without double-counting either side', () => {
  const result = calculate([interval('2026-10-03T20:59:59.500Z', '2026-10-03T21:00:00.500Z')]);
  const before = result.daily.find(entry => entry.date === '2026-10-03');
  const after = result.daily.find(entry => entry.date === '2026-10-04');

  assert.equal(result.totalCompletedMs, 1_000);
  assert.equal(before.completedMs, 500);
  assert.equal(after.completedMs, 500);
  assert.equal(result.challenge.completedMs, 500);
  assert.equal(result.challenge.daily[0].completedMs, 500);
});

test('uses a real IANA midnight across DST and keeps remaining days calendar-based', () => {
  const challenge = {
    startDate: '2026-10-31',
    endDateExclusive: '2026-11-02',
    timeZone: 'America/New_York',
    days: 2,
    dailyTargetMs: 28_800_000,
    targetMs: 57_600_000,
  };
  const result = calculate(
    [interval('2026-11-01T03:30:00.000Z', '2026-11-01T07:30:00.000Z')],
    '2026-11-01T07:30:00.000Z',
    challenge,
  );

  assert.equal(result.totalCompletedMs, 14_400_000);
  assert.equal(result.challenge.daily[0].date, '2026-10-31');
  assert.equal(result.challenge.daily[0].completedMs, 1_800_000);
  assert.equal(result.challenge.daily[1].date, '2026-11-01');
  assert.equal(result.challenge.daily[1].completedMs, 12_600_000);
  assert.equal(result.challenge.remainingDays, 1);
});

test('challenge periods include today and handle before-start, final-day, and exclusive-end dates', () => {
  const empty = [];
  assert.equal(calculate(empty, '2026-10-03T20:59:59.999Z').challenge.remainingDays, 28);
  assert.equal(calculate(empty, '2026-10-04T00:00:00.000Z').challenge.remainingDays, 28);
  assert.equal(calculate(empty, '2026-10-31T20:59:59.999Z').challenge.remainingDays, 1);
  assert.equal(calculate(empty, '2026-10-31T21:00:00.000Z').challenge.remainingDays, 0);
  assert.equal(calculate(empty, '2026-11-02T12:00:00.000Z').challenge.remainingDays, 0);
});

test('percentages are uncapped and remaining average is exact', () => {
  const partial = calculate(
    [interval('2026-10-03T21:00:00.000Z', '2026-10-03T21:00:01.000Z')],
    '2026-10-04T00:00:00.000Z',
  );
  assert.equal(partial.challenge.requiredDailyMs, 806_399_000 / 28);

  const intervals = Array.from({ length: 28 }, (_, index) => {
    const start = Date.parse('2026-10-03T21:00:00.000Z') + index * 86_400_000;
    return interval(new Date(start).toISOString(), new Date(start + 32_400_000).toISOString());
  });
  const result = calculate(intervals);

  assert.equal(result.challenge.completedMs, 907_200_000);
  assert.equal(result.challenge.remainingMs, 0);
  assert.equal(result.challenge.percent, 112.5);
  assert.equal(result.challenge.achieved, true);
  assert.equal(result.challenge.closedDays, 28);
  assert.equal(result.challenge.requiredDailyMs, 0);
  assert.equal(result.challenge.daily.every(entry => entry.percent === 112.5 && entry.achieved), true);
});

test('rejects inconsistent interval milliseconds and unsafe full-history sums', () => {
  assert.throws(
    () => calculateStatistics({
      userId: 'user-a',
      version: 0,
      serverTime: '2026-10-05T12:00:00.000Z',
      timeZone: moscowChallenge.timeZone,
      challenge: moscowChallenge,
      completedIntervals: [{
        startedAt: '2026-10-04T00:00:00.000Z',
        stoppedAt: '2026-10-04T00:00:01.000Z',
        durationMs: 999,
      }],
    }),
    /INVALID_STATISTICS_INPUT/,
  );

  const overlong = milliseconds => interval(new Date(0).toISOString(), new Date(milliseconds).toISOString());
  assert.throws(
    () => calculate([overlong(8_000_000_000_000_000), overlong(2_000_000_000_000_000)]),
    /STATISTICS_EXHAUSTED/,
  );
});
