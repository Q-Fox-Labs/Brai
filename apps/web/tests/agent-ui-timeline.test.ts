// ABOUTME: Проверяет объединение native history с отдельной live-трассой.
// ABOUTME: Исторический order и последовательность live событий не сравниваются.
import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@ag-ui/core";
import type { HistoryItem, ThreadSnapshot } from "@brai/agent/contracts";
import { buildAgentTimeline } from "../app/agent/timeline.ts";

const historyItem = (itemId: string, order: number, type: HistoryItem["trace"]["type"] = "command"): HistoryItem => ({
  itemId, order, kind: type, content: `history ${itemId}`, truncated: false, contentBytes: 10, turnId: "turn",
  trace: { type, status: "completed", ...(type === "message" ? { phase: "final_answer" as const } : {}) },
});
const traceItem = (itemId: string, order: number, type: HistoryItem["trace"]["type"] = "command"): ThreadSnapshot["traceItems"][number] => ({
  ...historyItem(itemId, order, type), content: `live ${itemId}`,
});

test("native history slots survive unrelated live seq and SDK tool traces stay by their parent", () => {
  const assistant = { id: "message", role: "assistant", content: "Ответ", toolCalls: [{ id: "tool-call", type: "function", function: { name: "shell", arguments: "{}" } }] } as Message;
  const latest = [traceItem("command", 1), traceItem("tool-call", 2), traceItem("later-a", 0), traceItem("later-b", 1)];
  const result = buildAgentTimeline(
    [historyItem("message", 200, "message"), historyItem("command", 100)],
    latest,
    [assistant, { id: "new-sdk-message", role: "assistant", content: "Новое" } as Message],
    { message: "final_answer" },
  );

  assert.deepEqual(result.map(entry => entry.kind === "trace" ? entry.item.itemId : entry.message.id), [
    "command", "message", "tool-call", "new-sdk-message", "later-a", "later-b",
  ]);
  assert.equal(result[0]?.kind === "trace" && result[0].item.content, "live command");
  assert.equal(result[1]?.kind === "message" && result[1].phase, "final_answer");
});
