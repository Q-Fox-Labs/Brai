// ABOUTME: Проверяет сохранность истории и восстановление геометрии карты.
// ABOUTME: Тесты не вызывают сервисы и не исполняют исторические действия.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fitView, initialPositions, readLayout, sequenceMoves, type BoardData } from "../app/elements/model.ts";
const data = JSON.parse(readFileSync(new URL("../app/elements/demo.json", import.meta.url), "utf8")) as BoardData;

test("demo keeps unique identities, cross-owner predecessors and cumulative resource provenance", () => {
 assert.equal(data.elements.length, 4); assert.equal(data.moves.length, 23); assert.equal(data.resources.length, 26);
 assert.equal(new Set(data.moves.map(m => m.id)).size, data.moves.length);
 const available = new Set(["R00"]);
 for (const [index, move] of data.moves.entries()) {
  assert.equal(move.previousId, data.moves[index - 1]?.id ?? null);
  assert.deepEqual(new Set(move.input), available);
  for (const id of move.output) {
   assert.equal(data.resources.find(r => r.id === id)?.attemptId, move.attemptId);
   available.add(id);
  }
 }
 const accept = data.moves.find(m => m.id === "G1-M6")!;
 assert.equal(accept.ownerId, "G1"); assert.equal(accept.targetId, "T2"); assert.equal(accept.previousId, "T2-F2");
 assert.equal(data.moves.filter(m => m.ownerId === "G1").length, 10);
 assert.equal(data.moves.filter(m => m.ownerId === "T2").length, 5);
 assert.ok(data.moves.find(m => m.id === "G1-M10")!.output.includes("R25"));
});

test("layout accepts new identities and a parentless element, ignores stale IDs and rejects damaged storage", () => {
 const extra = { ...data.elements[0], id: "new-root", parentId: null, title: "Длинное название ".repeat(20) };
 const defaults = initialPositions([...data.elements, extra]);
 assert.ok(defaults[extra.id]);
 const raw = JSON.stringify({ version: 1, positions: { G1: { x: -200, y: 100 }, obsolete: { x: 20, y: 20 } }, view: { x: -50, y: 90, zoom: 0.75 } });
 const restored = readLayout(raw, defaults)!;
 assert.deepEqual(restored.positions.G1, { x: -200, y: 100 });
 assert.deepEqual(restored.positions[extra.id], defaults[extra.id]);
 assert.ok(!restored.positions.obsolete);
 assert.equal(readLayout("broken", defaults), null);
 assert.equal(readLayout(JSON.stringify({ version: 1, view: { x: 0, y: 0, zoom: 99 } }), defaults), null);
 assert.deepEqual(fitView({}, 800, 600), { x: 0, y: 0, zoom: 1 });
 const fitted = fitView({ a: { x: -100, y: 20 }, b: { x: 600, y: 700 } }, 1200, 900);
 assert.ok(fitted.zoom >= 0.2 && fitted.zoom <= 1);
 assert.ok(fitted.x + -100 * fitted.zoom >= 0);
 assert.ok(fitted.y + 20 * fitted.zoom >= 0);
});

test("move numbers are local to each owner and follow predecessor links rather than storage order", () => {
 const shuffled = [...data.moves].reverse();
 const sequenced = sequenceMoves(shuffled);
 assert.deepEqual(sequenced.map(move => move.id), data.moves.map(move => move.id));
 for (const [owner, count] of Object.entries({ G1: 10, T1: 3, T2: 5, T3: 5 })) {
  assert.deepEqual(sequenced.filter(move => move.ownerId === owner).map(move => move.order), Array.from({ length: count }, (_, index) => index + 1));
 }
 assert.equal(sequenced.find(move => move.id === "G1-M6")!.order, 6);
 assert.equal(sequenced.find(move => move.id === "G1-M6")!.previousId, "T2-F2");
 assert.equal(sequenced.find(move => move.id === "T2-F2")!.order, 5);
 assert.ok(data.moves.every(move => !("order" in move)));
 const branches = sequenceMoves([{ ...data.moves[0], id: "root", previousId: null }, { ...data.moves[0], id: "left", previousId: "root" }, { ...data.moves[0], id: "right", previousId: "root" }]);
 assert.deepEqual(branches.map(move => move.order), [1, 2, 2]);
});
