// ABOUTME: Проверяет бюджет подготовки, поддержку модели и сохранность правок черновика.
// ABOUTME: Браузерные кодеки заменены портами; реальный picker и clipboard проверяются отдельно в браузере.
import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptedDraft, restoredDraft, confirmedSubmission, imageModel, prepareImage, validateImageFile, type Attachment } from "../lib/agent/images.ts";
import { composerAction } from "../app/agent/timeline.ts";
import type { ModelCatalog, NativeSnapshot } from "@brai/agent/contracts";

const image = (id: string): Attachment => ({ id, name: `${id}.png`, original: file(), model: new Blob([png], { type: "image/png" }), bytes: 100, reduced: false, previewUrl: "blob:fixture", previewObjectUrl: false, originalRequestId: `original-${id}`, modelRequestId: null, relationRequestId: `relation-${id}` });
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const file = (size = 100) => new File([png, new Uint8Array(size - png.length)], "example.png", { type: "image/png" });

test("lost ACK draft clears only with a unique confirmed operation, never matching text or file IDs", () => {
  const message = { id: "native", turnId: "turn", type: "userMessage", text: "same text", operationId: "sent-op" };
  assert.equal(confirmedSubmission([message], "sent-op"), true);
  assert.equal(confirmedSubmission([{ ...message, operationId: undefined }], "sent-op"), false);
  assert.equal(confirmedSubmission([{ ...message, operationId: "other-op" }], "sent-op"), false);
  assert.equal(confirmedSubmission([{ ...message, type: "agentMessage" }], "sent-op"), false);
  assert.equal(confirmedSubmission([message, { ...message, id: "duplicate" }], "sent-op"), false);
  const sent = { text: "same text", revision: 1, images: [image("sent")] };
  const current = { text: "next message", revision: 2, images: [sent.images[0], image("new")] };
  assert.deepEqual(acceptedDraft(current, sent), { ...current, images: [current.images[1]] });
});

test("accepted removes sent IDs and preserves later attachments and text edits, including edits back to original", () => {
  const sent = { text: "text", revision: 2, images: [image("old")] };
  assert.deepEqual(acceptedDraft(sent, sent), { ...sent, text: "", images: [] });
  const edited = { text: "text", revision: 4, images: [image("old"), image("new")] };
  assert.deepEqual(acceptedDraft(edited, sent), { ...edited, images: [edited.images[1]] });
  const other = { text: "other chat", revision: 1, images: [image("other")] };
  const cache = new Map([["sent", sent], ["other", other]]);
  cache.set("sent", acceptedDraft(cache.get("sent")!, sent));
  assert.equal(cache.get("other"), other);
});

test("active images steer even without text; active model never falls back to selector or default", () => {
  const choice = { model: "vision", name: "Vision", efforts: ["high"], defaultEffort: "high", inputModalities: ["text", "image"], imageLimit: 8 };
  const text = { ...choice, model: "text", inputModalities: ["text"], imageLimit: 0 };
  const catalog: ModelCatalog = { generation: "gen", data: [choice, text], defaultModel: "vision" };
  const view = { generation: "gen", thread: { model: "text" } } as NativeSnapshot;
  assert.equal(imageModel(catalog, view, choice, true), text);
  assert.equal(imageModel(catalog, { ...view, thread: { ...view.thread, model: "missing" } }, choice, true), undefined);
  assert.equal(imageModel(catalog, { ...view, generation: "old" }, choice, false), undefined);
  assert.equal(imageModel(catalog, view, choice, false), choice);
  assert.equal(composerAction(true, "  ", 1), "steer");
  assert.equal(composerAction(false, "", 1), "start");
  assert.equal(composerAction(true, "  ", 0), "interrupt");
});

test("file format, signature and size fail with Russian reasons", () => {
  validateImageFile("image/png", png.length, png);
  assert.throws(() => validateImageFile("image/svg+xml", 100, png), /только PNG, JPEG и WebP/);
  assert.throws(() => validateImageFile("image/png", 21 * 1024 * 1024, png), /20 МиБ/);
  assert.throws(() => validateImageFile("image/jpeg", 100, png), /не соответствует/);
  assert.throws(() => validateImageFile("image/webp", 100, png), /не соответствует/);
});

test("original bytes remain intact, corrupt files fail, bitmap closes, pixel and tiny budget limits reject", async () => {
  const previous = globalThis.createImageBitmap;
  let closed = 0, width = 100, height = 100;
  globalThis.createImageBitmap = async () => ({ width, height, close() { closed++; } }) as ImageBitmap;
  try {
    const original = file();
    const prepared = await prepareImage(original, original.size);
    assert.equal(prepared.reduced, false);
    assert.equal(prepared.bytes, original.size);
    assert.equal(prepared.original, original);
    assert.deepEqual(Buffer.from(await prepared.model.arrayBuffer()), Buffer.from(await original.arrayBuffer()));
    const small = await prepareImage(file(png.length), 10 * 1024);
    assert.equal(small.reduced, false); assert.equal(small.bytes, png.length); URL.revokeObjectURL(small.previewUrl);
    await assert.rejects(prepareImage(original, 1), /не хватает места/);
    width = 8000; height = 5000;
    await assert.rejects(prepareImage(original, 655360), /32 миллионов пикселей/);
    assert.equal(closed, 4); URL.revokeObjectURL(prepared.previewUrl);
    globalThis.createImageBitmap = async () => { throw new Error("codec"); };
    await assert.rejects(prepareImage(original, 655360), /повреждён/);
  } finally { globalThis.createImageBitmap = previous; }
});

test("canvas reduction has bounded dimensions, preserves readable lower bound and marks a fitting copy", async () => {
  const oldBitmap = globalThis.createImageBitmap, oldDocument = globalThis.document;
  const sizes: number[] = [];
  let fit = true, closed = 0;
  const canvas = { width: 0, height: 0, getContext() { return { drawImage() { sizes.push(Math.max(canvas.width, canvas.height)); } }; }, toBlob(resolve: (blob: Blob) => void) { resolve(new Blob([new Uint8Array(fit ? 1000 : 50000)], { type: "image/webp" })); } };
  globalThis.createImageBitmap = async () => ({ width: 4000, height: 2000, close() { closed++; } }) as ImageBitmap;
  globalThis.document = { createElement() { return canvas; } } as unknown as Document;
  try {
    const prepared = await prepareImage(file(100000), 20000);
    assert.equal(prepared.reduced, true); assert.equal(prepared.bytes, 1000);
    assert.equal(prepared.model.type, "image/webp"); assert.equal(prepared.model.size, 1000);
    assert.equal(sizes[0], 2048);
    fit = false;
    await assert.rejects(prepareImage(file(100000), 20000), /без потери читаемости/);
    assert.ok(sizes.every(size => size >= 512 && size <= 2048));
    assert.equal(sizes.at(-1), 512); assert.equal(closed, 2); URL.revokeObjectURL(prepared.previewUrl);
  } finally { globalThis.createImageBitmap = oldBitmap; globalThis.document = oldDocument; }
});

 test("rejected optimistic message returns text and files without losing later edits", () => {
  const sent = { text: "original", revision: 4, images: [image("one")] };
  const cleared = acceptedDraft(sent, sent);
  assert.equal(cleared.text, ""); assert.equal(cleared.images.length, 0);
  assert.deepEqual(restoredDraft(cleared, sent), { ...sent, revision: 5 });
  const edited = { text: "later", revision: 5, images: [image("two")] };
  const restored = restoredDraft(edited, sent);
  assert.equal(restored.text, "original\nlater");
  assert.deepEqual(restored.images.map(image => image.id), ["one", "two"]);
});
