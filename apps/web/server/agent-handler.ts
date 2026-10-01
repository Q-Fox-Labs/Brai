// ABOUTME: Собирает реальное HTTP поведение шлюза agent на injected ports.
// ABOUTME: Проверяет Origin и сессию до owner request; тестам не нужен NATS.
import { limits } from "@brai/agent/contracts";
import { AgentGatewayError, agentError, agentErrorResponse } from "./agent-gateway.ts";
import type { AgentOperation } from "./agent-gateway.ts";

export type HandlerSession = { session: { id: string }; user: { id: string } };
export type HandlerDependencies = {
  authorize: (request: Request, eventStream?: boolean) => Promise<HandlerSession>;
  checkOrigin: (request: Request) => void;
  request: (operation: AgentOperation, body: unknown) => Promise<unknown>;
  eventStream: (request: Request, session: HandlerSession, path: string[]) => Promise<Response>;
  failure: (error: unknown, mutation: boolean) => Response;
};

/** Создаёт общий mapper для auth отказов, owner errors и некорректного HTTP ввода. */
export function createAgentFailureMapper(isAuthError: (error: unknown) => boolean) {
  return (error: unknown, mutation: boolean): Response => {
    if (isAuthError(error)) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 503;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "AUTH_UNAVAILABLE";
      if (status === 401 || status === 403) return Response.json({ code }, { status, headers: { "Cache-Control": "no-store" } });
      return agentErrorResponse(agentError(503, "UPSTREAM_UNAVAILABLE", mutation ? "not-sent" : "query"));
    }
    if (error instanceof AgentGatewayError) return agentErrorResponse(error);
    const detail = error && typeof error === "object" ? error as { status?: number; code?: string } : {};
    const knownCodes = ["INVALID_ARGUMENT", "STALE_GENERATION", "OPERATION_CONFLICT", "REQUEST_TOO_LARGE", "ITEM_TOO_LARGE", "CAPACITY_EXHAUSTED", "UPSTREAM_UNAVAILABLE", "TIMEOUT", "NOT_FOUND", "UNSUPPORTED", "STALE_REQUEST"];
    const code = knownCodes.includes(detail.code ?? "") ? detail.code as "INVALID_ARGUMENT" : detail.status === 413 ? "REQUEST_TOO_LARGE" : detail.status === 404 ? "NOT_FOUND" : detail.status === 400 || detail.status === 415 ? "INVALID_ARGUMENT" : "UPSTREAM_UNAVAILABLE";
    const status = detail.status === 415 ? 400 : detail.status ?? 503;
    return agentErrorResponse(agentError(status, code, mutation ? "not-sent" : "query"));
  };
}

/** Создаёт GET/POST обработчики, инъецируя auth и NATS порты для изолированных проверок. */
export function createAgentHttpHandlers(deps: HandlerDependencies) {
  return {
    async get(request: Request, path: string[]): Promise<Response> {
      try {
        const isEvents = path[0] === "events";
        const session = await deps.authorize(request, isEvents);
        if (isEvents) return await deps.eventStream(request, session, path);
        const { operation, body } = resolveGet(path, new URL(request.url));
        return Response.json(await deps.request(operation, body), { headers: { "Cache-Control": "no-store" } });
      } catch (error) { return deps.failure(error, false); }
    },
    async post(request: Request, path: string[]): Promise<Response> {
      try {
        deps.checkOrigin(request);
        await deps.authorize(request);
        const body = await readJson(request);
        const operation: Record<string, AgentOperation> = {
          "threads": "threadCreate", "turns/start": "turnStart", "turns/steer": "turnSteer",
          "turns/interrupt": "turnInterrupt", "requests/respond": "requestRespond",
        };
        const name = operation[path.join("/")];
        if (!name) return deps.failure(Object.assign(new Error("NOT_FOUND"), { status: 404, code: "NOT_FOUND" }), true);
        return Response.json(await deps.request(name, body), { status: 202, headers: { "Cache-Control": "no-store" } });
      } catch (error) { return deps.failure(error, true); }
    },
  };
}

async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw Object.assign(new Error("CONTENT_TYPE"), { status: 415, code: "CONTENT_TYPE" });
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error("INVALID_ARGUMENT"), { status: 400, code: "INVALID_ARGUMENT" });
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    size += part.value.byteLength;
    if (size > limits.natsSseFrameBytes) { await reader.cancel(); throw Object.assign(new Error("REQUEST_TOO_LARGE"), { status: 413, code: "REQUEST_TOO_LARGE" }); }
    chunks.push(part.value);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw Object.assign(new Error("INVALID_ARGUMENT"), { status: 400, code: "INVALID_ARGUMENT" }); }
}

function paramsFromUrl(url: URL, required: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const name of required) {
    const value = url.searchParams.get(name);
    if (value === null) throw Object.assign(new Error("INVALID_ARGUMENT"), { status: 400, code: "INVALID_ARGUMENT" });
    result[name] = value;
  }
  for (const name of ["cursor", "turnId"]) if (url.searchParams.has(name)) result[name] = url.searchParams.get(name)!;
  if (url.searchParams.has("limit")) {
    const raw = url.searchParams.get("limit")!;
    if (!/^\d+$/.test(raw)) throw Object.assign(new Error("INVALID_ARGUMENT"), { status: 400, code: "INVALID_ARGUMENT" });
    result.limit = Number(raw);
  }
  return result;
}

function allowOnly(url: URL, names: string[]) {
  const keys = [...url.searchParams.keys()];
  if (keys.some(name => !names.includes(name)) || new Set(keys).size !== keys.length) throw Object.assign(new Error("INVALID_ARGUMENT"), { status: 400, code: "INVALID_ARGUMENT" });
}

function resolveGet(path: string[], url: URL): { operation: AgentOperation; body: unknown } {
  if (path.length === 1 && path[0] === "projects") { allowOnly(url, []); return { operation: "projects", body: {} }; }
  if (path.length === 1 && path[0] === "status") { allowOnly(url, []); return { operation: "status", body: {} }; }
  if (path.length === 1 && path[0] === "threads") { allowOnly(url, ["projectId", "cursor", "limit"]); return { operation: "threads", body: paramsFromUrl(url, ["projectId"]) }; }
  if (path.length === 2 && path[0] === "threads") { allowOnly(url, ["projectId"]); return { operation: "thread", body: { projectId: url.searchParams.get("projectId"), threadId: path[1] } }; }
  if (path.length === 3 && path[0] === "threads" && path[2] === "history") { allowOnly(url, ["projectId", "cursor", "limit", "turnId"]); return { operation: "history", body: { ...paramsFromUrl(url, ["projectId"]), threadId: path[1] } }; }
  throw Object.assign(new Error("NOT_FOUND"), { status: 404, code: "NOT_FOUND" });
}
