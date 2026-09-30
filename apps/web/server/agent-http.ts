// ABOUTME: Подключает проверку сессии, NATS порт и SSE hub к HTTP handler-ам.
// ABOUTME: Auth gate остаётся отдельным от owner ErrorResponse agent.
import { checkOrigin, requireTimerSession } from "./auth";
import { GatewayError } from "./gateway";
import { AgentGatewayError, agentError, agentErrorResponse, agentRequest } from "./agent-gateway";
import { agentEventStream } from "./agent-hub";
import { agentRuntime } from "./agent-runtime";
import { createAgentHttpHandlers, type HandlerSession } from "./agent-handler";
import { validateDto } from "@brai/agent/contracts";
import type { ThreadSnapshot } from "@brai/agent/contracts";

const noStore = { "Cache-Control": "no-store" };

function failure(error: unknown, mutation: boolean): Response {
  if (error instanceof GatewayError) {
    if (error.status === 401 || error.status === 403) return Response.json({ code: error.code }, { status: error.status, headers: noStore });
    if (error.status >= 500) return Response.json({ code: error.code }, { status: error.status, headers: noStore });
    const status = error.status === 413 ? 413 : error.status === 415 ? 400 : 400;
    return Response.json({ code: status === 413 ? "REQUEST_TOO_LARGE" : "INVALID_ARGUMENT", outcome: mutation ? "not-sent" : "query" }, { status, headers: noStore });
  }
  if (error instanceof AgentGatewayError) return agentErrorResponse(error);
  const detail = error && typeof error === "object" ? error as { status?: number; code?: string } : {};
  const knownCodes = ["INVALID_ARGUMENT", "STALE_GENERATION", "OPERATION_CONFLICT", "REQUEST_TOO_LARGE", "ITEM_TOO_LARGE", "CAPACITY_EXHAUSTED", "UPSTREAM_UNAVAILABLE", "TIMEOUT", "NOT_FOUND", "UNSUPPORTED", "STALE_REQUEST"];
  const code = knownCodes.includes(detail.code ?? "") ? detail.code as "INVALID_ARGUMENT" : detail.status === 413 ? "REQUEST_TOO_LARGE" : detail.status === 404 ? "NOT_FOUND" : detail.status === 400 || detail.status === 415 ? "INVALID_ARGUMENT" : "UPSTREAM_UNAVAILABLE";
  const status = detail.status === 415 ? 400 : detail.status ?? 503;
  return agentErrorResponse(agentError(status, code, mutation ? "not-sent" : "query"));
}

const handlers = createAgentHttpHandlers({
  authorize: (request, eventStream = false) => requireTimerSession(request, eventStream),
  checkOrigin,
  request: agentRequest,
  eventStream: events,
  failure,
});

/** Проверяет событие query и до NATS запрещает неверные адреса треда. */
async function events(request: Request, session: HandlerSession, path: string[]): Promise<Response> {
  if (path.length !== 1) return agentErrorResponse(agentError(404, "NOT_FOUND", "query"));
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  const threadId = url.searchParams.get("threadId");
  const keys = [...url.searchParams.keys()];
  if (!projectId || !threadId || keys.some(key => !["projectId", "threadId", "expectedUserId"].includes(key)) || new Set(keys).size !== keys.length) throw agentError(400, "INVALID_ARGUMENT", "query");
  if (!validateDto("ThreadReadRequest", { projectId, threadId })) throw agentError(400, "INVALID_ARGUMENT", "query");
  const instance = agentRuntime();
  await Promise.race([instance.ensure(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("UNAVAILABLE")), 3000))]);
  const authorized = async () => {
    try { const current = await requireTimerSession(request, true); return current.session.id === session.session.id && current.user.id === session.user.id; }
    catch { return false; }
  };
  const body = { projectId, threadId };
  return new Response(agentEventStream(instance.hub, async () => await agentRequest("thread", body) as ThreadSnapshot,
    request.signal, { userId: session.user.id, sessionId: session.session.id, projectId, threadId }, authorized), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
}

/** Обрабатывает GET команду или снимок agent после session gate. */
export async function agentGet(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  return handlers.get(request, path);
}

/** Обрабатывает одну POST мутацию с Origin и session gate. */
export async function agentPost(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  return handlers.post(request, path);
}
