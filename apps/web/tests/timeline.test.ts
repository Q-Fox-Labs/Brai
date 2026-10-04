// ABOUTME: Проверяет порядок пересекающихся окон истории и живых сообщений.
// ABOUTME: Воспроизводит исчезнувший из конца ленты итог без сервера и модельных вызовов.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTimeline, reconcileCorrections, type PendingCorrection } from "../app/agent/timeline.ts";
import type { DisplayItem } from "@brai/agent/contracts";
const item = (id: string, text = id): DisplayItem => ({ id, text, turnId: "turn", type: "agentMessage" });
const ids = (items: DisplayItem[]) => items.map(value => value.id);

test("старый префикс живого окна не оказывается после итогового ответа", () => {
  const history = Array.from({ length: 100 }, (_, i) => item(String(i + 28)));
  const live = Array.from({ length: 128 }, (_, i) => item(String(i)));
  live[127].phase = "final_answer";
  const result = mergeTimeline(history, live);
  assert.deepEqual(ids(result), ids(live));
  assert.equal(result.at(-1)?.phase, "final_answer");
});
test("загруженная ранняя история и новые события остаются на своих местах", () => {
  assert.deepEqual(ids(mergeTimeline([item("a"), item("b"), item("c")], [item("b"), item("c"), item("d")])), ["a", "b", "c", "d"]);
});
test("сохранённый итог остаётся последним, пока живое окно догоняет историю", () => {
  assert.deepEqual(ids(mergeTimeline([item("b"), item("c"), item("final")], [item("a"), item("b"), item("c")])), ["a", "b", "c", "final"]);
});
test("пропущенный живым окном элемент остаётся между общими сообщениями", () => {
  const result = mergeTimeline([item("a"), item("b"), item("c")], [item("a", "новый текст"), item("c")]);
  assert.deepEqual(ids(result), ["a", "b", "c"]);
  assert.equal(result[0].text, "новый текст");
});
test("пустое и непересекающееся новое окно", () => {
  assert.deepEqual(ids(mergeTimeline([item("a")], [])), ["a"]);
  assert.deepEqual(ids(mergeTimeline([item("a")], [item("b")])), ["a", "b"]);
});

const correction = (id = "local", state: PendingCorrection["state"] = "waiting"): PendingCorrection => ({
  chat: "p:t", generation: "g", knownIds: ["old"], state,
  item: { id, turnId: "turn", type: "userMessage", text: "Исправь", imageCount: 0 },
});
const user = (id: string, text = "Исправь"): DisplayItem => ({ id, turnId: "turn", type: "userMessage", text });

test("корректировка остаётся видна при задержке native истории и после accepted", () => {
  for (const state of ["sending", "waiting", "unknown"] as const) {
    const pending = correction("local", state);
    assert.deepEqual(reconcileCorrections([pending], "p:t", "g", [user("old"), item("activity")]), [pending]);
    assert.deepEqual(reconcileCorrections([pending], "p:t", "g", [user("new")]), []);
  }
});
test("подтверждение не относится к другому чату, поколению, ходу или ошибке отправки", () => {
  const pending = correction();
  assert.equal(reconcileCorrections([pending], "p:other", "g", [user("new")]).length, 1);
  assert.equal(reconcileCorrections([pending], "p:t", "next", [user("new")]).length, 1);
  assert.equal(reconcileCorrections([pending], "p:t", "g", [{ ...user("new"), turnId: "other" }]).length, 1);
  assert.equal(reconcileCorrections([correction("failed", "failed")], "p:t", "g", [user("new")]).length, 1);
});
test("один native item не подтверждает две одинаковые корректировки на повторных снимках", () => {
  const remaining = reconcileCorrections([correction("one"), correction("two")], "p:t", "g", [user("native-one")]);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].item.id, "two");
  assert.equal(reconcileCorrections(remaining, "p:t", "g", [user("native-one")]).length, 1);
  assert.equal(reconcileCorrections(remaining, "p:t", "g", [user("native-one"), user("native-two")]).length, 0);
});
test("сокращённая история подтверждает длинный текст, число изображений должно совпадать", () => {
  const pending = correction();
  pending.item.text = "Длинный текст".repeat(1000);
  assert.equal(reconcileCorrections([pending], "p:t", "g", [user("new", "Длинный текст")]).length, 1);
  assert.equal(reconcileCorrections([pending], "p:t", "g", [{ ...user("new", "Длинный текст\n[содержимое сокращено]"), truncated: true }]).length, 0);
  assert.equal(reconcileCorrections([correction()], "p:t", "g", [{ ...user("new"), imageCount: 1 }]).length, 1);
});
