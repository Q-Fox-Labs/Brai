// ABOUTME: Проверяет локальную session identity и доверенного owner на реальных web HTTP адаптерах.
// ABOUTME: Подменяет только NATS transport; fixtures синтетические, чужие данные не используются.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";
import type { Artifact } from "../../../services/artifacts/contracts/index.mjs";
const require = createRequire(import.meta.url);
function load(name: string, ports: Record<string, unknown>) {
  const source = readFileSync(new URL(`../server/${name}.ts`, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true } }).outputText;
  const module = { exports: {} as Record<string, any> };
  const originalRequire = createRequire(new URL(`../server/${name}.ts`, import.meta.url));
  new Function("require", "module", "exports", output)((name: string) => ports[name] ?? originalRequire(name), module, module.exports);
  return module.exports;
}
const id = "11111111-1111-4111-8111-111111111111", copyId = "22222222-2222-4222-8222-222222222222";
const variables = ["WEB_ORIGIN", "BRAI_AGENT_ALLOWED_EMAILS", "BRAI_AGENT_OWNER_EMAIL", "BRAI_AGENT_OWNER_ID", "AGENT_ARTIFACTS_UPLOAD_BASE_URL", "ARTIFACTS_UPLOAD_BASE_URL", "AGENT_ARTIFACTS_NATS_URL", "AGENT_ARTIFACTS_NATS_USER", "AGENT_ARTIFACTS_NATS_PASSWORD", "AGENT_ARTIFACTS_NATS_INBOX_PREFIX", "NATS_URL", "AGENT_RESULTS_NATS_URL", "AGENT_RESULTS_NATS_USER", "AGENT_RESULTS_NATS_PASSWORD", "AGENT_RESULTS_NATS_INBOX_PREFIX"];
function fixture(mapped = true) {
  const previous = Object.fromEntries(variables.map(key => [key, process.env[key]]));
  for (const key of variables) delete process.env[key];
  Object.assign(process.env, { WEB_ORIGIN: "https://dev.test", BRAI_AGENT_ALLOWED_EMAILS: "owner@example.test,other@example.test", NATS_URL: "nats://local.test:4222", AGENT_ARTIFACTS_NATS_URL: "nats://shared.test:4222", AGENT_ARTIFACTS_NATS_USER: "attachment-fixture", AGENT_ARTIFACTS_NATS_PASSWORD: "synthetic", AGENT_ARTIFACTS_NATS_INBOX_PREFIX: "_INBOX.test.attachments", AGENT_ARTIFACTS_UPLOAD_BASE_URL: "https://native-upload.test" });
  if (mapped) Object.assign(process.env, { BRAI_AGENT_OWNER_EMAIL: "OWNER@example.test", BRAI_AGENT_OWNER_ID: "canonical-owner" });
  const session = { user: { id: "local-user", email: "owner@example.test", emailVerified: true }, session: { id: "session", userId: "local-user", expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  const artifact: Artifact = { artifactId: id, ownerId: mapped ? "canonical-owner" : "local-user", requestId: "prepare-id", kind: "original", status: "ready", title: "image.png", filename: "image.png", extension: "png", mimeType: "image/png", source: "agent", details: { projectId: "project", threadId: "thread" }, internalUrl: "https://files.test/files/" + id, sizeBytes: 10, sha256: "a".repeat(64), createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  const binding = { ownerId: artifact.ownerId, projectId: "project", threadId: "thread", turnId: "turn", itemId: "item", artifactIds: [id], createdAt: artifact.createdAt };
  let uploadUrl = "https://native-upload.test/upload/abcdefghijklmnop", agentReply: unknown = { generation: "generation", data: [{ attachments: [{ url: `/api/agent/attachments/${id}?projectId=project&threadId=thread&expectedUserId=canonical-owner&itemId=item&turnId=turn` }], text: "canonical-owner" }] };
  const calls: { broker: string; subject: string; payload: any }[] = [], connections: Record<string, unknown>[] = [];
  const connection = (broker: string) => ({ isClosed: () => false, async *status() { await new Promise(() => {}); }, async request(subject: string, data: Uint8Array) {
    const payload = JSON.parse(Buffer.from(data).toString()); calls.push({ broker, subject, payload });
    let reply: unknown;
    if (subject === "brai.auth.v1.session") reply = { status: 200, body: session, setCookies: [] };
    else if (subject === "brai.agent.v3.rpc") reply = payload.action === "projects" ? { projects: [{ projectId: "project", available: true }], generation: "generation" } : agentReply;
    else if (subject.endsWith(".prepare")) reply = { artifact: { ...artifact, requestId: payload.requestId, kind: payload.kind }, uploadUrl };
    else if (subject.endsWith(".output.list")) reply = { bindings: [binding] };
    else if (subject.endsWith(".reference.list")) reply = { items: [{ scope: { ownerId: artifact.ownerId, projectId: "project", threadId: "thread", operationId: "op" }, state: "confirmed", clientUserMessageId: "native-id", commandHash: "b".repeat(64), attachments: [{ originalArtifactId: id, modelArtifactId: id }], itemId: "item", turnId: "turn", createdAt: artifact.createdAt, updatedAt: artifact.updatedAt }] };
    else if (subject.endsWith(".relation.add")) reply = { modelArtifactId: copyId, originalArtifactId: id };
    else if (subject.endsWith(".get")) reply = payload.artifactId === copyId ? { ...artifact, artifactId: copyId, kind: "copy" } : artifact;
    else throw new Error(`Unexpected ${subject}`);
    return { data: Buffer.from(JSON.stringify(reply)), headers: { get: () => undefined, has: () => false } };
  } });
  const nats = { ...require("nats"), connect: async (options: Record<string, unknown>) => { connections.push(options); return connection(String(options.servers)); } };
  const contracts = load("contracts", {}), gateway = load("gateway", { nats, "./contracts": contracts });
  const auth = load("auth", { "./contracts": contracts, "./gateway": gateway });
  const agent = load("agent-http", { "./auth": auth, "./gateway": gateway, "../lib/agent/stream": {} });
  const transport = load("agent-artifacts", { nats, "./gateway": gateway });
  const artifacts = load("artifacts-http", { "./auth": auth, "./gateway": gateway, "./agent-http": agent, "./agent-artifacts": transport, "./request-body": load("request-body", {}) });
  const request = (path: string, body?: unknown, user = "local-user") => new Request(`https://dev.test/api/agent/${path}`, { method: body ? "POST" : "GET", headers: { origin: "https://dev.test", "x-brai-user": user, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { session, artifact, binding, calls, connections, request, agent, artifacts, transport, setUpload(value: string) { uploadUrl = value; }, setAgent(value: unknown) { agentReply = value; }, close() { for (const key of variables) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } } };
}
const prepare = { projectId: "project", threadId: "thread", requestId: "prepare-id", kind: "original", filename: "image.png", mimeType: "image/png" };

test("HTTP uses canonical owner internally and local identity in returned attachment URLs", async () => {
  const f = fixture();
  try {
    const response = await f.agent.agentGet(f.request("items?projectId=project&threadId=thread"), { params: Promise.resolve({ path: ["items"] }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(new URL(body.data[0].attachments[0].url, "https://dev.test").searchParams.get("expectedUserId"), "local-user");
    assert.equal(body.data[0].text, "canonical-owner");
    assert.equal(f.calls.at(-1)?.payload.ownerId, "canonical-owner");
    const snapshot = { event: { snapshot: { items: body.data.map((item: any) => ({ ...item, attachments: [{ url: `/api/agent/attachments/${id}?expectedUserId=canonical-owner` }] })) } } };
    assert.equal(f.agent.agentBrowserResult(snapshot, "canonical-owner", "local-user").event.snapshot.items[0].attachments[0].url, `/api/agent/attachments/${id}?expectedUserId=local-user`);
    assert.ok(snapshot.event.snapshot.items[0].attachments[0].url.endsWith("canonical-owner"));
    for (const body of [{ ...prepare, ownerId: "canonical-owner" }, { ...prepare, ownerId: "spoof" }]) assert.equal((await f.artifacts.prepareAttachment(f.request("attachments/prepare", body))).status, 400);
    const spoof = await f.agent.agentPost(f.request("start", { projectId: "project", threadId: "thread", generation: "generation", operationId: "op", text: "synthetic", ownerId: "canonical-owner" }), { params: Promise.resolve({ path: ["start"] }) });
    assert.equal(spoof.status, 400);
    assert.equal((await f.artifacts.prepareAttachment(f.request("attachments/prepare", prepare, "canonical-owner"))).status, 401);
  } finally { f.close(); }
});

test("configured pair requires matching verified email; partial config fails closed and absent config stays legacy", async () => {
  const f = fixture();
  try {
    f.session.user.email = "other@example.test";
    assert.equal((await f.artifacts.prepareAttachment(f.request("attachments/prepare", prepare))).status, 403);
    f.session.user.email = "owner@example.test"; f.session.user.emailVerified = false;
    assert.equal((await f.artifacts.prepareAttachment(f.request("attachments/prepare", prepare))).status, 403);
    f.session.user.emailVerified = true; delete process.env.BRAI_AGENT_OWNER_ID;
    assert.equal((await f.artifacts.prepareAttachment(f.request("attachments/prepare", prepare))).status, 503);
    assert.equal(f.calls.filter(call => call.subject.startsWith("brai.artifacts")).length, 0);
  } finally { f.close(); }
  const legacy = fixture(false);
  try { assert.equal((await legacy.artifacts.prepareAttachment(legacy.request("attachments/prepare", prepare))).status, 200); assert.equal(legacy.calls.at(-1)?.payload.ownerId, "local-user"); }
  finally { legacy.close(); }
});

test("prepare verifies native upload origin and returns same-origin token route; NATS stays split", async () => {
  const f = fixture();
  try {
    const response = await f.artifacts.prepareAttachment(f.request("attachments/prepare", prepare));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).uploadUrl, "/api/agent/uploads/abcdefghijklmnop");
    assert.equal(f.calls.find(call => call.subject === "brai.artifacts.v1.prepare")?.payload.ownerId, "canonical-owner");
    assert.ok(f.calls.filter(call => call.subject.startsWith("brai.artifacts")).every(call => call.broker === "nats://shared.test:4222"));
    assert.ok(f.calls.filter(call => !call.subject.startsWith("brai.artifacts")).every(call => call.broker === "nats://local.test:4222"));
    assert.deepEqual(f.connections.find(value => value.servers === "nats://shared.test:4222"), { servers: "nats://shared.test:4222", user: "attachment-fixture", pass: "synthetic", inboxPrefix: "_INBOX.test.attachments", name: "brai_web_agent_artifacts", timeout: 2000, maxReconnectAttempts: -1 });
    for (const url of ["https://evil.test/upload/abcdefghijklmnop", "https://native-upload.test/upload/abcdefghijklmnop?token=x", "https://native-upload.test/upload/abcdefghijklmnop#fragment", "https://name:password@native-upload.test/upload/abcdefghijklmnop", "https://native-upload.test/files/abcdefghijklmnop", "https://native-upload.test/upload/short"]) {
      f.setUpload(url); assert.equal((await f.artifacts.prepareAttachment(f.request("attachments/prepare", prepare))).status, 502);
    }
    delete process.env.AGENT_ARTIFACTS_NATS_URL;
    await f.transport.agentArtifactsConnection();
    assert.equal(f.connections.length, 2, "legacy fallback reuses local connection");
  } finally { f.close(); }
});

test("prepare behind HTTP or HTTPS standalone proxy never exposes the internal request origin", async () => {
  const f = fixture();
  try {
    for (const origin of ["http://localhost:3000", "https://localhost:3000"]) {
      const request = new Request(`${origin}/api/agent/attachments/prepare`, { method: "POST", headers: { origin: "https://dev.test", "x-brai-user": "local-user", "content-type": "application/json", "x-forwarded-proto": "https", "x-forwarded-host": "dev.test" }, body: JSON.stringify(prepare) });
      const response = await f.artifacts.prepareAttachment(request);
      assert.equal(response.status, 200);
      const { uploadUrl } = await response.json();
      assert.equal(uploadUrl, "/api/agent/uploads/abcdefghijklmnop");
      assert.equal(new URL(uploadUrl, "https://dev.test/agent").href, "https://dev.test/api/agent/uploads/abcdefghijklmnop");
    }
  } finally { f.close(); }
});

test("protected file and finalize use canonical ownership after local browser guard", async () => {
  const f = fixture();
  try {
    const input = { projectId: "project", threadId: "thread", requestId: "relation-id", originalArtifactId: id, modelArtifactId: id };
    assert.equal((await f.artifacts.finalizeAttachment(f.request("attachments/finalize", input))).status, 200);
    const file = (expected: string) => new Request("https://dev.test/api/agent/artifact-auth", { headers: { "x-forwarded-method": "GET", "x-forwarded-uri": `/api/agent/attachments/${id}?projectId=project&threadId=thread&expectedUserId=${expected}&itemId=item&turnId=turn` } });
    assert.equal((await f.artifacts.artifactReadAuth(file("canonical-owner"))).status, 401);
    const result = await f.artifacts.artifactReadAuth(file("local-user"));
    assert.equal(result.status, 200); assert.equal(result.headers.get("Content-Type"), "image/png");
    assert.equal(f.calls.find(call => call.subject.endsWith(".reference.list"))?.payload.scope.ownerId, "canonical-owner");
    f.artifact.ownerId = "unrelated-owner";
    assert.equal((await f.artifacts.finalizeAttachment(f.request("attachments/finalize", input))).status, 404);
    assert.equal((await f.artifacts.artifactReadAuth(file("local-user"))).status, 404);
  } finally { f.close(); }
});

const outputQuery = "projectId=project&threadId=thread&expectedUserId=local-user&itemId=item&turnId=turn";
function outputAuth(query = outputQuery, method = "GET") {
  return new Request("https://dev.test/api/agent/artifact-auth", { method, headers: { "x-forwarded-method": method, "x-forwarded-uri": `/api/agent/results/${id}?${query}` } });
}

test("results GET and HEAD require exact durable binding, canonical owner and current local session", async () => {
  const f = fixture();
  try {
    for (const method of ["GET", "HEAD"]) {
      const response = await f.artifacts.artifactReadAuth(outputAuth(outputQuery, method));
      assert.equal(response.status, 200); assert.equal(await response.text(), "");
      assert.equal(response.headers.get("Content-Type"), "image/png");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
      assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
    }
    const query = f.calls.find(call => call.subject.endsWith(".output.list"))?.payload;
    assert.deepEqual(query, { ownerId: "canonical-owner", projectId: "project", threadId: "thread", itemIds: ["item"] });
    assert.ok(f.calls.filter(call => call.subject === "brai.agent.v3.rpc").every(call => call.payload.action === "projects"), "authorization must not reread native history");
    assert.equal((await f.artifacts.artifactReadAuth(outputAuth(outputQuery.replace("local-user", "canonical-owner")))).status, 401);
    for (const change of ["itemId=wrong", "turnId=wrong", "threadId=wrong"]) {
      const key = change.split("=")[0];
      assert.equal((await f.artifacts.artifactReadAuth(outputAuth(outputQuery.replace(new RegExp(`${key}=[^&]+`), change)))).status, 404);
    }
    for (const query of [outputQuery.replace("&itemId=item", ""), outputQuery.replace("&turnId=turn", ""), "projectId=project&threadId=thread&expectedUserId=local-user", `${outputQuery}&itemId=item`, `${outputQuery}&download=0`, `${outputQuery}&download=1&download=1`, `${outputQuery}&ownerId=canonical-owner`]) {
      assert.equal((await f.artifacts.artifactReadAuth(outputAuth(query))).status, 400);
    }
    for (const key of ["ownerId", "projectId", "threadId", "turnId", "itemId"] as const) {
      const original = f.binding[key]; f.binding[key] = "spoof";
      assert.equal((await f.artifacts.artifactReadAuth(outputAuth())).status, 404);
      f.binding[key] = original;
    }
    f.binding.artifactIds = [copyId];
    assert.equal((await f.artifacts.artifactReadAuth(outputAuth())).status, 404);
    f.binding.artifactIds = [id];
    f.artifact.ownerId = "other"; assert.equal((await f.artifacts.artifactReadAuth(outputAuth())).status, 404);
    f.artifact.ownerId = "canonical-owner";
    for (const status of ["deleted", "deleting", "pending", "failed"] as const) {
      f.artifact.status = status; delete f.artifact.internalUrl; if (status === "deleted") f.artifact.deletedAt = f.artifact.updatedAt; assert.equal((await f.artifacts.artifactReadAuth(outputAuth(outputQuery, "HEAD"))).status, 404);
    }
  } finally { f.close(); }
});

test("results isolate outgoing reads and restrict inline media; downloads retain encoded original filename", async () => {
  const f = fixture();
  try {
    process.env.AGENT_RESULTS_NATS_URL = "nats://results.test:4222";
    process.env.AGENT_RESULTS_NATS_USER = "results-web";
    for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"]) {
      f.artifact.mimeType = mime;
      const response = await f.artifacts.artifactReadAuth(outputAuth());
      assert.equal(response.status, 200); assert.equal(response.headers.get("Content-Type"), mime); assert.equal(response.headers.get("Content-Disposition"), "inline");
    }
    f.artifact.filename = 'Отчёт "1".svg';
    for (const mime of ["image/svg+xml", "text/html", "text/plain", "application/pdf"]) {
      f.artifact.mimeType = mime;
      const response = await f.artifacts.artifactReadAuth(outputAuth());
      assert.equal(response.headers.get("Content-Type"), "application/octet-stream");
      assert.match(response.headers.get("Content-Disposition")!, /^attachment; filename="download"; filename\*=UTF-8''%D0/);
    }
    f.artifact.mimeType = "image/png";
    const download = await f.artifacts.artifactReadAuth(outputAuth(`${outputQuery}&download=1`));
    assert.equal(download.headers.get("Content-Type"), "application/octet-stream");
    assert.match(download.headers.get("Content-Disposition")!, /%22/);
    assert.ok(f.calls.filter(call => call.subject.startsWith("brai.artifacts")).every(call => call.broker === "nats://results.test:4222"));
    assert.equal((await f.artifacts.prepareAttachment(f.request("attachments/prepare", prepare))).status, 409, "incoming still uses shared transport and its original metadata checks");
    assert.equal(f.calls.at(-1)?.broker, "nats://shared.test:4222");
  } finally { f.close(); }
});

test("result URL browser identity rewriting rejects malformed owner, target, duplicate and unknown query fields", () => {
  const f = fixture();
  try {
    const url = `/api/agent/results/${id}?${outputQuery.replace("local-user", "canonical-owner")}`;
    const input = { event: { snapshot: { items: [{ results: [{ artifactId: id, previewUrl: url, downloadUrl: url + "&download=1" }], text: "canonical-owner" }] } } };
    const result = f.agent.agentBrowserResult(input, "canonical-owner", "local-user");
    assert.ok(result.event.snapshot.items[0].results[0].previewUrl.includes("expectedUserId=local-user"));
    assert.ok(input.event.snapshot.items[0].results[0].previewUrl.includes("expectedUserId=canonical-owner"));
    for (const bad of [url.replace(id, copyId), url + "&expectedUserId=canonical-owner", url + "&spoof=1", url + "#fragment", url.replace("canonical-owner", "other"), "https://evil.test" + url]) {
      const value = f.agent.agentBrowserResult({ results: [{ artifactId: id, previewUrl: bad, downloadUrl: bad + "&download=1" }] }, "canonical-owner", "local-user");
      assert.equal(value.results[0].previewUrl, undefined); assert.equal(value.results[0].downloadUrl, undefined);
    }
  } finally { f.close(); }
});
