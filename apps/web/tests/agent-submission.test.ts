// ABOUTME: Проверяет замену оптимистичного сообщения точным подтверждением.
// ABOUTME: Чужой чат, одинаковый текст и поздние изменения не теряются.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileCorrections, type PendingCorrection } from "../app/agent/timeline.ts";

test("optimistic submission reconciles by exact native operation, never by text", () => {
  const pending: PendingCorrection = { chat: "p:t", generation: "g", knownIds: [], state: "unknown", draft: { text: "same", revision: 1, images: [] }, item: { id: "operation", type: "userMessage", turnId: "", text: "same" } };
  const native = { id: "native", type: "userMessage", turnId: "turn", text: "same" };
  assert.equal(reconcileCorrections([pending], "p:t", "g", [native]).length, 1);
  assert.equal(reconcileCorrections([pending], "p:other", "g", [{ ...native, operationId: "operation" }]).length, 1);
  assert.equal(reconcileCorrections([pending], "p:t", "g", [{ ...native, operationId: "operation" }]).length, 0);
  assert.equal(reconcileCorrections([pending], "p:t", "g", [{ ...native, operationId: "other" }]).length, 1);
});
