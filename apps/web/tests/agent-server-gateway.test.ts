// ABOUTME: Проверяет HTTP/NATS agent границу без NATS сервера.
// ABOUTME: Fake request port подтверждает owner validation и неизвестный исход мутаций.
import assert from "node:assert/strict";
import test from "node:test";
import { headers, ServiceErrorCodeHeader, ServiceErrorHeader } from "nats";
import { createAgentRequester, AgentGatewayError, AgentTransportError } from "../server/agent-gateway.ts";
import { createAgentFailureMapper, createAgentHttpHandlers } from "../server/agent-handler.ts";

const generation = "00000000-0000-4000-8000-000000000001";
const start = { projectId: "brai", threadId: "thread", generation, operationId: "op-1", text: "hi" };
const accepted = { generation, operationId: "op-1", outcome: "accepted", threadId: "thread", turnId: "turn" };

test("auth gate runs before request port and preserves 401 ownership", async () => {
  let requested = false, eventGate = false;
  const handlers = createAgentHttpHandlers({
    authorize: async (_request, isEvents) => { eventGate = Boolean(isEvents); throw Object.assign(new Error("unauthorized"), { status: 401, code: "UNAUTHORIZED" }); },
    checkOrigin: () => {}, request: async () => { requested = true; return {}; }, eventStream: async () => new Response(),
    failure: error => { const value = error as { status: number; code: string }; return Response.json({ code: value.code }, { status: value.status }); },
  });
  const response = await handlers.get(new Request("https://example.test/api/agent/events?expectedUserId=user"), ["events"]);
  assert.equal(response.status, 401);
  assert.equal(eventGate, true);
  assert.equal(requested, false);
});

test("asynchronous SSE bootstrap failures pass through the HTTP error mapper", async () => {
  const handlers = createAgentHttpHandlers({
    authorize: async () => ({ session: { id: "s" }, user: { id: "u" } }), checkOrigin: () => {}, request: async () => ({}),
    eventStream: async () => { throw Object.assign(new Error("unavailable"), { status: 503, code: "UPSTREAM_UNAVAILABLE" }); },
    failure: error => { const value = error as { status: number; code: string }; return Response.json({ code: value.code }, { status: value.status }); },
  });
  const response = await handlers.get(new Request("https://example.test/api/agent/events?expectedUserId=u"), ["events"]);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: "UPSTREAM_UNAVAILABLE" });
});

test("Origin 403 and session 401 both stop a mutation before its owner call", async () => {
  let authorized = false, sent = false;
  const options = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(start) };
  const rejected = (error: unknown) => { const value = error as { status: number; code: string }; return Response.json({ code: value.code }, { status: value.status }); };
  const originHandler = createAgentHttpHandlers({ authorize: async () => { authorized = true; return {} as never; }, checkOrigin: () => { throw Object.assign(new Error("origin"), { status: 403, code: "ORIGIN" }); }, request: async () => { sent = true; return accepted; }, eventStream: async () => new Response(), failure: rejected });
  const request = new Request("https://example.test/api/agent/turns/start", options);
  assert.equal((await originHandler.post(request, ["turns", "start"])).status, 403);
  assert.equal(authorized, false);
  const authHandler = createAgentHttpHandlers({ authorize: async () => { throw Object.assign(new Error("session"), { status: 401, code: "UNAUTHORIZED" }); }, checkOrigin: () => {}, request: async () => { sent = true; return accepted; }, eventStream: async () => new Response(), failure: rejected });
  assert.equal((await authHandler.post(new Request("https://example.test/api/agent/turns/start", options), ["turns", "start"])).status, 401);
  assert.equal(sent, false);
});

test("auth backend 503 maps to owner errors and never calls agent NATS", async () => {
  let ownerCalls = 0;
  const authUnavailable = () => Object.assign(new Error("auth unavailable"), { status: 503, code: "AUTH_UNAVAILABLE" });
  const isAuthFailure = (error: unknown) => error instanceof Error && "code" in error && error.code === "AUTH_UNAVAILABLE";
  const failure = createAgentFailureMapper(isAuthFailure);
  const handlers = createAgentHttpHandlers({
    authorize: async () => { throw authUnavailable(); }, checkOrigin: () => {}, request: async () => { ownerCalls++; return {}; },
    eventStream: async () => new Response(), failure,
  });
  const post = await handlers.post(new Request("https://example.test/api/agent/turns/start", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(start),
  }), ["turns", "start"]);
  assert.equal(post.status, 503);
  assert.deepEqual(await post.json(), { code: "UPSTREAM_UNAVAILABLE", outcome: "not-sent" });

  const get = await handlers.get(new Request("https://example.test/api/agent/projects"), ["projects"]);
  assert.equal(get.status, 503);
  assert.deepEqual(await get.json(), { code: "UPSTREAM_UNAVAILABLE", outcome: "query" });
  assert.equal(ownerCalls, 0);
});

test("validates exact DTO before one request and validates the owner response", async () => {
  const calls: { subject: string; timeout: number }[] = [];
  const request = createAgentRequester(async (subject, _payload, timeout) => {
    calls.push({ subject, timeout });
    return { data: Buffer.from(JSON.stringify(accepted)) };
  });
  await assert.rejects(request("turnStart", { ...start, extra: true }), AgentGatewayError);
  assert.equal(calls.length, 0);
  assert.deepEqual(await request("turnStart", start), accepted);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subject, "brai.agent.v1.command.turn.start");
  assert.equal(calls[0].timeout, 12000);
});

test("distinguishes not-sent, unknown mutation and query timeout", async () => {
  const notSent = createAgentRequester(async () => { throw new AgentTransportError(false); });
  await assert.rejects(notSent("turnStart", start), error => error instanceof AgentGatewayError && error.body.outcome === "not-sent");
  const unknown = createAgentRequester(async () => { throw new AgentTransportError(true, true); });
  await assert.rejects(unknown("turnStart", start), error => error instanceof AgentGatewayError && error.status === 504 && error.body.outcome === "unknown");
  const query = createAgentRequester(async () => { throw new AgentTransportError(true, true); });
  await assert.rejects(query("projects", {}), error => error instanceof AgentGatewayError && error.body.outcome === "query");
});

test("checks both service error headers before accepting a reply body", async () => {
  const serviceHeaders = headers();
  serviceHeaders.set(ServiceErrorHeader, "STALE_REQUEST");
  serviceHeaders.set(ServiceErrorCodeHeader, "409");
  const calls: string[] = [];
  const request = createAgentRequester(async () => {
    calls.push("turnStart");
    return { data: Buffer.from(JSON.stringify({ code: "STALE_REQUEST", outcome: "not-sent" })), headers: serviceHeaders };
  });
  await assert.rejects(request("turnStart", start), error => error instanceof AgentGatewayError && error.status === 409 && error.body.code === "STALE_REQUEST" && error.body.outcome === "not-sent");
  assert.deepEqual(calls, ["turnStart"]);
});

test("native NATS service headers preserve owner DTOs and keep the web 429 capacity mapping", async () => {
  for (const [serviceCode, numericStatus, outcome, webStatus] of [
    ["NOT_FOUND", "404", "query", 404],
    ["CAPACITY_EXHAUSTED", "503", "not-sent", 429],
  ] as const) {
    const serviceHeaders = headers();
    serviceHeaders.set(ServiceErrorHeader, serviceCode);
    serviceHeaders.set(ServiceErrorCodeHeader, numericStatus);
    let calls = 0;
    const request = createAgentRequester(async () => {
      calls++;
      return { data: Buffer.from(JSON.stringify({ code: serviceCode, outcome })), headers: serviceHeaders };
    });
    await assert.rejects(request(serviceCode === "NOT_FOUND" ? "projects" : "turnStart", serviceCode === "NOT_FOUND" ? {} : start), error =>
      error instanceof AgentGatewayError && error.status === webStatus && error.body.code === serviceCode && error.body.outcome === outcome);
    assert.equal(calls, 1);
  }
});

test("rejects absent, malformed, mismatched, and noncanonical native error headers once", async () => {
  const malformed = [
    { numeric: undefined, text: undefined, dto: { code: "STALE_REQUEST", outcome: "not-sent" } },
    { numeric: "409", text: undefined, dto: { code: "STALE_REQUEST", outcome: "not-sent" } },
    { numeric: undefined, text: "STALE_REQUEST", dto: { code: "STALE_REQUEST", outcome: "not-sent" } },
    { numeric: "409", text: "STALE_REQUEST", dto: { code: "BOGUS", outcome: "not-sent" } },
    { numeric: "409", text: "STALE_GENERATION", dto: { code: "STALE_REQUEST", outcome: "not-sent" } },
    ...["399", "600", "0409", "409 ", "4e2"].map(numeric => ({ numeric, text: "STALE_REQUEST", dto: { code: "STALE_REQUEST", outcome: "not-sent" } })),
  ];
  for (const fixture of malformed) {
    const serviceHeaders = headers();
    if (fixture.text !== undefined) serviceHeaders.set(ServiceErrorHeader, fixture.text);
    if (fixture.numeric !== undefined) serviceHeaders.set(ServiceErrorCodeHeader, fixture.numeric);
    // headers() NATS обрезает пробелы; этот крайний случай подаём напрямую на границе ответа.
    const replyHeaders = fixture.numeric === "409 " ? {
      get: (name: string) => name === ServiceErrorHeader ? fixture.text : name === ServiceErrorCodeHeader ? fixture.numeric : undefined,
    } : serviceHeaders;
    let calls = 0;
    const request = createAgentRequester(async () => {
      calls++;
      return { data: Buffer.from(JSON.stringify(fixture.dto)), headers: replyHeaders };
    });
    await assert.rejects(request("turnStart", start), error => error instanceof AgentGatewayError && error.status === 503 && error.body.code === "UPSTREAM_UNAVAILABLE" && error.body.outcome === "unknown");
    assert.equal(calls, 1);
  }
});

test("accepts canonical numeric service statuses at 400 and 599", async () => {
  for (const numericStatus of ["400", "599"] as const) {
    const serviceHeaders = headers();
    serviceHeaders.set(ServiceErrorHeader, "INVALID_ARGUMENT");
    serviceHeaders.set(ServiceErrorCodeHeader, numericStatus);
    const request = createAgentRequester(async () => ({ data: Buffer.from(JSON.stringify({ code: "INVALID_ARGUMENT", outcome: "not-sent" })), headers: serviceHeaders }));
    await assert.rejects(request("turnStart", start), error => error instanceof AgentGatewayError && error.status === 400 && error.body.code === "INVALID_ARGUMENT");
  }
});

test("a malformed post-send response is unknown and the port is never retried", async () => {
  let calls = 0;
  const request = createAgentRequester(async () => { calls++; return { data: Buffer.from("not-json") }; });
  await assert.rejects(request("turnStart", start), error => error instanceof AgentGatewayError && error.body.outcome === "unknown");
  assert.equal(calls, 1);
});

test("counts serialized UTF-8 command bytes before publishing", async () => {
  let calls = 0;
  const request = createAgentRequester(async () => { calls++; return { data: Buffer.from(JSON.stringify(accepted)) }; });
  await assert.rejects(request("turnStart", { ...start, text: "😀".repeat(17000) }), error => error instanceof AgentGatewayError && error.status === 413 && error.body.outcome === "not-sent");
  assert.equal(calls, 0);
});

test("rejects oversized raw owner replies before parsing", async () => {
  const request = createAgentRequester(async () => ({ data: Buffer.alloc(786433, 0x7b) }));
  await assert.rejects(request("thread", { projectId: "brai", threadId: "thread" }), error => error instanceof AgentGatewayError && error.status === 503 && error.body.outcome === "query");
});
