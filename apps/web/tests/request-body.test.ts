// ABOUTME: Проверяет размер, отмену и очистку малых HTTP JSON потоков.
// ABOUTME: Ни один запрос с зависшим телом не доходит до обработки JSON.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readBoundedJson } from "../server/request-body.ts";

test("reads bounded UTF-8 JSON and cancels an oversized body", async () => {
  const request = new Request("https://app.test/api", { method: "POST", body: JSON.stringify({ ok: true }) });
  assert.deepEqual(await readBoundedJson(request, 1024, 1000), { ok: true });
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { canceled = true; } });
  const oversized = new Request("https://app.test/api", { method: "POST", body: stream, headers: { "content-length": "20" }, duplex: "half" } as RequestInit);
  await assert.rejects(readBoundedJson(oversized, 16, 1000), /REQUEST_TOO_LARGE/);
  assert.equal(canceled, true);
});

test("request abort cancels a stalled body, rejects and releases the reader", async () => {
  const controller = new AbortController(); let canceled = false;
  const stream = new ReadableStream<Uint8Array>({ start(streamController) { streamController.enqueue(new Uint8Array([123])); }, cancel() { canceled = true; } });
  const request = new Request("https://app.test/api", { method: "POST", body: stream, signal: controller.signal, duplex: "half" } as RequestInit);
  const reading = readBoundedJson(request, 1024, 10000);
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
  await assert.rejects(reading, /REQUEST_TIMEOUT/);
  assert.equal(canceled, true);
});
