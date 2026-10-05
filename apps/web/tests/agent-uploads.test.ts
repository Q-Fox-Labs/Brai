// ABOUTME: Проверяет прямые uploads, durable prepare IDs и uncertain response reconciliation.
// ABOUTME: HTTP endpoints заменены контролируемым fetcher; байты не проходят через agent RPC.
import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadAttachment } from "../lib/agent/uploads.ts";
import type { Attachment } from "../lib/agent/images.ts";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const scope = { userId: "user-a", projectId: "project-a", threadId: "thread-a" };
const makeAttachment = (reduced = false): Attachment => {
  const original = new File([png], "photo.png", { type: "image/png" });
  const model = reduced ? new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }) : original;
  return { id: crypto.randomUUID(), name: original.name, original, model, bytes: model.size, reduced, previewUrl: "blob:fixture", previewObjectUrl: false,
    originalRequestId: "stable-original-id", modelRequestId: reduced ? "stable-copy-id" : null, relationRequestId: "stable-relation-id" };
};
function fixture() {
  const old = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://app.test/", origin: "https://app.test" } });
  return () => { if (old) Object.defineProperty(globalThis, "location", old); else Reflect.deleteProperty(globalThis, "location"); };
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
function uploaded(id: string, size: number) { return new Response(null, { status: 201, headers: { "X-Artifact-Id": id, "X-Artifact-State": "ready", "X-Artifact-Size": String(size), "X-Artifact-SHA256": "a".repeat(64), Location: "https://artifacts.internal/files/abc" } }); }

test("small original reuses its ID and a valid 201 avoids an extra prepare round trip", async () => {
  const calls: { url: string; init?: RequestInit }[] = [], restore = fixture();
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url === "/api/agent/attachments/prepare") return json({ artifact: { artifactId: "original-id", status: "pending" }, uploadUrl: "https://app.test/upload/abcdefghijklmnop" });
    if (url.startsWith("https://app.test/upload/")) return uploaded("original-id", png.length);
    if (url === "/api/agent/attachments/finalize") return json({ status: "ready" });
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const image = makeAttachment(false), ready = await uploadAttachment(image, scope, new AbortController().signal, fetcher);
    assert.deepEqual(ready, { originalArtifactId: "original-id", modelArtifactId: "original-id", url: "/api/agent/attachments/original-id?projectId=project-a&threadId=thread-a&expectedUserId=user-a" });
    assert.equal(calls.filter(call => call.url === "/api/agent/attachments/prepare").length, 1);
    assert.equal(calls.filter(call => call.url.startsWith("https://app.test/upload/")).length, 1);
    const prepareBody = JSON.parse(String(calls[0].init?.body));
    assert.equal(prepareBody.requestId, image.originalRequestId);
    assert.equal(Object.hasOwn(prepareBody, "ownerId"), false);
    const finalize = JSON.parse(String(calls.at(-1)?.init?.body));
    assert.deepEqual(finalize, { projectId: scope.projectId, threadId: scope.threadId, requestId: image.relationRequestId, originalArtifactId: "original-id", modelArtifactId: "original-id" });
  } finally { restore(); }
});

test("reduced copy uploads separately and finalization binds its ID to the original", async () => {
  const calls: { url: string; init?: RequestInit }[] = [], states = new Map([["stable-original-id", "original-id"], ["stable-copy-id", "copy-id"]]);
  const restore = fixture();
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url === "/api/agent/attachments/prepare") {
      const body = JSON.parse(String(init?.body));
      return json({ artifact: { artifactId: states.get(body.requestId), status: "pending" }, uploadUrl: `https://app.test/upload/${body.kind === "original" ? "abcdefghijklmnop" : "qrstuvwxyzABCDEF"}` });
    }
    if (url.startsWith("https://app.test/upload/")) {
      const body = calls.filter(call => call.url === "/api/agent/attachments/prepare").map(call => JSON.parse(String(call.init?.body))).at(-1);
      return uploaded(body.kind === "original" ? "original-id" : "copy-id", (init?.body as Blob).size);
    }
    if (url === "/api/agent/attachments/finalize") return json({ status: "ready" });
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const image = makeAttachment(true), ready = await uploadAttachment(image, scope, new AbortController().signal, fetcher);
    assert.equal(ready.originalArtifactId, "original-id"); assert.equal(ready.modelArtifactId, "copy-id");
    assert.equal(calls.filter(call => call.url.startsWith("https://app.test/upload/")).length, 2);
    assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { projectId: scope.projectId, threadId: scope.threadId, requestId: image.relationRequestId, originalArtifactId: "original-id", modelArtifactId: "copy-id" });
  } finally { restore(); }
});

test("lost PUT response reconciles with the same prepare ID; aborted old scope never reconciles", async () => {
  const restore = fixture(); let prepareCalls = 0, putCalls = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "/api/agent/attachments/prepare") {
      prepareCalls++;
      return json({ artifact: { artifactId: "original-id", status: prepareCalls === 1 ? "pending" : "ready" }, uploadUrl: "https://app.test/upload/abcdefghijklmnop" });
    }
    if (url.startsWith("https://app.test/upload/")) { putCalls++; throw new TypeError("connection dropped"); }
    if (url === "/api/agent/attachments/finalize") return json({ status: "ready" });
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const ready = await uploadAttachment(makeAttachment(false), scope, new AbortController().signal, fetcher);
    assert.equal(ready.originalArtifactId, "original-id"); assert.equal(prepareCalls, 2); assert.equal(putCalls, 1);
    let abortedPrepareCalls = 0; const controller = new AbortController();
    const abortingFetcher: typeof fetch = async (input) => {
      if (String(input) === "/api/agent/attachments/prepare") { abortedPrepareCalls++; return json({ artifact: { artifactId: "old-id", status: "pending" }, uploadUrl: "https://app.test/upload/abcdefghijklmnop" }); }
      if (String(input).startsWith("https://app.test/upload/")) { controller.abort(); throw new DOMException("Aborted", "AbortError"); }
      throw new Error("No finalize expected");
    };
    await assert.rejects(uploadAttachment(makeAttachment(false), scope, controller.signal, abortingFetcher), /отменена/);
    assert.equal(abortedPrepareCalls, 1);
  } finally { restore(); }
});

test("prepare preserves explicit authorization errors for a clear user retry", async () => {
  const restore = fixture();
  try {
    await assert.rejects(uploadAttachment(makeAttachment(false), scope, new AbortController().signal, async () => json({ code: "ACCOUNT_CHANGED" }, 401)), /Сеанс или аккаунт изменился/);
  } finally { restore(); }
});
