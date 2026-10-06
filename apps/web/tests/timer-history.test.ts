// ABOUTME: Проверяет группировку и правила изменения canonical истории таймера.
// ABOUTME: Покрывает московскую полночь, точность timestamp и запрет пересечений.
import test from "node:test";
import assert from "node:assert/strict";
import type { Active, Interval } from "../lib/types.ts";
import { applyEditInput, applyEditStep, createEditDraft, draftChanged, draftRange, editRangeError, formatEditValue, formatIntervalEdge, groupIntervalsByMoscowDate } from "../app/timer-history-model.ts";

const interval = (timerId: string, startedAt: string, stoppedAt: string): Interval => ({ timerId, startedAt, stoppedAt, durationMs: Date.parse(stoppedAt) - Date.parse(startedAt) });
const base = interval("a", "2026-10-04T20:50:12.345Z", "2026-10-04T21:20:47.678Z");

test("midnight display splits both days in exact milliseconds and preserves canonical mutations", () => {
 const original = interval("overnight", "2026-10-03T20:59:59.250Z", "2026-10-03T21:00:01.750Z");
 const groups = groupIntervalsByMoscowDate([original]);
 assert.deepEqual(groups.map(day => day.date), ["2026-10-04", "2026-10-03"]);
 assert.deepEqual(groups.map(day => day.items[0].durationMs), [1750, 750]);
 assert.deepEqual(groups.map(day => day.items[0].rowId), ["2026-10-04:overnight", "2026-10-03:overnight"]);
 assert.equal(groups.reduce((total, day) => total + day.items[0].durationMs, 0), original.durationMs);
 for (const day of groups) {
  const segment = day.items[0];
  assert.equal(segment.split, true);
  assert.equal(segment.interval, original);
  assert.equal(formatIntervalEdge(segment.stoppedAt), "00:00");
  const draft = createEditDraft(segment.interval)!;
  assert.equal(draft.timerId, original.timerId);
  assert.deepEqual(draftRange(draft), { startedAt: original.startedAt, stoppedAt: original.stoppedAt });
  const shifted = applyEditStep(draft, "start", 1)!;
  assert.deepEqual(draftRange(shifted), { startedAt: "2026-10-03T21:04:59.250Z", stoppedAt: "2026-10-03T21:05:01.750Z" });
  assert.equal(shifted.endMs - shifted.startMs, 2500);
 }
});

test("exclusive midnight endpoint adds no next day and long sessions cover every day", () => {
 const untilMidnight = interval("exclusive", "2026-10-03T20:59:59.250Z", "2026-10-03T21:00:00.000Z");
 const exclusive = groupIntervalsByMoscowDate([untilMidnight]);
 assert.deepEqual(exclusive.map(day => day.date), ["2026-10-03"]);
 assert.equal(exclusive[0].items[0].durationMs, 750);
 assert.equal(exclusive[0].items[0].split, false);
 const long = interval("long", "2026-10-03T20:00:00.125Z", "2026-10-05T22:00:00.875Z");
 const groups = groupIntervalsByMoscowDate([long]);
 assert.deepEqual(groups.map(day => day.date), ["2026-10-06", "2026-10-05", "2026-10-04", "2026-10-03"]);
 assert.equal(groups.flatMap(day => day.items).reduce((sum, row) => sum + row.durationMs, 0), long.durationMs);
 assert.equal(new Set(groups.flatMap(day => day.items.map(row => row.rowId))).size, 4);
});

test("start time edit shifts both endpoints and preserves seconds and milliseconds", () => {
 const draft = createEditDraft(base)!;
 const changed = applyEditInput(draft, "start", "23:55")!;
 assert.deepEqual(draftRange(changed), { startedAt: "2026-10-04T20:55:12.345Z", stoppedAt: "2026-10-04T21:25:47.678Z" });
 assert.equal(changed.endMs - changed.startMs, draft.endMs - draft.startMs);
});

test("duration edit keeps millisecond tail and end edit preserves endpoint tail", () => {
 const draft = createEditDraft(base)!;
 const duration = applyEditInput(draft, "duration", "00:45")!;
 assert.equal(duration.endMs - duration.startMs, 45 * 60_000 + 35_333);
 const end = applyEditInput(draft, "end", "00:35")!;
 assert.equal(new Date(end.endMs).toISOString(), "2026-10-04T21:35:47.678Z");
});

test("five-minute steps, invalid ranges, overlaps, and active timer", () => {
 const draft = createEditDraft(base)!;
 assert.equal(applyEditStep(draft, "start", 1)!.endMs - applyEditStep(draft, "start", 1)!.startMs, draft.endMs - draft.startMs);
 assert.equal(applyEditInput(draft, "duration", "00:00"), null);
 const overlapping = interval("b", "2026-10-04T21:15:00.000Z", "2026-10-04T21:30:00.000Z");
 assert.match(editRangeError(draft, [base, overlapping], null)!, /пересекается/);
 const active: Active = { timerId: "active", startedAt: "2026-10-04T21:10:00.000Z" };
 assert.match(editRangeError(draft, [base], active)!, /активным таймером/);
 const touching = interval("touching", base.stoppedAt, "2026-10-04T21:30:47.678Z");
 assert.equal(editRangeError(draft, [base, touching], null), null);
 const sameDay = createEditDraft(interval("same-day", "2026-10-04T18:50:12.345Z", "2026-10-04T19:20:47.678Z"))!;
 assert.equal(applyEditInput(sameDay, "end", "21:49"), null);
});

test("cancel is discard-only and a no-op save preserves canonical milliseconds", () => {
 const draft = createEditDraft(base)!;
 const noOp = applyEditInput(draft, "start", formatEditValue("start", draft.startMs, draft.endMs))!;
 const noOpEnd = applyEditInput(noOp, "end", formatEditValue("end", noOp.startMs, noOp.endMs))!;
 const noOpDuration = applyEditInput(noOpEnd, "duration", formatEditValue("duration", noOpEnd.startMs, noOpEnd.endMs))!;
 assert.equal(draftChanged(noOpDuration), false);
 assert.deepEqual(draftRange(noOpDuration), { startedAt: base.startedAt, stoppedAt: base.stoppedAt });
 assert.equal(draftChanged(draft), false);
 assert.equal(draftRange(draft).startedAt, base.startedAt);
 assert.equal(draftRange(draft).stoppedAt, base.stoppedAt);
 assert.equal(draftChanged(applyEditStep(draft, "end", 1)!), true);
});
