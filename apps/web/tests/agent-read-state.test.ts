// ABOUTME: Проверяет подтверждение прочтения, перенос legacy marks и повтор после отказа хранилища.
// ABOUTME: Использует реальные правила UI через синтетические HTTP-порты и browser storage.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReadStateSync, unreadFinal } from "../lib/agent/read-state.ts";
import type { ReadState } from "@brai/agent/contracts";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const mark = (messageId: string, lastMessageAt = 100) => ({ projectId: "project", threadId: "thread", messageId, lastMessageAt });
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
test("legacy migration retains marks until durable ack, survives reload and does not hide a new final", async () => {
  const store = storage(); store.setItem("brai.agent.read:user", JSON.stringify({ "project:thread": "old" }));
  let fail = true, state: ReadState = { marks: {} }, error = "";
  const writes: ReturnType<typeof mark>[] = [];
  const ports = { userId: "user", storage: store, read: async () => ({ marks: {} }), mark: async (value: ReturnType<typeof mark>) => { writes.push(value); if (fail) throw new Error("offline"); return { marks: { "project:thread": [value.messageId] } }; }, update: (value: ReadState, problem: string) => { state = value; error = problem; } };
  const first = createReadStateSync(ports); await first.sync();
  assert.ok(error); assert.equal(state.marks["project:thread"], undefined);
  assert.equal(store.getItem("brai.agent.read:user"), '{"project:thread":"old"}');
  first.dispose(); fail = false;
  const reloaded = createReadStateSync(ports); await reloaded.sync();
  assert.deepEqual(writes, [mark("old", 0), mark("old", 0)]);
  assert.equal(store.getItem("brai.agent.read:user"), null); assert.equal(error, "");
  const thread = { id: "thread", title: "", preview: "", model: null, canAcceptDirectInput: true, updatedAt: 1, finalMessageId: "new" };
  assert.equal(unreadFinal("project", thread, state.marks), true);
  assert.equal(unreadFinal("project", { ...thread, finalMessageId: "old" }, state.marks), false);
  assert.equal(unreadFinal("project", { ...thread, active: true }, state.marks), false);
  assert.equal(unreadFinal("project", { ...thread, awaitingReply: true }, state.marks), false);
  reloaded.dispose();
});
test("visible final waits for ack, another seen during flush drains, and dispose ignores late replies", async () => {
  const store = storage(); let state: ReadState = { marks: {} }, release: () => void = () => {};
  const writes: string[] = [];
  const sync = createReadStateSync({ userId: "user", storage: store, read: async () => state, mark: async value => { writes.push(value.messageId); if (value.messageId === "first") await new Promise<void>(resolve => { release = resolve; }); return { marks: { "project:thread": [value.messageId] } }; }, update: value => { state = value; } });
  sync.seen(mark("first")); await tick();
  assert.deepEqual(state.marks, {}); assert.ok(store.getItem("brai.agent.read-pending:user"));
  sync.seen(mark("second", 200)); release(); await sync.sync();
  assert.deepEqual(writes, ["first", "second"]); assert.deepEqual(state.marks["project:thread"], ["second"]);
  assert.equal(store.getItem("brai.agent.read-pending:user"), null); sync.dispose();
  let updates = 0, finish: (value: ReadState) => void = () => {};
  const closed = createReadStateSync({ userId: "user", storage: store, read: () => new Promise(resolve => { finish = resolve; }), mark: async () => ({ marks: {} }), update: () => { updates++; } });
  const pending = closed.sync(); closed.dispose(); finish({ marks: { "project:thread": ["late"] } }); await pending;
  assert.equal(updates, 0);
});
test("failed new marks persist across reload and remote polling clears another browser's unread final", async () => {
  const store = storage(); let current: ReadState = { marks: {} }, state: ReadState = current;
  const first = createReadStateSync({ userId: "user", storage: store, read: async () => current, mark: async () => { throw new Error("unknown outcome"); }, update: value => { state = value; } });
  first.seen(mark("final")); await first.sync(); first.dispose();
  assert.deepEqual(state.marks, {}); assert.ok(store.getItem("brai.agent.read-pending:user"));
  const reloaded = createReadStateSync({ userId: "user", storage: store, read: async () => current, mark: async value => current = { marks: { "project:thread": [value.messageId] } }, update: value => { state = value; } });
  await reloaded.sync(); assert.deepEqual(state.marks["project:thread"], ["final"]);
  current = { marks: { "project:thread": ["from-other-browser"] } }; await reloaded.sync();
  assert.deepEqual(state, current); assert.equal(store.getItem("brai.agent.read-pending:user"), null); reloaded.dispose();
});
test("orphan legacy project remains pending without blocking a current final or hiding the failure", async () => {
  const store = storage(); store.setItem("brai.agent.read:user", '{"deleted:thread":"legacy"}');
  let state: ReadState = { marks: {} }, error = "";
  const sync = createReadStateSync({ userId: "user", storage: store, read: async () => state, mark: async value => { if (value.projectId === "deleted") throw Object.assign(new Error("not found"), { code: "NOT_FOUND" }); return { marks: { "project:thread": [value.messageId] } }; }, update: (value, problem) => { state = value; error = problem; } });
  sync.seen(mark("current")); await sync.sync();
  assert.deepEqual(state.marks["project:thread"], ["current"]); assert.ok(error);
  assert.equal(store.getItem("brai.agent.read:user"), '{"deleted:thread":"legacy"}');
  assert.match(store.getItem("brai.agent.read-pending:user")!, /deleted/); sync.dispose();
});
test("invalid ack keeps pending and known read state intact", async () => {
  const store = storage(); let state: ReadState = { marks: {} }, error = "";
  const known = { marks: { "project:other": ["already-read"] } };
  const sync = createReadStateSync({ userId: "user", storage: store, read: async () => known, mark: async () => ({ marks: { "project:thread": "bad" } }) as unknown as ReadState, update: (value, problem) => { state = value; error = problem; } });
  sync.seen(mark("final")); await sync.sync();
  assert.deepEqual(state, known); assert.ok(error); assert.ok(store.getItem("brai.agent.read-pending:user")); sync.dispose();
});
