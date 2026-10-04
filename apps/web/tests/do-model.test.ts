// ABOUTME: Проверяет перенос, пересчёт номеров и статусов синтетического задачника.
// ABOUTME: Использует только локальные данные; БД, HTTP и React не запускаются.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createDemoTasks } from "../app/do/demo.ts";
import { canMoveTask, collectTaskAndDescendantIds, computeRelativeNumbers, groupTasksByParent, orderTaskTree, taskTreeProjectId, updateLocalTask } from "../app/do/model.ts";

test("collapse hides descendants without changing their numbers or data", () => {
  const tasks = createDemoTasks(), numbers = computeRelativeNumbers(tasks);
  const rows = orderTaskTree(tasks, groupTasksByParent(tasks), new Set(["q-workspace"]));
  assert.ok(rows.some(task => task.id === "q-workspace"));
  assert.ok(!rows.some(task => task.id === "g-interface"));
  assert.equal(numbers.get("t-tree"), "M-101-1-1-3");
  assert.equal(numbers.size, tasks.length);
  assert.equal(tasks.find(task => task.id === "t-tree")?.parentId, "g-interface");
});

test("moving a task renumbers both branches and preserves its public ID", () => {
  const before = createDemoTasks();
  const next = updateLocalTask(before, "t-tree", { parentId: "g-focus", siblingOrder: ["t-tree", "t-focus-1", "t-focus-2", "t-focus-3", "t-focus-4"] });
  const numbers = computeRelativeNumbers(next);
  assert.equal(numbers.get("t-tree"), "M-101-1-2-1");
  assert.equal(numbers.get("t-drag"), "M-101-1-1-3");
  assert.equal(next.find(task => task.id === "t-tree")?.publicId, before.find(task => task.id === "t-tree")?.publicId);
  assert.equal(before.find(task => task.id === "t-tree")?.parentId, "g-interface");
  assert.equal(updateLocalTask(next, "t-tree", { parentId: null }).find(task => task.id === "t-tree")?.parentId, null);
});

test("invalid parents and cycles are rejected for every hierarchy level", () => {
  const tasks = createDemoTasks();
  assert.equal(canMoveTask(tasks, "t-tree", "m-brai"), false);
  assert.equal(canMoveTask(tasks, "q-workspace", "g-interface"), false);
  assert.equal(canMoveTask(tasks, "m-brai", "m-brai"), false);
  assert.equal(canMoveTask(tasks, "t-tree", "missing"), false);
  assert.deepEqual(updateLocalTask(tasks, "q-workspace", { parentId: "g-interface" }), tasks);
  assert.equal(canMoveTask(tasks, "q-workspace", "m-personal"), true);
  assert.equal(canMoveTask(tasks, "g-interface", "q-home"), true);
  assert.equal(canMoveTask(tasks, "t-tree", "g-home"), true);
});

test("project changes follow a complete branch, including after a cross-project move", () => {
  const tasks = createDemoTasks();
  const moved = updateLocalTask(tasks, "g-interface", { parentId: "q-home" });
  const branch = collectTaskAndDescendantIds("g-interface", groupTasksByParent(moved));
  assert.ok(moved.filter(task => branch.has(task.id)).every(task => task.projectId === "personal"));
  const byId = new Map(moved.map(task => [task.id, task]));
  assert.equal(taskTreeProjectId(byId.get("t-tree")!, byId), "personal");
  const changed = updateLocalTask(tasks, "m-brai", { projectId: "learning" });
  const whole = collectTaskAndDescendantIds("m-brai", groupTasksByParent(changed));
  assert.ok(changed.filter(task => whole.has(task.id)).every(task => task.projectId === "learning"));
});

test("blockers protect completion and parent progress follows closed children", () => {
  let tasks = createDemoTasks();
  assert.equal(updateLocalTask(tasks, "t-mobile", { status: "completed" }).find(task => task.id === "t-mobile")?.status, "active");
  tasks = updateLocalTask(tasks, "t-tree", { status: "completed" });
  tasks = updateLocalTask(tasks, "t-mobile", { status: "completed" });
  tasks = updateLocalTask(tasks, "t-drag", { status: "not_completed" });
  assert.equal(tasks.find(task => task.id === "g-interface")?.status, "completed");
  assert.equal(tasks.find(task => task.id === "q-workspace")?.status, "active");
  tasks = updateLocalTask(tasks, "t-reference", { status: "active" });
  assert.equal(tasks.find(task => task.id === "g-interface")?.status, "active");
  assert.equal(updateLocalTask(tasks, "g-interface", { kind: "task" }).find(task => task.id === "g-interface")?.isGoal, true);
});
