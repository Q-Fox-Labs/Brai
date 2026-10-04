// ABOUTME: Проверяет скорость, границы и остановку автопрокрутки во время переноса дел.
// ABOUTME: Выполняет настоящий обработчик с управляемыми часами; браузер и БД не нужны.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { sortTasksByOrder } from "../app/do/model.ts";
import type { useTaskDrag } from "../app/do/use-task-drag.ts";

function createDragHarness(active = true) {
  let nextFrame = 0, scrollTop = 0;
  const frames = new Map<number, (timestamp: number) => void>(), effects: (() => (() => void))[] = [];
  const scrollElement = { scrollBy: (_x: number, y: number) => { scrollTop += y; } };
  const module = { exports: {} as { useTaskDrag: typeof useTaskDrag } };
  const js = ts.transpileModule(readFileSync(new URL("../app/do/use-task-drag.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require: (name: string) => name === "react"
    ? { useRef: (current: unknown) => ({ current }), useState: (value: unknown) => [value, () => {}], useEffect: (effect: () => () => void) => effects.push(effect) }
    : { sortTasksByOrder }, window: {
      requestAnimationFrame: (callback: (timestamp: number) => void) => { frames.set(++nextFrame, callback); return nextFrame; },
      cancelAnimationFrame: (id: number) => frames.delete(id),
    } });
  const drag = module.exports.useTaskDrag({ tasks: [], childTasksByParent: new Map(), active, setCollapsedContainerIds: () => {}, updateTask: () => {} });
  const cleanups = effects.map(effect => effect());
  const dataTransfer = { effectAllowed: "", dropEffect: "", setData() {} };
  drag.startDragging({ target: { closest: (query: string) => query.includes("input") ? null : scrollElement }, dataTransfer } as never, { id: "demo" } as never, "left");
  const over = (y: number) => ({ preventDefault() {}, stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 100, bottom: 500 }) }, dataTransfer, clientY: y });
  const tick = (timestamp: number) => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(timestamp)); };
  return { drag, over, tick, cleanups, frames, get scrollTop() { return scrollTop; } };
}

test("autoscroll accelerates near an edge, changes direction and stops on drag end", () => {
  const h = createDragHarness();
  h.drag.updateDragScrolling(h.over(455) as never, "bottom");
  h.tick(0); for (let time = 16; time <= 160; time += 16) h.tick(time);
  assert.ok(Math.abs(h.scrollTop - 11.52) < 0.001);
  const beforeFast = h.scrollTop;
  h.drag.updateDragScrolling(h.over(495) as never, "bottom");
  assert.equal(h.frames.size, 1);
  for (let time = 176; time <= 320; time += 16) h.tick(time);
  assert.ok(Math.abs(h.scrollTop - beforeFast - 34.56) < 0.001);
  const beforeReverse = h.scrollTop;
  h.drag.updateDragScrolling(h.over(105) as never, "top");
  h.tick(336);
  assert.ok(h.scrollTop < beforeReverse);
  h.drag.finishDragging();
  assert.equal(h.frames.size, 0);
  const stopped = h.scrollTop;
  h.tick(500);
  assert.equal(h.scrollTop, stopped);
});

test("a paused frame cannot jump the list; leaving the edge and unmount cancel the scheduler", () => {
  const h = createDragHarness();
  h.drag.updateDragScrolling(h.over(495) as never, "bottom");
  h.tick(0); h.tick(5000);
  assert.ok(h.scrollTop < 15);
  h.drag.stopDragScrolling();
  assert.equal(h.frames.size, 0);
  h.drag.updateDragScrolling(h.over(495) as never, "bottom");
  assert.equal(h.frames.size, 1);
  h.cleanups.forEach(cleanup => cleanup());
  assert.equal(h.frames.size, 0);
});
