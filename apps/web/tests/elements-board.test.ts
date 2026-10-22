// ABOUTME: Проверяет проекции общих Ходов, локальный порядок и геометрию карты.
// ABOUTME: Использует только синтетические записи и не загружает fixture или историю.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitView, initialPositions, projectMoves, readLayout, resourceMoveLinkAnchors, resourceMoveLinks, sequenceMoves, sharedMoveLinkAnchors, siblingResourceLinks, statusPresentation, wrapResourceLabel, type BoardData, type Element, type Move, type Resource } from "../app/elements/model.ts";
import { presentBoard } from "../app/elements/presentation.ts";

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
 assert.deepEqual(taskRows.map(row => [row.move.id, row.order]), [["start", 1], ["task-work", 2], ["after-accept", 3], ["accept", 4]]);
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

test("shared identity curves face across the gap and switch ports when cards cross", () => {
 const parent = { x: 500, y: 100, width: 400 };
 const left = sharedMoveLinkAnchors(parent, { x: 0, y: 500, width: 400 });
 assert.deepEqual(left, { start: { x: 500, y: 100 }, end: { x: 400, y: 500 }, controlStart: { x: 450, y: 100 }, controlEnd: { x: 450, y: 500 }, side: "gap" });
 const right = sharedMoveLinkAnchors(parent, { x: 1000, y: 500, width: 400 });
 assert.deepEqual(right, { start: { x: 900, y: 100 }, end: { x: 1000, y: 500 }, controlStart: { x: 950, y: 100 }, controlEnd: { x: 950, y: 500 }, side: "gap" });
 for(const route of [left,right]) for(let i=0;i<=100;i++) {
  const t=i/100,u=1-t,x=u**3*route.start.x+3*u*u*t*route.controlStart.x+3*u*t*t*route.controlEnd.x+t**3*route.end.x;
  assert.ok(x>=Math.min(route.start.x,route.end.x)&&x<=Math.max(route.start.x,route.end.x));
 }
});

test("vertically aligned and partially overlapping X ranges use an outside corridor", () => {
 const parent={x:500,y:100,width:400};
 for(const child of [{x:500,y:600,width:400},{x:650,y:600,width:400},{x:350,y:600,width:400}]) {
  const route=sharedMoveLinkAnchors(parent,child);
  if(route.side==='right') {assert.equal(route.start.x,900);assert.equal(route.end.x,child.x+child.width);assert.ok(route.controlStart.x>Math.max(900,child.x+child.width));}
  else {assert.equal(route.side,'left');assert.equal(route.start.x,500);assert.equal(route.end.x,child.x);assert.ok(route.controlStart.x<Math.min(500,child.x));}
  assert.equal(route.controlStart.x,route.controlEnd.x);
 }
});

test("resource links use real inputs, target transfer for start, and explicit planned requirements", () => {
 const producer = { ...move("accept-child-1", "root", "child-1", null, "accept"), attemptId: "producer-attempt", output: [] };
 const start = { ...move("start-child-2", "root", "child-2", null, "start"), attemptId: "start-attempt", input: ["parent-approval", "shared", "shared"] };
 const approvalProducer = { ...move("parent-approval", "root", "root"), attemptId: "approval-attempt", output: ["parent-approval"] };
 const actualProducer = { ...move("actual-producer", "child-1"), attemptId: "actual-attempt", output: ["actual"] };
 const actualConsumer = { ...move("actual-consumer", "child-2"), input: ["actual", "absent"] };
 const sameTargetProducer = { ...move("same-target-producer", "child-2"), output: ["same-target"] };
 const sameTargetConsumer = { ...move("same-target-consumer", "child-2"), input: ["same-target"] };
 const plannedProducer = { ...move("planned-producer", "child-1"), output: ["planned"] };
 const plannedConsumer = { ...move("planned-consumer", "child-2"), status: "planned", attemptId: "", input: [], requiredResourceIds: ["planned", "planned", "absent"] };
 const plannedStart = { ...move("planned-start", "root", "child-3", null, "start"), status: "planned", attemptId: "", requiredResourceIds: ["planned"] };
 const resources: Resource[] = [
  { id: "shared", title: "Подтверждённый ресурс", content: "", attemptId: "producer-attempt" },
  { id: "parent-approval", title: "Подтверждение родителя", content: "", attemptId: "approval-attempt" },
  { id: "actual", title: "Результат", content: "", attemptId: "actual-attempt" },
  { id: "same-target", title: "Локальный ресурс", content: "", attemptId: null },
  { id: "planned", title: "Ожидаемый ресурс", content: "", attemptId: null },
 ];
 const attempts = [{ id: "start-attempt", status: "succeeded", result: { claim: { target_input_resource_ids: ["shared"] } } }];
 const links = resourceMoveLinks([producer, start, approvalProducer, actualProducer, actualConsumer, sameTargetProducer, sameTargetConsumer, plannedProducer, plannedConsumer, plannedStart], resources, attempts);
 assert.deepEqual(links.map(link => [link.resourceId, link.producerId, link.consumerId, link.fromElementId, link.toElementId, link.expected]), [
  ["shared", "accept-child-1", "start-child-2", "child-1", "child-2", false],
  ["actual", "actual-producer", "actual-consumer", "child-1", "child-2", false],
  ["planned", "planned-producer", "planned-consumer", "child-1", "child-2", true],
 ]);
 assert.equal(links[0].resourceTitle, "Подтверждённый ресурс");
});

test("resource labels wrap within the available width and ellipsize after three lines", () => {
 assert.deepEqual(wrapResourceLabel("Выбранный маршрут", 76), ["Выбранный", "маршрут"]);
 assert.deepEqual(wrapResourceLabel("Слишком длинное название ресурса для подписи", 70), ["Слишком", "длинное", "название…"]);
});

test("resource links retain planned required IDs through readable conditions", () => {
 const raw: BoardData = { elements: [], moves: [{ ...move("planned", "task"), status: "planned", attemptId: "", conditions: { prerequisite: "Есть ресурс", required_resources: ["resource-id", "resource-id"] } }], resources: [] };
 const presented = presentBoard(raw);
 assert.deepEqual(presented.moves[0].requiredResourceIds, ["resource-id"]);
 assert.equal(presented.moves[0].conditions, "Есть ресурс");
 const withOutputs = presentBoard({ ...raw, moves: [{ ...raw.moves[0], conditions: { required_outputs: [{ move_id: "move-id", output_key: "output-key", revision_id: "revision-id" }] } }] });
 assert.deepEqual(withOutputs.moves[0].requiredOutputContracts, [{ moveId: "move-id", outputKey: "output-key", revisionId: "revision-id" }]);
});

test("resource arrows use facing sides or an outside gutter for overlapping rows", () => {
 const left = { x: 0, y: 20, width: 420 }, right = { x: 600, y: 300, width: 420 };
 assert.deepEqual(resourceMoveLinkAnchors(left, right), { start: { x: 420, y: 20 }, end: { x: 600, y: 300 }, controlX: 510, side: "gap" });
 assert.deepEqual(resourceMoveLinkAnchors(right, left), { start: { x: 600, y: 300 }, end: { x: 420, y: 20 }, controlX: 510, side: "gap" });
 assert.deepEqual(resourceMoveLinkAnchors(left, { x: 120, y: 220, width: 420 }), { start: { x: 0, y: 20 }, end: { x: 120, y: 220 }, controlX: -60, side: "left" });
});

test("initial layout groups each parent with its children and saved manual positions win", () => {
 const elements = [element("goal", null), element("task-a", "goal"), element("task-b", "goal"), element("other-goal", null)];
 const defaults = initialPositions(elements, { goal: 900 });
 assert.ok(defaults.goal.x > defaults["task-a"].x && defaults.goal.x < defaults["task-b"].x);
 assert.equal(defaults["task-a"].y, 1044);
 assert.equal(defaults["task-b"].y, 1044);
 const nested = initialPositions([element("quest", null), { ...element("goal-child", "quest"), kind: "goal" }, { ...element("task-grandchild", "goal-child"), kind: "task" }], { quest: 500, "goal-child": 700 });
 assert.equal(nested["goal-child"].y, 644);
 assert.equal(nested["task-grandchild"].y, 1488);
 assert.equal(nested.quest.x, nested["goal-child"].x);
 assert.equal(nested["goal-child"].x, nested["task-grandchild"].x);
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

test("new groups stay clear of saved manual positions when graph ordering changes", () => {
 const defaults = initialPositions([element("new-root", null), element("new-child", "new-root"), element("saved-root", null)]);
 const layout = readLayout(JSON.stringify({version:2,positions:{"saved-root":{x:20,y:0}},view:{x:0,y:0,zoom:1}}),defaults);
 assert.deepEqual(layout?.positions["saved-root"],{x:20,y:0});
 assert.ok(layout.positions["new-root"].x >= 540);
 assert.ok(layout.positions["new-child"].x >= 540);
 assert.equal(layout.positions["new-root"].x-layout.positions["new-child"].x,defaults["new-root"].x-defaults["new-child"].x);
});

// Родительские постановка/приёмка и внутренняя работа имеют независимые цепи.
test("child projection brackets the complete independent rework chain", () => {
 const parent = move("parent", "goal");
 const start = move("start", "goal", "task", parent.id, "start");
 const accept = move("accept", "goal", "task", start.id, "accept");
 const own = [move("confirm", "task"), move("work", "task", "task", "confirm"), move("review", "task", "task", "work"), move("rework", "task", "task", "review"), move("final", "task", "task", "rework")];
 const rows = projectMoves([accept, ...own.toReversed(), start, parent], "task");
 assert.deepEqual(rows.map(row => row.move.id), ["start", "confirm", "work", "review", "rework", "final", "accept"]);
 assert.deepEqual(rows.map(row => row.order), [1, 2, 3, 4, 5, 6, 7]);
});


test("sibling transfers show only proven accepted outputs into sibling start projections", () => {
 const goal=element("root",null), tasks=[element("one",goal.id),element("two",goal.id),element("three",goal.id)];
 tasks[0].output=["first"];tasks[1].input=["first"];tasks[1].output=["second"];tasks[2].input=["second"];
 const accept1={...move("accept-one",goal.id,tasks[0].id,null,"accept"),attemptId:"a1",output:["first"]};
 const accept2={...move("accept-two",goal.id,tasks[1].id,null,"accept"),attemptId:"a2",output:["second"]};
 const start2={...move("start-two",goal.id,tasks[1].id,null,"start"),attemptId:"s2",input:["first"]};
 const start3={...move("start-three",goal.id,tasks[2].id,null,"start"),attemptId:"s3",input:["second"]};
 const work={...move("internal",tasks[1].id),input:["first"]}, final={...move("final",goal.id),input:["first","second"]};
 const data:BoardData={elements:[goal,...tasks],moves:[accept1,accept2,start2,start3,work,final],resources:[{id:"first",title:"Принятый итог",content:"",attemptId:"a1"},{id:"second",title:"Следующий итог",content:"",attemptId:"a2"}],attempts:[{id:"a1",moveId:accept1.id,status:"succeeded"},{id:"a2",moveId:accept2.id,status:"succeeded"},{id:"s2",moveId:start2.id,status:"succeeded",result:{claim:{target_input_resource_ids:["first"]}}},{id:"s3",moveId:start3.id,status:"succeeded",result:{claim:{target_input_resource_ids:["second"]}}}]};
 const before=JSON.stringify(data);
 assert.deepEqual(siblingResourceLinks(data).map(l=>[l.resourceId,l.producerId,l.consumerId,l.fromElementId,l.toElementId]),[["first","accept-one","start-two","one","two"],["second","accept-two","start-three","two","three"]]);
 assert.equal(JSON.stringify(data),before);
 assert.equal(siblingResourceLinks({...data,attempts:[]}).length,0);
 assert.equal(siblingResourceLinks({...data,elements:[goal,...tasks.map(task=>({...task,input:[]}))]}).length,0);
 assert.equal(siblingResourceLinks({...data,elements:[goal,...tasks.map(task=>({...task,output:[]}))]}).length,0);
 assert.equal(siblingResourceLinks({...data,resources:data.resources.map(r=>({...r,attemptId:"unrelated"}))}).length,0);
 assert.equal(siblingResourceLinks({...data,attempts:data.attempts!.map(a=>a.id.startsWith("s")?{...a,result:{claim:{target_input_resource_ids:[]}}}:a)}).length,0);
 const goalSibling = { ...tasks[1], kind: "goal" };
 assert.equal(siblingResourceLinks({ ...data, elements: [goal, tasks[0], goalSibling, tasks[2]] }).length, 2);
 const questSibling = { ...tasks[1], kind: "quest" };
 assert.equal(siblingResourceLinks({ ...data, elements: [goal, tasks[0], questSibling, tasks[2]] }).length, 2);
 const required = { ...start2, requiredOutputContracts: [{ moveId: "accept-one", outputKey: "output-key", revisionId: "plan-revision" }] };
 const restrictedStart3 = { ...start3, requiredOutputContracts: [{ moveId: "other-move", outputKey: "other-key", revisionId: "other-revision" }] };
 const exactResource = { ...data.resources[0], metadata: { output_key: "output-key", plan_revision_id: "plan-revision" } };
 assert.equal(siblingResourceLinks({ ...data, moves: [accept1, accept2, required, restrictedStart3, work, final], resources: [exactResource, data.resources[1]] }).length, 1);
 assert.equal(siblingResourceLinks({ ...data, moves: [accept1, accept2, { ...required, requiredOutputContracts: [{ moveId: "other-move", outputKey: "output-key", revisionId: "plan-revision" }] }, restrictedStart3, work, final], resources: [exactResource, data.resources[1]] }).length, 0);
});
