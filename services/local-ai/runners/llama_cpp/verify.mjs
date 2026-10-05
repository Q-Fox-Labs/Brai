// ABOUTME: Проверяет HTTP-runtime llama.cpp для закреплённого профиля эмбеддингов.
// ABOUTME: Не запускает и не останавливает процесс, не сохраняет запросы и векторы.

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const baseUrl = new URL(process.argv[2] ?? "http://127.0.0.1:19339");
const referenceUrl = process.env.BRAI_EMBEDDINGS_REFERENCE_URL
  ? new URL(process.env.BRAI_EMBEDDINGS_REFERENCE_URL)
  : undefined;
const timeoutMs = 30_000;
const request = async (path, init) => {
  const startedAt = performance.now();
  const response = await fetch(new URL(path, baseUrl), {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { response, elapsedMs: performance.now() - startedAt };
};

const health = await request("/health");
assert.equal(health.response.status, 200, "llama.cpp runtime must report ready");

const input = [
  "Векторный поиск сопоставляет запрос с подходящими документами.",
  "Vector search matches a query with relevant documents.",
];
const validateBatch = (body, label) => {
  assert.ok(Array.isArray(body.data), `${label} result must contain data`);
  assert.equal(body.data.length, input.length, `${label} must return one vector per input`);
  for (let index = 0; index < input.length; index++) {
    const row = body.data[index];
    assert.equal(row.index, index, `${label} results must retain input order`);
    assert.ok(Array.isArray(row.embedding), `${label} vector ${index} must be an array`);
    assert.equal(row.embedding.length, 1024, `${label} vector ${index} must have 1024 dimensions`);
    assert.ok(row.embedding.every(Number.isFinite), `${label} vector ${index} must be finite`);
    const norm = Math.sqrt(row.embedding.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(norm - 1) <= 0.001, `${label} vector ${index} must have unit L2 norm`);
  }
  return body.data.map(row => row.embedding);
};
const embed = async () => request("/v1/embeddings", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "giga-embeddings-480m-q8", input }),
});

const first = await embed();
assert.equal(first.response.status, 200, "RU/EN batch must be accepted");
const firstBody = await first.response.json();
const firstVectors = validateBatch(firstBody, "candidate first batch");
assert.notDeepEqual(firstVectors[0], firstVectors[1],
  "different RU/EN inputs must not be returned as the same vector");

let compatibility;
if (referenceUrl) {
  const response = await fetch(new URL("/v1/embeddings", referenceUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "giga-embeddings-480m-q8", input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  assert.equal(response.status, 200, "reference runtime must accept the same RU/EN batch");
  const referenceBody = await response.json();
  const referenceVectors = validateBatch(referenceBody, "reference batch");
  let maxAbsoluteDelta = 0;
  let minimumCosineSimilarity = 1;
  for (let index = 0; index < firstVectors.length; index++) {
    const actual = firstVectors[index];
    const reference = referenceVectors[index];
    assert.equal(actual.length, reference.length, "reference dimensions must match");
    let dot = 0;
    let actualNormSquared = 0;
    let referenceNormSquared = 0;
    for (let dimension = 0; dimension < actual.length; dimension++) {
      maxAbsoluteDelta = Math.max(maxAbsoluteDelta, Math.abs(actual[dimension] - reference[dimension]));
      dot += actual[dimension] * reference[dimension];
      actualNormSquared += actual[dimension] ** 2;
      referenceNormSquared += reference[dimension] ** 2;
    }
    minimumCosineSimilarity = Math.min(minimumCosineSimilarity,
      dot / Math.sqrt(actualNormSquared * referenceNormSquared));
  }
  assert.ok(Number.isFinite(maxAbsoluteDelta), "reference vector deltas must be finite");
  assert.ok(Number.isFinite(minimumCosineSimilarity), "reference cosine similarity must be finite");
  // Both endpoints must use this pinned image, GGUF and launch profile on the same CPU host.
  // The tolerance permits small floating-point variation while rejecting profile drift.
  assert.ok(maxAbsoluteDelta < 1e-5, "candidate vectors must closely match the pinned reference");
  assert.ok(minimumCosineSimilarity > 0.99999,
    "candidate vectors must preserve direction against the pinned reference");
  compatibility = {
    referenceUrl: referenceUrl.origin,
    maxAbsoluteDelta: Number(maxAbsoluteDelta.toPrecision(6)),
    minimumCosineSimilarity: Number(minimumCosineSimilarity.toPrecision(8)),
  };
}

const warm = await embed();
assert.equal(warm.response.status, 200, "warm batch must be accepted");
const warmBody = await warm.response.json();
validateBatch(warmBody, "candidate warm batch");

const oversized = await request("/v1/embeddings", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "giga-embeddings-480m-q8",
    input: ["hello ".repeat(4096)],
  }),
});
assert.equal(oversized.response.status, 500, "over-context input must be rejected by the pinned server");
const oversizedBody = await oversized.response.text();
assert.match(oversizedBody, /too large to process/i,
  "over-context response must explain that the text needs splitting");

console.log(JSON.stringify({
  ok: true,
  healthMs: Number(health.elapsedMs.toFixed(1)),
  firstBatchMs: Number(first.elapsedMs.toFixed(1)),
  warmBatchMs: Number(warm.elapsedMs.toFixed(1)),
  dimensions: 1024,
  l2Norm: "within 0.001 of 1",
  order: [0, 1],
  overContextStatus: oversized.response.status,
  ...(compatibility ? { compatibility } : {}),
}));
