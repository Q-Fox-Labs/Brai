// ABOUTME: Проверяет видимость материалов и границы выполнения native планов и целей.
// ABOUTME: Не подменяет историю; моделирует обновления снимка и локальный выбор документа.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DisplayItem, NativeSnapshot, AgentGoal } from "@brai/agent/contracts";
import { collectMaterials, emptyMaterialView, executionText, goalBlocksNewTask, openMaterial, reconcileMaterialView } from "../app/agent/materials-model.ts";

const plan = (text = "# План\n\n1. Сделать работу", status = "completed"): DisplayItem => ({ id: "plan-1", turnId: "turn-1", type: "plan", text, status });
const snapshot = (status: AgentGoal["status"]): NativeSnapshot => ({ projectId: "p", threadId: "chat", generation: "g", epoch: "e", seq: 1, thread: { id: "chat", title: "", preview: "", model: null, canAcceptDirectInput: true, updatedAt: 0 }, turn: null, state: "idle", items: [], requests: [], truncated: false, planProgress: { state: "unavailable", turnId: null, explanation: null, steps: [], truncated: false }, goal: { state: "ready", value: { threadId: "chat", objective: "Закончить работу", status, timeUsedSeconds: 10, tokensUsed: 20, tokenBudget: null, createdAt: 1, updatedAt: 2 } } });

test("new document opens once; closed streaming updates stay closed and mark updated", () => {
  let state = reconcileMaterialView(emptyMaterialView(), collectMaterials([plan("draft", "inProgress")], null));
  assert.equal(state.open, true); assert.equal(state.focus, false);
  state = { ...state, open: false };
  const completed = collectMaterials([plan("authoritative completed")], null);
  state = reconcileMaterialView(state, completed);
  assert.equal(state.open, false); assert.deepEqual(state.updated, ["plan:plan-1"]);
  const reopened = openMaterial(state, "plan:plan-1");
  assert.equal(reopened.open, true); assert.equal(reopened.focus, true); assert.deepEqual(reopened.updated, []);
  assert.equal(executionText((completed[0] as { item: DisplayItem }).item), "Реализуй следующий согласованный план:\n\nauthoritative completed");
});

test("selection falls back when goal disappears and the last removed material closes the panel", () => {
  const goal = collectMaterials([], snapshot("active"));
  const state = reconcileMaterialView(emptyMaterialView(), goal);
  assert.equal(reconcileMaterialView(state, []).open, false);
  const both = collectMaterials([plan()], snapshot("active"));
  const selectedGoal = reconcileMaterialView(emptyMaterialView(), both);
  assert.equal(reconcileMaterialView(selectedGoal, collectMaterials([plan()], null)).selected, "plan:plan-1");
  assert.deepEqual(reconcileMaterialView({ ...selectedGoal, updated: [selectedGoal.selected] }, collectMaterials([plan()], null)).updated, []);
});

test("chat caches retain closure and selection independently; a distinct document opens", () => {
  const first = { ...reconcileMaterialView(emptyMaterialView(), collectMaterials([plan()], null)), open: false };
  const second = reconcileMaterialView(emptyMaterialView(), collectMaterials([{ ...plan(), id: "other" }], null));
  assert.equal(reconcileMaterialView(first, collectMaterials([plan()], null)), first);
  assert.equal(second.selected, "plan:other");
  assert.equal(reconcileMaterialView(first, collectMaterials([plan(), { ...plan(), id: "new" }], null)).selected, "plan:new");
});

test("partial, streaming, empty or nonplan documents cannot become an execution request", () => {
  for (const value of [plan("stream", "inProgress"), { ...plan(), truncated: true }, plan("  "), { ...plan(), type: "agentMessage" }]) assert.throws(() => executionText(value));
});

test("native goal owns idle gaps and blocked limits until pause, clear or completion", () => {
  for (const status of ["active", "blocked", "usageLimited", "budgetLimited"] as const) assert.equal(goalBlocksNewTask(snapshot(status)), true, status);
  for (const status of ["paused", "complete"] as const) assert.equal(goalBlocksNewTask(snapshot(status)), false, status);
  assert.equal(goalBlocksNewTask(null), false);
  assert.equal(goalBlocksNewTask({ ...snapshot("active"), goal: { state: "ready", value: null } }), false);
  assert.equal(goalBlocksNewTask({ ...snapshot("active"), goal: { ...snapshot("active").goal!, state: "stale" } }), true);
});

test("transient progress remains distinct from suggested plans and preserves stale status", () => {
  const value = { ...snapshot("active"), planProgress: { state: "stale" as const, turnId: "turn-1", explanation: "Продолжение", steps: [{ step: "Проверить", status: "inProgress" as const }], truncated: false } };
  const materials = collectMaterials([plan()], value);
  assert.deepEqual(materials.map(value => value.kind), ["plan", "progress", "goal"]);
  const progress = materials.find(value => value.kind === "progress")!;
  assert.equal(progress.kind === "progress" && progress.value.state, "stale");
});

test("an ordinary turn without native plan data cannot open an empty progress panel", () => {
  const value = { ...snapshot("complete"), goal: { state: "ready" as const, value: null }, planProgress: { state: "unavailable" as const, turnId: "ordinary-turn", explanation: null, steps: [], truncated: false } };
  assert.deepEqual(collectMaterials([], value), []);
  assert.equal(reconcileMaterialView(emptyMaterialView(), collectMaterials([], value)).open, false);
});
