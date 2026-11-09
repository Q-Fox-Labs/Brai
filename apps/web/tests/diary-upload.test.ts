// ABOUTME: Проверяет клиентскую дозагрузку при неизвестном результате и повторном выборе файла.
// ABOUTME: Передаются реальные Blob и SHA-256; транспорт подменён без рабочих данных.
import test from "node:test";
import assert from "node:assert/strict";
import {resumeUpload, nextChain, uploadBytes} from "../app/diary/upload.ts";
const MB = 1048576, zero = "0".repeat(64);
test("resume after lost acknowledgement never resends accepted bytes", async () => {
  const file = new File([new Uint8Array(2 * MB + 3)], "test.wav");
  let state = {offset: 0, totalBytes: null as number | null, chain: zero, chunkBytes: MB, ready: false}, waits = 0;
  const sent: number[] = [];
  await resumeUpload(file, {signal: new AbortController().signal, read: async () => ({...state}), progress() {}, waiting() {waits++;},
    async send(part, offset, chain) {
      sent.push(offset); assert.equal(offset, state.offset);
      state = {...state, totalBytes: file.size, offset: offset + part.size, chain: await nextChain(chain, part), ready: offset + part.size === file.size};
      if (offset === 0) throw new Error("response lost");
    }});
  assert.deepEqual(sent, [0, MB, 2 * MB]); assert.equal(waits, 1); assert.equal(state.ready, true);
});
test("reselecting resumes saved prefix and rejects different content with same name and size", async () => {
  const file = new File([new Uint8Array(MB), new Uint8Array(4)], "test.wav");
  const state = {offset: MB, totalBytes: file.size, chain: await nextChain(zero, file.slice(0, MB)), chunkBytes: MB, ready: false};
  const sent: number[] = [];
  const ports = {signal: new AbortController().signal, read: async () => ({...state}), progress() {}, waiting() {},
    async send(part: Blob, offset: number) {sent.push(offset); state.chain = await nextChain(state.chain, part); state.offset += part.size; state.ready = true;}};
  const changed = new File([new Uint8Array(MB).fill(1), new Uint8Array(4)], "test.wav");
  await assert.rejects(resumeUpload(changed, ports), /отличается/); assert.deepEqual(sent, []);
  await resumeUpload(file, ports); assert.deepEqual(sent, [MB]);
});
test("cancel during network backoff stops requests; permission errors are not retried", async () => {
  const controller = new AbortController(), file = new File(["audio"], "test.wav");
  let calls = 0;
  await assert.rejects(resumeUpload(file, {signal: controller.signal, read: async () => {calls++; throw Error("offline");}, send: async () => {}, progress() {}, waiting() {controller.abort();}}), {name: "AbortError"});
  assert.equal(calls, 1);
  await assert.rejects(resumeUpload(file, {signal: new AbortController().signal, read: async () => {throw Object.assign(Error("forbidden"), {status: 403});}, send: async () => {}, progress() {}, waiting() {assert.fail("must not retry");}}), /forbidden/);
  assert.match(uploadBytes(12_345_678), /12,3 МБ/);
});
