// ABOUTME: Подключает проверку сессии, NATS порт и SSE hub к HTTP handler-ам.
// ABOUTME: Auth gate остаётся отдельным от owner ErrorResponse agent.
import { checkOrigin, requireTimerSession } from "./auth";
import { GatewayError } from "./gateway";
import { agentError, agentErrorResponse, agentRequest } from "./agent-gateway";
import { agentEventStream } from "./agent-hub";
import { agentRuntime } from "./agent-runtime";
import { createAgentFailureMapper, createAgentHttpHandlers, type HandlerSession } from "./agent-handler";
import { validateDto } from "@brai/agent/contracts";
import type { ThreadSnapshot } from "@brai/agent/contracts";

const failure = createAgentFailureMapper(error => error instanceof GatewayError);

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
