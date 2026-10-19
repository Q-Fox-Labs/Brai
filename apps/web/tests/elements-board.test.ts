// ABOUTME: Проверяет проекции общих Ходов, локальный порядок и геометрию карты.
// ABOUTME: Использует только синтетические записи и не загружает fixture или историю.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitView, initialPositions, projectMoves, readLayout, sequenceMoves, sharedMoveLinkAnchors, statusPresentation, type Element, type Move } from "../app/elements/model.ts";

const element = (id: string, parentId: string | null): Element => ({ id, kind: parentId ? "task" : "goal", parentId, status: "active", revision: "r1", title: id, description: "", input: [], output: [] });
const move = (id: string, ownerId: string, targetId = ownerId, previousId: string | null = null, purpose = "work"): Move => ({ id, ownerId, targetId, previousId, kind: purpose === "work" ? "action" : "operation", purpose, title: id, status: "planned", attemptId: "attempt", executor: purpose === "work" ? "human" : "agent", input: [], output: [] });

test("shared start and accept are one move projected to both cards with local numbers", () => {
 const goal = "goal", task = "task";
 const first = move("first", goal);
 const start = move("start", goal, task, first.id, "start");
 const parentWork = move("parent-work", goal, goal, start.id);
 const taskWork = move("task-work", task, task, parentWork.id);
 const accept = move("accept", goal, task, taskWork.id, "accept");
 const afterAccept = move("after-accept", task, task, accept.id);
 const unrelated = move("unrelated", goal, task, afterAccept.id, "work");
 const source = [afterAccept, accept, taskWork, parentWork, start, unrelated, first, { ...start }];

 const goalRows = projectMoves(source, goal);
 const taskRows = projectMoves(source, task);
 assert.deepEqual(goalRows.map(row => [row.move.id, row.order]), [["first", 1], ["start", 2], ["parent-work", 3], ["accept", 4], ["unrelated", 5]]);
 assert.deepEqual(taskRows.map(row => [row.move.id, row.order]), [["start", 1], ["task-work", 2], ["accept", 3], ["after-accept", 4]]);
 assert.equal(goalRows.filter(row => row.move.id === "start").length, 1);
 assert.equal(taskRows.filter(row => row.move.id === "accept").length, 1);
 assert.equal(goalRows.find(row => row.move.id === "start")!.move, taskRows.find(row => row.move.id === "start")!.move);
 assert.ok(goalRows.find(row => row.move.id === "start")!.shared);
 assert.ok(taskRows.find(row => row.move.id === "start")!.shared);
 assert.equal(taskRows.some(row => row.move.id === "unrelated"), false);
});

test("same-owner and non-start/accept moves are never projected twice", () => {
 const sameOwner = move("same-owner", "goal", "goal", null, "start");
 const otherPurpose = move("other-purpose", "goal", "task", sameOwner.id, "finish");
 const rows = projectMoves([sameOwner, otherPurpose], "goal");
 assert.deepEqual(rows.map(row => row.move.id), ["same-owner", "other-purpose"]);
 assert.equal(rows.some(row => row.shared), false);
 assert.equal(projectMoves([sameOwner, otherPurpose], "task").length, 0);
});

test("predecessor order includes intervening moves omitted from the current projection", () => {
 const first = move("first", "goal");
 const start = move("start", "goal", "task", first.id, "start");
 const child = move("child", "task", "task", start.id);
 const accept = move("accept", "goal", "task", child.id, "accept");
 const later = move("later", "goal", "goal", accept.id);
 const shuffled = [later, accept, child, start, first];
 assert.deepEqual(projectMoves(shuffled, "goal").map(row => [row.move.id, row.order]), [["first", 1], ["start", 2], ["accept", 3], ["later", 4]]);
 assert.deepEqual(projectMoves(shuffled, "task").map(row => [row.move.id, row.order]), [["start", 1], ["child", 2], ["accept", 3]]);
 assert.deepEqual(sequenceMoves(shuffled).map(row => row.id), ["first", "start", "child", "accept", "later"]);
});

test("shared move arrows use one outer gutter and keep start/accept direction", () => {
 const parent = { x: 260, y: 100, width: 420 }, childLeft = { x: 0, y: 420, width: 420 }, childRight = { x: 720, y: 420, width: 420 };
 const leftStart = sharedMoveLinkAnchors(parent, childLeft, "start");
 assert.deepEqual(leftStart, { start: { x: 260, y: 100 }, end: { x: 0, y: 420 }, gutterX: -60, side: "left" });
 assert.deepEqual(sharedMoveLinkAnchors(parent, childLeft, "accept"), { start: { x: 0, y: 420 }, end: { x: 260, y: 100 }, gutterX: -60, side: "left" });
 const rightStart = sharedMoveLinkAnchors(parent, childRight, "start");
 assert.deepEqual(rightStart, { start: { x: 680, y: 100 }, end: { x: 1140, y: 420 }, gutterX: 1200, side: "right" });
 assert.deepEqual(sharedMoveLinkAnchors(parent, childRight, "accept"), { start: { x: 1140, y: 420 }, end: { x: 680, y: 100 }, gutterX: 1200, side: "right" });
});

test("initial layout groups each parent with its children and saved manual positions win", () => {
 const elements = [element("goal", null), element("task-a", "goal"), element("task-b", "goal"), element("other-goal", null)];
 const defaults = initialPositions(elements, { goal: 900 });
 assert.ok(defaults.goal.x > defaults["task-a"].x && defaults.goal.x < defaults["task-b"].x);
 assert.equal(defaults["task-a"].y, 1044);
 assert.equal(defaults["task-b"].y, 1044);
 const saved = { version: 2, positions: { ...defaults, goal: { x: -300, y: 72 } }, view: { x: 4, y: 8, zoom: 0.8 } };
 assert.deepEqual(readLayout(JSON.stringify(saved), defaults)!.positions.goal, saved.positions.goal);
 assert.deepEqual(fitView({}, 800, 600), { x: 0, y: 0, zoom: 1 });
});

test("move statuses remain visible independently of executor and move kind", () => {
 for (const [kind, statuses] of [["element", ["draft", "active", "completed"]], ["move", ["planned", "claimed", "succeeded"]]] as const) {
  const states = statuses.map(status => statusPresentation(status, kind));
  assert.equal(new Set(states.map(state => state.tone)).size, 3);
  assert.ok(states.every(state => state.label));
 }
 assert.deepEqual(statusPresentation("completed", "move"), statusPresentation("succeeded", "move"));
 assert.notEqual(statusPresentation("unexpected", "move").tone, "completed");
});
