// ABOUTME: Сравнивает попарные скорости двух loopback выдач одного файла.
// ABOUTME: Проверяет каждый ответ SHA-256 и не включает отчёты в Git.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.env.BRAI_ACCEPTANCE_GATE !== 'accepted') throw new Error('Acceptance gate is closed');
const runId = process.env.BRAI_ACCEPTANCE_RUN_ID ?? '';
assert.match(runId, /^[a-z0-9][a-z0-9-]{2,40}$/);
const sourceRevision = process.env.BRAI_ACCEPTANCE_SOURCE_REVISION ?? '';
assert.match(sourceRevision, /^[0-9a-f]{40}$/);
const pair = [
  ['plainCaddy', new URL(required('BRAI_ACCEPTANCE_BENCH_PLAIN_URL'))],
  ['uuidRoute', new URL(required('BRAI_ACCEPTANCE_BENCH_UUID_URL'))],
];
for (const [, url] of pair) {
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw new Error('Benchmark URLs must be explicit loopback HTTP endpoints without credentials/query');
}
const expectedBytes = Number(required('BRAI_ACCEPTANCE_BENCH_SIZE_BYTES'));
const expectedHash = required('BRAI_ACCEPTANCE_BENCH_SHA256');
assert.ok(Number.isSafeInteger(expectedBytes) && expectedBytes > 0);
assert.match(expectedHash, /^[0-9a-f]{64}$/);
const concurrency = Number(process.env.BRAI_ACCEPTANCE_BENCH_CONCURRENCY ?? 4);
const rounds = Number(process.env.BRAI_ACCEPTANCE_BENCH_ROUNDS ?? 7);
const warmups = Number(process.env.BRAI_ACCEPTANCE_BENCH_WARMUPS ?? 2);
assert.ok(Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= 32);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 5 && rounds <= 31);
assert.ok(Number.isSafeInteger(warmups) && warmups >= 1 && warmups <= 10);

async function transfer(url) {
  const started = performance.now();
  const response = await fetch(url, { redirect: 'error', cache: 'no-store' });
  assert.equal(response.status, 200, `unexpected status ${response.status} from ${url.origin}`);
  assert.equal(response.headers.get('content-length'), String(expectedBytes));
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.byteLength; hash.update(chunk); }
  const elapsedMs = performance.now() - started;
  assert.equal(bytes, expectedBytes);
  assert.equal(hash.digest('hex'), expectedHash, 'route returned different bytes');
  return { elapsedMs, bytes, mibPerSecond: bytes / 1048576 / (elapsedMs / 1000) };
}

async function batch(url) {
  const results = await Promise.all(Array.from({ length: concurrency }, () => transfer(url)));
  const durationMs = Math.max(...results.map(result => result.elapsedMs));
  const bytes = results.reduce((total, result) => total + result.bytes, 0);
  return { durationMs, bytes, mibPerSecond: bytes / 1048576 / (durationMs / 1000) };
}

for (let index = 0; index < warmups; index++) {
  await batch(pair[0][1]);
  await batch(pair[1][1]);
}
const samples = { plainCaddy: [], uuidRoute: [] };
for (let index = 0; index < rounds; index++) {
  const order = index % 2 ? [...pair].reverse() : pair;
  for (const [name, url] of order) samples[name].push(await batch(url));
}
const median = values => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const throughput = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, median(values.map(value => value.mibPerSecond))]));
const degradationPercent = Math.max(0, (1 - throughput.uuidRoute / throughput.plainCaddy) * 100);
const report = {
  runId, sourceRevision, completedAt: new Date().toISOString(), sizeBytes: expectedBytes,
  sha256: expectedHash, concurrency, warmups, pairedRounds: rounds,
  samples, medianMiBPerSecond: throughput, degradationPercent,
  passesTenPercentLimit: degradationPercent <= 10,
  memoryNote: 'This report measures transfer throughput only; sample controller/files Caddy RSS and Node heap separately from filesystem page cache using the manager protocol.',
};
const directory = resolve(process.env.BRAI_ACCEPTANCE_TMP ?? 'tmp/artifacts-acceptance', runId);
await mkdir(directory, { recursive: true, mode: 0o700 });
const reportFile = resolve(directory, 'throughput.json');
await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ report: reportFile, medianMiBPerSecond: throughput, degradationPercent, passesTenPercentLimit: report.passesTenPercentLimit }));

function required(name) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
  return process.env[name];
}
