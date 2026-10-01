// ABOUTME: Передаёт HTTP запросы web к NATS Services агента.
// ABOUTME: Использует только публичный контракт владельца и не повторяет команды.
import { validateDto, subjects, limits, serializedBytes } from "@brai/agent/contracts";
import type { DtoName, ErrorResponse } from "@brai/agent/contracts";

/** Содержит проверенный owner error и соответствующий HTTP status. */
export class AgentGatewayError extends Error {
  public status: number;
  public body: ErrorResponse;
  /** Сохраняет owner payload вместе с HTTP статусом. */
  constructor(status: number, body: ErrorResponse) { super(body.code); this.status = status; this.body = body; }
}

/** Публичная операция agent, включая event subject для типобезопасной маршрутизации. */
export type AgentOperation = keyof typeof subjects;
type AgentReply = { data: Uint8Array; headers?: { get(name: string): string | undefined } };
/** Различает отказ до отправки и неопределённый транспортный исход. */
export class AgentTransportError extends Error {
  public sent: boolean;
  public timeout: boolean;
  /** `sent` сообщает, возможен ли уже неизвестный эффект мутации. */
  constructor(sent: boolean, timeout = false) { super(timeout ? "timeout" : "transport"); this.sent = sent; this.timeout = timeout; }
}
/** Порт для одного NATS Services request-reply; реализация никогда не повторяет вызов. */
export type AgentRequestPort = (subject: string, payload: Uint8Array, timeout: number) => Promise<AgentReply>;
const dtoByOperation: Partial<Record<AgentOperation, DtoName>> = {
  projects: "ProjectsRequest", status: "StatusRequest", threads: "ThreadsRequest", thread: "ThreadReadRequest",
  history: "HistoryRequest", threadCreate: "ThreadCreateRequest", turnStart: "TurnStartRequest",
  turnSteer: "TurnSteerRequest", turnInterrupt: "TurnInterruptRequest", requestRespond: "RequestRespondRequest",
};
const replyDtoByOperation: Partial<Record<AgentOperation, DtoName>> = {
  projects: "ProjectsResponse", status: "StatusResponse", threads: "ThreadsResponse", thread: "ThreadSnapshot",
  history: "HistoryResponse", threadCreate: "ThreadCreateResponse", turnStart: "TurnMutationResponse",
  turnSteer: "TurnMutationResponse", turnInterrupt: "TurnMutationResponse", requestRespond: "RequestRespondResponse",
};
const readOps = new Set<AgentOperation>(["projects", "status", "threads", "thread", "history"]);
const statusByCode: Record<ErrorResponse["code"], number> = {
  INVALID_ARGUMENT: 400, STALE_GENERATION: 409, OPERATION_CONFLICT: 409, REQUEST_TOO_LARGE: 413,
  ITEM_TOO_LARGE: 413, CAPACITY_EXHAUSTED: 429, UPSTREAM_UNAVAILABLE: 503, TIMEOUT: 504,
  NOT_FOUND: 404, UNSUPPORTED: 501, STALE_REQUEST: 409,
};

/** Создаёт валидируемый NATS port для сценариев без реального брокера. */
export function createAgentRequester(request: AgentRequestPort) {
 return async function requestAgent<Name extends AgentOperation>(operation: Name, body: unknown): Promise<unknown> {
  const requestDto = dtoByOperation[operation];
  const mutating = !readOps.has(operation);
  const bodyBytes = serializedBytes(body);
  if (bodyBytes > limits.natsSseFrameBytes || ((operation === "turnStart" || operation === "turnSteer") && bodyBytes > limits.inputTextBytes)) {
    throw agentError(413, "REQUEST_TOO_LARGE", mutating ? "not-sent" : "query");
  }
  if (!requestDto || !validateDto(requestDto, body)) throw agentError(400, "INVALID_ARGUMENT", mutating ? "not-sent" : "query");
  const timeout = mutating ? limits.mutationAcceptanceTimeoutMs : limits.readTimeoutMs;
  try {
    const reply = await request(subjects[operation], Buffer.from(JSON.stringify(body)), timeout);
    const responseLimit = operation === "thread" || operation === "history" ? limits.snapshotBytes : limits.natsSseFrameBytes;
    if (reply.data.byteLength > responseLimit) throw agentError(503, "UPSTREAM_UNAVAILABLE", mutating ? "unknown" : "query");
    const serviceErrorCode = reply.headers?.get("Nats-Service-Error");
    const serviceErrorStatus = reply.headers?.get("Nats-Service-Error-Code");
    if (serviceErrorCode && serviceErrorStatus) {
      let errorBody: unknown;
      try { errorBody = JSON.parse(Buffer.from(reply.data).toString("utf8")); } catch { errorBody = null; }
      if (validateDto("ErrorResponse", errorBody) && serviceErrorCode === errorBody.code && /^[45][0-9]{2}$/.test(serviceErrorStatus)) throw new AgentGatewayError(statusByCode[errorBody.code], errorBody);
      throw agentError(503, "UPSTREAM_UNAVAILABLE", mutating ? "unknown" : "query");
    }
    if (serviceErrorCode || serviceErrorStatus) throw agentError(503, "UPSTREAM_UNAVAILABLE", mutating ? "unknown" : "query");
    let result: unknown;
    try { result = JSON.parse(Buffer.from(reply.data).toString("utf8")); }
    catch { throw agentError(503, "UPSTREAM_UNAVAILABLE", mutating ? "unknown" : "query"); }
    const responseDto = replyDtoByOperation[operation];
    if (!responseDto || !validateDto(responseDto, result)) throw agentError(503, "UPSTREAM_UNAVAILABLE", mutating ? "unknown" : "query");
    return result;
  } catch (error) {
    if (error instanceof AgentGatewayError) throw error;
    // AIDEV-NOTE: Любой сбой после начала request-reply оставляет побочный эффект команды неопределённым.
    const sent = error instanceof AgentTransportError ? error.sent : mutating;
    const timeoutError = error instanceof AgentTransportError ? error.timeout : error instanceof Error && /timeout/i.test(error.message);
    throw agentError(timeoutError ? 504 : 503, timeoutError ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE", mutating ? sent ? "unknown" : "not-sent" : "query");
  }
 };
}

/** Валидирует owner DTO и выполняет ровно один NATS request-reply. */
export const agentRequest = createAgentRequester(async (subject, payload, timeout) => {
  let nc;
  try { nc = await (await import("./gateway.ts")).natsConnection(); } catch { throw new AgentTransportError(false); }
  try { return await nc.request(subject, payload, { timeout }); }
  catch (error) { throw new AgentTransportError(true, error instanceof Error && /timeout/i.test(error.message)); }
});

/** Преобразует NATS timeout, транспортный отказ и owner error в безопасный DTO. */
export function agentError(status: number, code: ErrorResponse["code"], outcome: ErrorResponse["outcome"]): AgentGatewayError {
  return new AgentGatewayError(status, { code, outcome });
}

/** Сериализует только валидный ErrorResponse; auth gate остаётся у вызывающего маршрута. */
export function agentErrorResponse(error: unknown): Response {
  const known = error instanceof AgentGatewayError ? error : agentError(503, "UPSTREAM_UNAVAILABLE", "query");
  return Response.json(known.body, { status: known.status, headers: { "Cache-Control": "no-store" } });
}
