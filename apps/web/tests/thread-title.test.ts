// ABOUTME: Проверяет название нового чата при гонках списка и живых событий.
// ABOUTME: Слияние исполняется без Codex, сетевых запросов и модельных ходов.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeThreadMetadata } from "../lib/agent/thread.ts";
import type { ThreadMetadata } from "@brai/agent/contracts";
const empty: ThreadMetadata = { id: "new-chat", title: "", preview: "", model: null, canAcceptDirectInput: true, updatedAt: 1, active: false };
const named = { ...empty, title: "Настроить уведомления", preview: "Настроить уведомления в приложении" };
test("new chat keeps its first title through live updates and completed state", () => {
  let shown = mergeThreadMetadata(empty, named);
  for (const active of [true, false]) {
    shown = mergeThreadMetadata(shown, { ...empty, active, updatedAt: 2, lastMessageAt: 20 });
    assert.equal(shown.title, named.title); assert.equal(shown.preview, named.preview);
    assert.equal(shown.active, active); assert.equal(shown.lastMessageAt, 20);
  }
});
test("a delayed list supplies the name while newer SSE retains activity and order", () => {
  const shown = mergeThreadMetadata(named, { ...empty, active: true, updatedAt: 3, lastMessageAt: 30 });
  assert.equal(shown.title, named.title); assert.equal(shown.active, true); assert.equal(shown.updatedAt, 3); assert.equal(shown.lastMessageAt, 30);
});
test("new native name or preview replaces previous fields; a foreign chat inherits nothing", () => {
  const renamed = { ...empty, title: "Изменить уведомления", updatedAt: 4 };
  assert.deepEqual(mergeThreadMetadata(named, renamed), renamed);
  const preview = { ...empty, preview: "Первое сообщение" };
  assert.deepEqual(mergeThreadMetadata(named, preview), preview);
  assert.deepEqual(mergeThreadMetadata(named, { ...empty, id: "other" }), { ...empty, id: "other" });
  assert.deepEqual(mergeThreadMetadata(undefined, empty), empty);
});
