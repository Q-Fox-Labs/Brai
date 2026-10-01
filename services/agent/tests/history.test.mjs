// ABOUTME: Проверяет пагинацию и безопасное преобразование Codex history.
// ABOUTME: Фикстуры используют ThreadItemEntry и не сериализуют raw reasoning.
import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../dist/state.js";
import { readHistory } from "../dist/history.js";
import { validateDto } from "../contracts/index.mjs";

function harness(items) {
  const calls = [];
  const codex = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "thread/turns/list")
        return {
          data: [{ id: "turn-1", items: [], status: "completed" }],
          nextCursor: null,
        };
      return { data: items, nextCursor: "opaque-next" };
    },
  };
  return { codex, calls };
}
const entry = (id, item, turnId = "turn-1") => ({
  item: { id, ...item },
  turnId,
});

test("history retains native tool text and status without binary or metadata", async () => {
  const { codex } = harness([
    entry("mcp", { type: "mcpToolCall", arguments: {}, server: "fixture", tool: "read", status: "failed", result: { content: [{ type: "text", text: "native result" }, { type: "image", data: "BINARY" }], structuredContent: { secret: "HIDDEN" } }, error: { message: "native failure" } }),
    entry("dynamic", { type: "dynamicToolCall", arguments: {}, tool: "fixture", status: "completed", success: false, contentItems: [{ type: "inputText", text: "native dynamic" }, { type: "inputImage", imageUrl: "BINARY" }] }),
  ]);
  const out = await readHistory(codex, createState().put("p", "t", "/work"), { projectId: "p", threadId: "t" });
  assert.match(out.items[0].content, /status=failed\nnative result\nnative failure/);
  assert.match(out.items[1].content, /success=false\nnative dynamic/);
  assert.doesNotMatch(JSON.stringify(out), /BINARY|HIDDEN/);
  assert.ok(validateDto("HistoryResponse", out));
});

test("history preserves item order and ids, unwraps entries, redacts reasoning body", async () => {
  const { codex, calls } = harness([
    entry("r", {
      type: "reasoning",
      summary: ["safe summary"],
      content: [{ type: "text", text: "SECRET RAW REASONING" }],
    }),
    entry("m", { type: "agentMessage", text: "answer", phase: "final_answer" }),
  ]);
  const s = createState().put("p", "t", "/work");
  const out = await readHistory(codex, s, { projectId: "p", threadId: "t" });
  assert.deepEqual(
    out.items.map((x) => x.itemId),
    ["r", "m"],
  );
  assert.deepEqual(
    out.items.map((x) => x.order),
    [0, 1],
  );
  assert.equal(out.items[0].content, "safe summary");
  assert.doesNotMatch(JSON.stringify(out), /SECRET RAW/);
  assert.equal(out.items[1].turnId, "turn-1");
  assert.equal(out.items[1].trace.phase, "final_answer");
  assert.equal(calls[0].params.itemsView, "notLoaded");
  assert.ok(validateDto("HistoryResponse", out));
});

test("cursor is bound to project, thread, and requested turn", async () => {
  const { codex } = harness([
    entry("i", { type: "agentMessage", text: "one" }),
  ]);
  const state = createState(),
    s = state.put("p", "t", "/work");
  const first = await readHistory(codex, s, { projectId: "p", threadId: "t" });
  assert.ok(first.nextCursor);
  const second = await readHistory(codex, s, {
    projectId: "p",
    threadId: "t",
    cursor: first.nextCursor,
  });
  assert.equal(second.items[0].itemId, "i");
  await assert.rejects(
    readHistory(codex, s, {
      projectId: "other",
      threadId: "t",
      cursor: first.nextCursor,
    }),
    (e) => e.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    readHistory(codex, s, {
      projectId: "p",
      threadId: "t",
      turnId: "different",
      cursor: first.nextCursor,
    }),
    (e) => e.code === "INVALID_ARGUMENT",
  );
});

test("an explicit-turn cursor requires the same explicit turn on continuation", async () => {
  const { codex } = harness([
    entry("i", { type: "agentMessage", text: "one" }),
  ]);
  const session = createState().put("p", "t", "/work");
  const page = await readHistory(codex, session, {
    projectId: "p",
    threadId: "t",
    turnId: "turn-1",
  });
  await assert.rejects(
    readHistory(codex, session, {
      projectId: "p",
      threadId: "t",
      cursor: page.nextCursor,
    }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});

test("large escaped Unicode pages compact content without dropping ids or looping", async () => {
  const rows = Array.from({ length: 100 }, (_, i) =>
    entry(`id-${i}`, { type: "agentMessage", text: '😀"\\'.repeat(1000) }),
  );
  const { codex } = harness(rows);
  const s = createState().put("p", "t", "/work");
  const out = await readHistory(codex, s, {
    projectId: "p",
    threadId: "t",
    limit: 100,
  });
  assert.equal(out.items.length, 100);
  assert.deepEqual(
    out.items.map((x) => x.itemId),
    rows.map((x) => x.item.id),
  );
  assert.ok(out.truncation.truncated);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) <= 768 * 1024);
  assert.ok(out.items.every((x) => x.contentBytes > 0));
});

test("limits and malformed cursors are rejected", async () => {
  const { codex } = harness([]);
  const s = createState().put("p", "t", "/work");
  await assert.rejects(
    readHistory(codex, s, { projectId: "p", threadId: "t", limit: 101 }),
    (e) => e.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    readHistory(codex, s, {
      projectId: "p",
      threadId: "t",
      cursor: "not-base64-json",
    }),
    (e) => e.code === "INVALID_ARGUMENT",
  );
});

test("two-level cursor traverses every item page of every turn in source order", async () => {
  const calls = [];
  const codex = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "thread/turns/list") {
        return params.cursor
          ? {
              data: [{ id: "turn-2", items: [], status: "completed" }],
              nextCursor: null,
            }
          : {
              data: [{ id: "turn-1", items: [], status: "completed" }],
              nextCursor: "turns-next",
            };
      }
      if (params.turnId === "turn-1" && !params.cursor)
        return {
          data: [
            entry("a", { type: "agentMessage", text: "A" }),
            entry("b", { type: "agentMessage", text: "B" }),
          ],
          nextCursor: "items-next",
        };
      if (params.turnId === "turn-1")
        return {
          data: [entry("c", { type: "agentMessage", text: "C" })],
          nextCursor: null,
        };
      return {
        data: [
          entry("d", { type: "agentMessage", text: "D" }, "turn-2"),
          entry("e", { type: "agentMessage", text: "E" }, "turn-2"),
        ],
        nextCursor: null,
      };
    },
  };
  const session = createState().put("p", "t", "/work");
  const found = [];
  let cursor;
  do {
    const page = await readHistory(codex, session, {
      projectId: "p",
      threadId: "t",
      limit: 10,
      ...(cursor ? { cursor } : {}),
    });
    found.push(...page.items.map((item) => `${item.turnId}:${item.itemId}`));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(found, [
    "turn-1:a",
    "turn-1:b",
    "turn-1:c",
    "turn-2:d",
    "turn-2:e",
  ]);
  assert.equal(
    calls.filter((call) => call.method === "thread/items/list").length,
    3,
  );
  assert.deepEqual(
    calls
      .filter((call) => call.method === "thread/turns/list")
      .map((call) => call.params.cursor ?? null),
    [null, "turns-next"],
  );
});
