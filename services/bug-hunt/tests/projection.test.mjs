// ABOUTME: Проверяет точность проекций и ограничения обработки наблюдений.
 // ABOUTME: Использует синтетические данные без внешних сервисов.
import test from "node:test";
import assert from "node:assert/strict";
import { searchProjection, exactSignature, modelProjection, chunkText, validateEmbedding } from "../dist/projection.js";

const observation = { title: "Ошибка", component_id: "web", component_version: "1", operation: "открыть", expected: "не найдено", observed: "код 404", steps: "шаг", diagnostic_text: "диагностика" };
test("точная сигнатура учитывает версии, доказательства, отрицание и область", () => {
 const sign = (o, installation = "i", owner = "u") => exactSignature(installation, owner, o);
 const base = sign(observation);
 for (const changed of [
  { ...observation, component_version: "2" },
  { ...observation, commit_sha: "abc" },
  { ...observation, evidence_artifact_ids: ["artifact"] },
  { ...observation, expected: "найдено" },
  { ...observation, steps: null },
 ]) assert.notEqual(sign(changed).canonical, base.canonical);
 assert.notEqual(sign(observation, "other").hash, base.hash);
 assert.notEqual(sign(observation, "i", "other").hash, base.hash);
 assert.equal(sign({ ...observation, evidence_artifact_ids: [] }).hash, base.hash);
 assert.equal(sign({ ...observation, component_id: "unknown" }), null);
 assert.equal(sign({ ...observation, component_version: null }), null);
 assert.equal(sign({ ...observation, observed: "a\r\nb" }).hash, sign({ ...observation, observed: "a\nb" }).hash);
});
test("поиск сохраняет данные, а модель не получает диагностику и явные секреты", () => {
 assert.match(searchProjection(observation), /код 404/);
 assert.match(searchProjection(observation), /не найдено/);
 const projection = modelProjection({ ...observation, diagnostic_text: "token=secret", steps: "https://example.com" });
 assert.equal(projection.blocked, false);
 assert.ok(!projection.text.includes("secret"));
 assert.ok(projection.excluded_fields.includes("diagnostic_text"));
 for (const value of ["https://example.com/private", "password=secret", "Bearer abc"]) {
  const blocked = modelProjection({ ...observation, observed: value });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.text, "");
 }
});
test("части сохраняют Unicode и сообщают о неполном покрытии", () => {
 const input = "ошибка😀".repeat(3000);
 const result = chunkText(input);
 assert.equal(result.coverage, "complete");
 assert.equal(result.chunks.map(c => c.text).join(""), input);
 for (const [index, chunk] of result.chunks.entries()) {
  assert.equal(chunk.index, index);
  assert.equal(input.slice(chunk.start, chunk.end), chunk.text);
  assert.ok(Buffer.byteLength(chunk.text) <= 1200);
  assert.ok(!/[\\uD800-\\uDBFF]$/.test(chunk.text));
 }
 const long = chunkText("😀".repeat(30000));
 assert.equal(long.coverage, "partial");
 assert.ok(long.covered_chars < long.total_chars);
 assert.ok(long.chunks.length <= 64);
 assert.equal(long.chunks.map(c => c.text).join(""), "😀".repeat(30000).slice(0, long.covered_chars));
});
test("принимается только конечный нормированный embedding нужного размера", () => {
 const valid = Array(768).fill(0); valid[0] = 1;
 assert.doesNotThrow(() => validateEmbedding(valid));
 for (const invalid of [[], Array(768).fill(0), Array(768).fill(1), [...valid.slice(0, 767), NaN], null]) {
  assert.throws(() => validateEmbedding(invalid), /^Error: INVALID_EMBEDDING$/);
 }
});

test('explicitly unknown version is not sufficient context for automatic grouping',()=>{
 const input={title:'Сбой',component_id:'web',component_version:'unknown',operation:'open',expected:'ok',observed:'failed'};
 assert.equal(exactSignature('installation','owner',input),null);
 assert.equal(exactSignature('installation','owner',{...input,component_version:' UNKNOWN '}),null);
 assert.notEqual(exactSignature('installation','owner',{...input,component_version:'1'}),null);
});
