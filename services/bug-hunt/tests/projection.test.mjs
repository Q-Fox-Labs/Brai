// ABOUTME: Проверяет точность проекций и ограничения обработки наблюдений.
 // ABOUTME: Использует синтетические данные без внешних сервисов.
import test from "node:test";
import assert from "node:assert/strict";
import { prepareExternalProjection, searchProjection, exactSignature, modelProjection, chunkText, validateEmbedding } from "../dist/projection.js";

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

test('automatic technical projection preserves symptoms and omits sensitive or unsupported fields',()=>{
 const original={...observation,steps:'1. Открыть\n2. Читать',diagnostic_text:'token=private',conversation_ref:'private conversation',run_id:'private-run'};
 const before=structuredClone(original),result=prepareExternalProjection(original);
 assert.match(result.text,/не найдено/);assert.match(result.text,/код 404/);assert.match(result.text,/2\. Читать/);
 assert.ok(!result.text.includes('private'));
 assert.deepEqual(result.excluded_fields,['conversation_ref','diagnostic_text','run_id']);
 assert.deepEqual(original,before);
 for(const secret of ['OPENAI_API_KEY=private','AWS_SECRET_ACCESS_KEY=private','PGPASSWORD=private','"openai_api_key": "private"','user_id=synthetic-other-owner','token=private','"token":"private"','"access_token": "private"','refresh-token=private','токен = секрет','пароль: секрет','PASSWORD: private','Authorization: Bearer private','Cookie: sid=private','-----BEGIN RSA PRIVATE KEY-----','https://example.test/private','postgres://user:pass@host/db','name@example.test','@private_user','Участник (@private_user) видит сбой','handle=@private_user','+7 (999) 123-45-67','192.168.1.10','12345678-1234-1234-1234-123456789abc','sk-123456789012345678901234']){
  const projected=prepareExternalProjection({...original,observed:secret});
  assert.ok(projected.excluded_fields.includes('observed'),secret);
  assert.ok(!projected.text.includes(secret),secret);
  assert.match(projected.text,/не найдено/);
  assert.equal(modelProjection({...observation,observed:secret}).blocked,true,secret);
 }
});
test('automatic projection normalizes Unicode without changing original and returns null for empty safe text',()=>{
 const input={title:'тест😀\r\nещё',operation:'',expected:'',observed:''};
 assert.match(prepareExternalProjection(input).text,/тест😀\nещё/);
 assert.equal(input.title,'тест😀\r\nещё');
 assert.equal(prepareExternalProjection({title:'token=private',operation:'',expected:'',observed:'',component_id:'web',component_version:'1'}),null);
});
