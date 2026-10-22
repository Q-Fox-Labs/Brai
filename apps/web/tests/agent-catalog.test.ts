// ABOUTME: Проверяет видимость вкладки, отсутствие параллельного опроса и сохранение диапазона каталога.
// ABOUTME: Синтетические страницы не запускают Agent и не читают пользовательскую историю.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readAllThreads, readThreadRange, startCatalogPolling } from "../lib/agent/catalog.ts";
const thread = (id: number) => ({ id: String(id), title: `Thread ${id}`, preview: "", model: null, canAcceptDirectInput: true, updatedAt: id });
test("full project metadata includes later pages beyond the visible range and rejects partial totals", async () => {
  let calls = 0;
  const all = await readAllThreads(async cursor => {
    calls++;
    const start = cursor ? 1000 : 0;
    return { generation: "g", data: Array.from({ length: 1000 }, (_, index) => thread(start + index)), nextCursor: cursor ? null : "later" };
  });
  assert.equal(calls, 2); assert.equal(all.data.length, 2000); assert.equal(all.nextCursor, null);
  await assert.rejects(readAllThreads(async cursor => { if (cursor) throw new Error("offline"); return { generation: "g", data: [thread(1)], nextCursor: "later" }; }), /offline/);
  await assert.rejects(readAllThreads(async cursor => ({ generation: cursor ? "other" : "g", data: [thread(1)], nextCursor: cursor ? null : "later" })), /Каталог обновился/);
  await assert.rejects(readAllThreads(async () => ({ generation: "g", data: [], nextCursor: "loop" })), /продолжение/);
});
test("refresh retains the loaded range and cursor with new first-page chats", async () => {
  const calls: (string | undefined)[] = [];
  const result = await readThreadRange(async cursor => {
    calls.push(cursor);
    const start = cursor === "second" ? 20 : cursor === "third" ? 40 : 0;
    return { generation: "g", data: Array.from({ length: 20 }, (_, index) => thread(start + index)), nextCursor: start === 40 ? "fourth" : start === 20 ? "third" : "second" };
  }, 45);
  assert.deepEqual(calls, [undefined, "second", "third"]);
  assert.equal(result.data.length, 60); assert.equal(result.nextCursor, "fourth");
});
test("range remains bounded and incomplete refresh rejects atomically", async () => {
  const full = await readThreadRange(async () => ({ generation: "g", data: Array.from({ length: 1100 }, (_, index) => thread(index)), nextCursor: "next" }), 1000);
  assert.equal(full.data.length, 1000); assert.equal(full.nextCursor, null);
  let reads = 0;
  const previous = [thread(1), thread(2)];
  await assert.rejects(readThreadRange(async () => { if (++reads > 1) throw new Error("offline"); return { generation: "g", data: [thread(3)], nextCursor: "next" }; }, previous.length), /offline/);
  assert.deepEqual(previous.map(value => value.id), ["1", "2"]);
  let generation = 0;
  await assert.rejects(readThreadRange(async () => ({ generation: String(++generation), data: [thread(generation)], nextCursor: "next" }), 2), /Каталог обновился/);
  await assert.rejects(readThreadRange(async () => ({ generation: "g", data: [], nextCursor: "same" }), 2), /продолжение/);
});
test("ten-second polling respects visibility, suppresses overlap, resumes and stops", async context => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const visibility = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  let active = true, calls = 0, release: () => void = () => {};
  const stop = startCatalogPolling(async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); }, () => active, visibility);
  context.mock.timers.tick(9999); assert.equal(calls, 0);
  context.mock.timers.tick(1); assert.equal(calls, 1);
  context.mock.timers.tick(20000); visibility.dispatchEvent(new Event("visibilitychange")); assert.equal(calls, 1);
  release(); await Promise.resolve(); await Promise.resolve();
  visibility.visibilityState = "hidden"; context.mock.timers.tick(10000); assert.equal(calls, 1);
  visibility.visibilityState = "visible"; visibility.dispatchEvent(new Event("visibilitychange")); assert.equal(calls, 2);
  release(); await Promise.resolve(); await Promise.resolve();
  active = false; context.mock.timers.tick(10000); assert.equal(calls, 2);
  stop(); active = true; visibility.dispatchEvent(new Event("visibilitychange")); context.mock.timers.tick(10000); assert.equal(calls, 2);
});
