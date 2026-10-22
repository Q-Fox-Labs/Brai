// ABOUTME: Авторизует браузерные вложения и закрытую выдачу результатов агента.
// ABOUTME: Контроль идёт через NATS, а байты передаются только между браузером и artifacts/Caddy.
import { validateRequest, validateResponse, subjects as artifactSubjects } from "../../../services/artifacts/contracts/index.mjs";
import type { Artifact, ArtifactReference, OutputListResponse } from "../../../services/artifacts/contracts/index.mjs";
type Metadata = Pick<Artifact, "title" | "filename" | "extension" | "mimeType" | "source" | "details">;
import { checkOrigin, requireSession, type Session } from "./auth";
import { GatewayError } from "./gateway";
import { agentArtifactsConnection, agentResultsConnection } from "./agent-artifacts";
import { agentOwnerId, permittedAgent, rpc as agentRpc } from "./agent-http";
import { readBoundedJson, RequestBodyFailure } from "./request-body";
import { disabledAgentResponse } from "./web-config";

class ArtifactFailure extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const failure = (status: number, code: string): ArtifactFailure => new ArtifactFailure(status, code);
const noStore = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** Возвращает только общие ошибки; owner и native метаданные не попадают в HTTP-ответы. */
function errorResponse(error: unknown): Response {
  if (error instanceof GatewayError) return Response.json({ code: error.code }, { status: error.status, headers: noStore });
  const known = error instanceof ArtifactFailure ? error : failure(503, "UNAVAILABLE");
  return Response.json({ code: known.code }, { status: known.status, headers: noStore });
}

/** Требует совпадения UI аккаунта, действующей сессии и списка разрешённых email. */
async function requireAgentSession(request: Request): Promise<Session> {
  const session = await requireSession(request);
  if (request.headers.get("x-brai-user") !== session.user.id) throw failure(401, "ACCOUNT_CHANGED");
  if (!permittedAgent(session)) throw failure(403, "AGENT_ACCESS_DENIED");
  return session;
}

/** Проверяет, что проект всё ещё доступен этому экземпляру Agent. */
async function requireProject(projectId: string): Promise<void> {
  const result = await agentRpc<{ projects: { projectId: string; available: boolean }[] }>({ action: "projects" });
  if (!Array.isArray(result.projects) || !result.projects.some(project => project.projectId === projectId && project.available)) throw failure(404, "NOT_FOUND");
}

/** Выполняет один проверенный NATS Services вызов владельца artifacts. */
async function artifactCall<T>(subject: string, request: unknown, output = false): Promise<T> {
  if (!validateRequest(subject, request)) throw failure(400, "INVALID_ARGUMENT");
  let reply;
  try {
    const nc = await (output ? agentResultsConnection() : agentArtifactsConnection());
    reply = await nc.request(subject, Buffer.from(JSON.stringify(request)), { timeout: 10000 });
  } catch { throw failure(503, "UNAVAILABLE"); }
  const code = reply.headers?.get("Nats-Service-Error-Code");
  const name = reply.headers?.get("Nats-Service-Error");
  if (code || name) {
    if (!code || !name || !/^[45][0-9]{2}$/.test(code)) throw failure(502, "BAD_REPLY");
    const status = Number(code);
    throw failure(status >= 500 ? 503 : status, name);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.from(reply.data).toString("utf8")); } catch { throw failure(502, "BAD_REPLY"); }
  if (!validateResponse(subject, value)) throw failure(502, "BAD_REPLY");
  return value as T;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure(400, "INVALID_ARGUMENT");
  return value as Record<string, unknown>;
}

function opaque(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && /\S/.test(value);
}

function extension(mimeType: string): string {
  return mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : "webp";
}

function uploadUrl(value: string): string {
  const baseText = process.env.AGENT_ARTIFACTS_UPLOAD_BASE_URL ?? process.env.ARTIFACTS_UPLOAD_BASE_URL;
  if (!baseText) throw failure(503, "UPLOAD_NOT_CONFIGURED");
  try {
    const base = new URL(baseText), url = new URL(value);
    if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash
      || url.origin !== base.origin || url.username || url.password || url.search || url.hash
      || !/^\/upload\/[A-Za-z0-9_-]{16,512}$/.test(url.pathname)) throw new Error("BAD_UPLOAD_URL");
    // AIDEV-NOTE: Request.url за standalone proxy может иметь внутренний origin; относительный путь разрешает browser через свой Caddy.
    return `/api/agent/uploads/${url.pathname.slice("/upload/".length)}`;
  } catch { throw failure(502, "BAD_UPLOAD_URL"); }
}

type Prepared = { artifact: Artifact; uploadUrl: string };
type PrepareInput = { projectId: string; threadId: string; requestId: string; kind: "original" | "copy"; filename: string; mimeType: string };

function parsePrepare(value: unknown): PrepareInput {
  const input = bodyRecord(value), keys = Object.keys(input).sort().join(",");
  if (keys !== "filename,kind,mimeType,projectId,requestId,threadId" || !opaque(input.projectId) || !opaque(input.threadId) || !opaque(input.requestId)
    || (input.kind !== "original" && input.kind !== "copy") || typeof input.filename !== "string" || !input.filename.trim() || input.filename.length > 1024
    || typeof input.mimeType !== "string" || !imageTypes.has(input.mimeType)) throw failure(400, "INVALID_ARGUMENT");
  return input as PrepareInput;
}

function metadataFor(input: PrepareInput): Metadata {
  const filename = input.filename.trim();
  return { title: filename, filename, extension: extension(input.mimeType), mimeType: input.mimeType, source: "agent", details: { projectId: input.projectId, threadId: input.threadId } };
}

function preparedMatches(artifact: Artifact, ownerId: string, input: PrepareInput): boolean {
  const details = artifact.details;
  return artifact.ownerId === ownerId && artifact.kind === input.kind && artifact.source === "agent"
    && details?.projectId === input.projectId && details?.threadId === input.threadId
    && artifact.filename === input.filename.trim() && artifact.mimeType === input.mimeType;
}

/** Создаёт/восстанавливает подготовку с неизменным requestId и доверенной областью из сессии. */
export async function prepareAttachment(request: Request): Promise<Response> {
  try {
    const disabled = disabledAgentResponse();
    if (disabled) return disabled;
    if (request.method !== "POST") throw failure(405, "METHOD_NOT_ALLOWED");
    checkOrigin(request);
    const session = await requireAgentSession(request), ownerId = agentOwnerId(session), input = parsePrepare(await readSmallJson(request));
    await requireProject(input.projectId);
    if (request.signal.aborted) throw failure(408, "REQUEST_TIMEOUT");
    const value = await artifactCall<Prepared>(artifactSubjects.prepare, {
      requestId: input.requestId, ownerId, kind: input.kind, metadata: metadataFor(input),
    });
    if (!preparedMatches(value.artifact, ownerId, input)) throw failure(409, "PREPARE_CONFLICT");
    return Response.json({ artifact: { artifactId: value.artifact.artifactId, status: value.artifact.status }, uploadUrl: uploadUrl(value.uploadUrl) }, { headers: noStore });
  } catch (error) { return errorResponse(error); }
}

type Pair = import("../../../services/artifacts/contracts/index.mjs").ReferenceAttachment;
function parsePair(value: unknown): { projectId: string; threadId: string; requestId: string; pair: Pair } {
  const input = bodyRecord(value);
  if (Object.keys(input).sort().join(",") !== "modelArtifactId,originalArtifactId,projectId,requestId,threadId"
    || !opaque(input.projectId) || !opaque(input.threadId) || !opaque(input.requestId)) throw failure(400, "INVALID_ARGUMENT");
  if (typeof input.originalArtifactId !== "string" || typeof input.modelArtifactId !== "string") throw failure(400, "INVALID_ARGUMENT");
  const pair: Pair = { originalArtifactId: input.originalArtifactId, modelArtifactId: input.modelArtifactId };
  if (!validateRequest(artifactSubjects.get, { artifactId: pair.originalArtifactId }) || !validateRequest(artifactSubjects.get, { artifactId: pair.modelArtifactId })) throw failure(400, "INVALID_ARGUMENT");
  return { projectId: input.projectId, threadId: input.threadId, requestId: input.requestId, pair };
}

async function preparedArtifact(artifactId: string, kind: "original" | "copy", ownerId: string, projectId: string, threadId: string): Promise<Artifact> {
  const artifact = await artifactCall<Artifact>(artifactSubjects.get, { artifactId });
  if (artifact.ownerId !== ownerId || artifact.kind !== kind || artifact.source !== "agent" || artifact.details?.projectId !== projectId || artifact.details?.threadId !== threadId) throw failure(404, "NOT_FOUND");
  if (artifact.status !== "ready") throw failure(409, artifact.status === "deleted" || artifact.status === "deleting" ? "ATTACHMENT_DELETED" : "ATTACHMENT_NOT_READY");
  return artifact;
}

/** Сверяет готовые объекты и создаёт идемпотентное отношение копия→оригинал. */
export async function finalizeAttachment(request: Request): Promise<Response> {
  try {
    const disabled = disabledAgentResponse();
    if (disabled) return disabled;
    if (request.method !== "POST") throw failure(405, "METHOD_NOT_ALLOWED");
    checkOrigin(request);
    const session = await requireAgentSession(request), ownerId = agentOwnerId(session), input = parsePair(await readSmallJson(request));
    await requireProject(input.projectId);
    const original = await preparedArtifact(input.pair.originalArtifactId, "original", ownerId, input.projectId, input.threadId);
    const model = input.pair.modelArtifactId === input.pair.originalArtifactId
      ? original
      : await preparedArtifact(input.pair.modelArtifactId, "copy", ownerId, input.projectId, input.threadId);
    if (!imageTypes.has(model.mimeType)) throw failure(415, "UNSUPPORTED_MEDIA_TYPE");
    if (model.artifactId !== original.artifactId) {
      await artifactCall(artifactSubjects.relationAdd, {
        requestId: input.requestId, modelArtifactId: model.artifactId, originalArtifactId: original.artifactId,
      });
    }
    return Response.json({ pair: input.pair, status: "ready" }, { headers: noStore });
  } catch (error) { return errorResponse(error); }
}

function parseOriginalUri(value: string | null, base: string): URL {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("#")) throw failure(400, "INVALID_ARGUMENT");
  const url = new URL(value, base);
  if (url.origin !== new URL(base).origin) throw failure(400, "INVALID_ARGUMENT");
  return url;
}

function exactQuery(url: URL, output = false): Map<string, string> {
  const allowed = new Set(["projectId", "threadId", "expectedUserId", "itemId", "turnId", ...(output ? ["download"] : [])]), values = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || values.has(key) || !opaque(value)) throw failure(400, "INVALID_ARGUMENT");
    values.set(key, value);
  }
  if (!["projectId", "threadId", "expectedUserId"].every(key => values.has(key))) throw failure(400, "INVALID_ARGUMENT");
  if (values.has("itemId") !== values.has("turnId")) throw failure(400, "INVALID_ARGUMENT");
  if (output && (!values.has("itemId") || !values.has("turnId") || (values.has("download") && values.get("download") !== "1"))) throw failure(400, "INVALID_ARGUMENT");
  return values;
}

async function confirmedReference(ownerId: string, projectId: string, threadId: string, itemId: string, turnId: string, artifactId: string): Promise<boolean> {
  const result = await artifactCall<{ items: ArtifactReference[] }>(artifactSubjects.referenceList, {
    scope: { ownerId, projectId, threadId }, nativeItemIds: [itemId],
  });
  return result.items.some(reference => reference.state === "confirmed" && reference.scope?.ownerId === ownerId
    && reference.scope?.projectId === projectId && reference.scope?.threadId === threadId
    && reference.itemId === itemId && reference.turnId === turnId
    && reference.attachments?.some((pair: Pair) => pair.originalArtifactId === artifactId || pair.modelArtifactId === artifactId));
}

function authHeaders(artifact: Artifact, output = false, download = false): Headers {
  const headers = new Headers({
    ...noStore,
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Frame-Options": "DENY",
  });
  const inlineTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"]);
  if (!download && (output ? inlineTypes : imageTypes).has(artifact.mimeType)) {
    headers.set("Content-Type", artifact.mimeType);
    headers.set("Content-Disposition", "inline");
  } else {
    headers.set("Content-Type", "application/octet-stream");
    const encoded = encodeURIComponent(artifact.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    headers.set("Content-Disposition", output ? `attachment; filename="download"; filename*=UTF-8''${encoded}` : "attachment; filename=\"attachment\"");
  }
  return headers;
}

/** Проверяет Caddy forward-auth запрос; успешный ответ содержит только безопасные file headers. */
export async function artifactReadAuth(request: Request): Promise<Response> {
  try {
    const disabled = disabledAgentResponse();
    if (disabled) return disabled;
    const method = request.headers.get("x-forwarded-method");
    if (request.method !== "GET" && request.method !== "HEAD") throw failure(405, "METHOD_NOT_ALLOWED");
    if (method !== "GET" && method !== "HEAD") throw failure(405, "METHOD_NOT_ALLOWED");
    const session = await requireSession(request);
    if (!permittedAgent(session)) throw failure(403, "AGENT_ACCESS_DENIED");
    const url = parseOriginalUri(request.headers.get("x-forwarded-uri"), request.url);
    const output = url.pathname.startsWith("/api/agent/results/");
    const prefix = output ? "/api/agent/results/" : "/api/agent/attachments/";
    if (!url.pathname.startsWith(prefix) || url.pathname.slice(prefix.length).includes("/")) throw failure(404, "NOT_FOUND");
    const artifactId = url.pathname.slice(prefix.length);
    if (!validateRequest(artifactSubjects.get, { artifactId })) throw failure(404, "NOT_FOUND");
    const query = exactQuery(url, output), projectId = query.get("projectId")!, threadId = query.get("threadId")!;
    if (query.get("expectedUserId") !== session.user.id) throw failure(401, "ACCOUNT_CHANGED");
    const ownerId = agentOwnerId(session);
    await requireProject(projectId);
    const itemId = query.get("itemId"), turnId = query.get("turnId");
    let artifact: Artifact;
    if (output && itemId && turnId) {
      const result = await artifactCall<OutputListResponse>(artifactSubjects.outputList, { ownerId, projectId, threadId, itemIds: [itemId] }, true);
      if (!result.bindings.some(binding => binding.ownerId === ownerId && binding.projectId === projectId && binding.threadId === threadId
        && binding.itemId === itemId && binding.turnId === turnId && binding.artifactIds.includes(artifactId))) throw failure(404, "NOT_FOUND");
      artifact = await artifactCall<Artifact>(artifactSubjects.get, { artifactId }, true);
      if (artifact.ownerId !== ownerId || artifact.status !== "ready") throw failure(404, "NOT_FOUND");
    } else if (itemId && turnId) {
      if (!await confirmedReference(ownerId, projectId, threadId, itemId, turnId, artifactId)) throw failure(404, "NOT_FOUND");
      artifact = await artifactCall<Artifact>(artifactSubjects.get, { artifactId });
      if (artifact.ownerId !== ownerId || artifact.status !== "ready") throw failure(404, "NOT_FOUND");
    } else {
      artifact = await artifactCall<Artifact>(artifactSubjects.get, { artifactId });
      if (artifact.ownerId !== ownerId || artifact.status !== "ready" || artifact.source !== "agent"
        || artifact.details?.projectId !== projectId || artifact.details?.threadId !== threadId) throw failure(404, "NOT_FOUND");
    }
    return new Response(null, { status: 200, headers: authHeaders(artifact, output, query.get("download") === "1") });
  } catch (error) { return errorResponse(error); }
}

/** Ограничивает ошибочный или огромный JSON размер без чтения потока файла. */
export async function readSmallJson(request: Request): Promise<unknown> {
  try { return await readBoundedJson(request, 16 * 1024, 5000); }
  catch (error) {
    if (error instanceof RequestBodyFailure) throw failure(error.status, error.code);
    throw failure(400, "INVALID_ARGUMENT");
  }
}
