// ABOUTME: Передаёт закрытые HTTP команды agent v3 и ограниченный поток снимков.
// ABOUTME: Авторизует web сессию; не повторяет мутации и не хранит историю агента.
import { checkOrigin, requireTimerSession, type Session } from "./auth";
import { GatewayError, natsConnection } from "./gateway";
import { bytes, limits, rpcTimeouts, subjects, validateCommand, validateEnvelope, validateLimits } from "@brai/agent/contracts";
import type { AgentLimits, Command, ErrorResponse, EventEnvelope, NativeSnapshot } from "@brai/agent/contracts";
import { encodeFrame } from "../lib/agent/stream";
import { disabledAgentResponse } from "./web-config";
const reads = new Set(["projects", "status", "models", "threads", "open", "turns", "items", "activities", "item", "goalGet", "readState"]);
const key = Symbol.for("brai.web.agent-streams.v3");
const globals = globalThis as typeof globalThis & { [key]?: Map<() => void, string> };
const streams = globals[key] ??= new Map<() => void, string>();
const watched = new WeakSet<object>();
let pending = 0;
class Failure extends Error {
  constructor(public status: number, public body: ErrorResponse) { super(body.code); }
}
export const permittedAgent = (session: Session) => (process.env.BRAI_AGENT_ALLOWED_EMAILS ?? "").split(",").map(email => email.trim().toLowerCase()).filter(Boolean).includes(session.user.email.trim().toLowerCase());
const fail = (status: number, code: string, outcome: ErrorResponse["outcome"]) => new Failure(status, { code, outcome });
/** Берёт owner только из проверенной сессии и доверенной пары; неполная настройка закрывает доступ. */
export function agentOwnerId(session: Session): string {
  const email = process.env.BRAI_AGENT_OWNER_EMAIL?.trim().toLowerCase(), ownerId = process.env.BRAI_AGENT_OWNER_ID?.trim();
  if (!email && !ownerId) return session.user.id;
  if (!email || !ownerId || ownerId.length > 128 || !/\S/.test(ownerId)) throw new GatewayError(503, "AGENT_OWNER_NOT_CONFIGURED");
  if (session.user.email.trim().toLowerCase() !== email) throw new GatewayError(403, "AGENT_ACCESS_DENIED");
  if (session.user.emailVerified !== true) throw new GatewayError(403, "AGENT_OWNER_EMAIL_UNVERIFIED");
  return ownerId;
}

/** Переводит URL вложений и результатов в browser identity; непроверенные URL результатов удаляет. */
export function agentBrowserResult<T>(value: T, ownerId: string, userId: string): T {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => agentBrowserResult(item, ownerId, userId)) as T;
  const copy = { ...value } as Record<string, unknown>;
  for (const [key, item] of Object.entries(copy)) {
    if (key === "attachments" && Array.isArray(item)) copy[key] = item.map(attachment => {
      if (!attachment || typeof attachment !== "object" || typeof attachment.url !== "string" || !attachment.url.startsWith("/api/agent/attachments/")) return attachment;
      const url = new URL(attachment.url, "https://agent.invalid");
      if (url.origin !== "https://agent.invalid" || url.searchParams.getAll("expectedUserId").length !== 1 || url.searchParams.get("expectedUserId") !== ownerId) return attachment;
      url.searchParams.set("expectedUserId", userId);
      return { ...attachment, url: url.pathname + url.search + url.hash };
    });
    else if (key === "results" && Array.isArray(item)) copy[key] = item.map(result => {
      if (!result || typeof result !== "object") return result;
      const browser = { ...result };
      for (const key of ["previewUrl", "downloadUrl"]) {
        const raw = browser[key];
        if (typeof raw !== "string") continue;
        let valid = false;
        try {
          const url = new URL(raw, "https://agent.invalid");
          const required = ["projectId", "threadId", "turnId", "itemId", "expectedUserId"];
          const allowed = new Set([...required, ...(key === "downloadUrl" ? ["download"] : [])]);
          valid = raw.startsWith("/api/agent/results/") && !raw.includes("\\") && !url.hash
            && url.origin === "https://agent.invalid" && url.pathname === `/api/agent/results/${result.artifactId}`
            && required.every(name => url.searchParams.getAll(name).length === 1 && !!url.searchParams.get(name))
            && [...url.searchParams.keys()].every(name => allowed.has(name))
            && url.searchParams.get("expectedUserId") === ownerId
            && (key !== "downloadUrl" || (url.searchParams.getAll("download").length === 1 && url.searchParams.get("download") === "1"));
          if (valid) { url.searchParams.set("expectedUserId", userId); browser[key] = url.pathname + url.search; }
        } catch { /* Ошибочный wire URL не становится ссылкой браузера. */ }
        if (!valid) delete browser[key];
      }
      return browser;
    });
    else if (item && typeof item === "object") copy[key] = agentBrowserResult(item, ownerId, userId);
  }
  return copy as T;
}
/** Делает один request-reply; любой транспортный сбой после отправки мутации имеет неизвестный исход. */
export async function rpc<T = unknown>(command: Command): Promise<T> {
  const mutation = !reads.has(command.action);
  const nc = await natsConnection().catch(() => { throw fail(503, "UNAVAILABLE", mutation ? "not-sent" : "query"); });
  try {
    const reply = await nc.request(subjects.rpc, Buffer.from(JSON.stringify(command)), { timeout: mutation ? rpcTimeouts.mutation : rpcTimeouts.read });
    if (reply.data.byteLength > limits.frame) throw new Error("FRAME_LIMIT");
    const value = JSON.parse(Buffer.from(reply.data).toString("utf8"));
    const code = reply.headers?.get("Nats-Service-Error"), status = reply.headers?.get("Nats-Service-Error-Code");
    if (code || status) {
      if (!code || !status || !/^[45][0-9]{2}$/.test(status) || value?.code !== code || !["query", "not-sent", "unknown"].includes(value?.outcome)) throw new Error("BAD_ERROR");
      throw new Failure(Number(status), value);
    }
    return value;
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw fail(503, "OUTCOME_UNKNOWN", mutation ? "unknown" : "query");
  }
}
/** Закрывает потоки подтверждённо завершённой сессии без подключения к NATS. */
export function invalidateAgentSession(sessionId: string): void {
  for (const [close, id] of streams) if (id === sessionId) close();
}
async function events(request: Request, session: Session, command?: Command): Promise<Response> {
  const ownerId = agentOwnerId(session);
  const nc = await natsConnection();
  if (streams.size >= limits.clients) throw fail(429, "CAPACITY_EXHAUSTED", "query");
  if (!watched.has(nc)) {
    watched.add(nc);
    void (async () => {
      for await (const status of nc.status()) if (["disconnect", "reconnect", "error"].includes(status.type)) for (const close of streams.keys()) close();
      for (const close of streams.keys()) close();
    })();
  }
  let cleanup = () => {}, pump = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false, generation = "", readyPending = false, checking = false, missedStatus = 0;
      let allowed = new Set<string>(), delivery: ReturnType<typeof setTimeout> | undefined;
      const buffered = new Map<string, EventEnvelope>(), sent = new Map<string, NativeSnapshot>();
      let bufferedLimits: { generation: string; limits: AgentLimits } | undefined;
      let lastLimits: AgentLimits | undefined;
      const unavailableLimits = (): AgentLimits => ({ state: "unavailable", revision: lastLimits?.revision ?? 0, observedAt: null, windows: [] });
      const publishLimits = (value: AgentLimits) => {
        if (closed || !generation || (lastLimits && lastLimits.revision === value.revision && lastLimits.state === value.state)) return;
        lastLimits = value;
        bufferedLimits = { generation, limits: value };
        schedule();
      };
      const encoder = new TextEncoder();
      const write = (type: string, value: unknown) => {
        if (closed || (controller.desiredSize ?? 0) <= 0) return false;
        const frame = encoder.encode(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
        if (frame.byteLength > limits.frame) throw new Error("FRAME_LIMIT");
        controller.enqueue(frame);
        return true;
      };
      const close = (notify = true) => {
        if (closed) return;
        if (notify) write("resync", {});
        closed = true;
        subscription.unsubscribe(); clearInterval(timer); clearTimeout(delivery);
        request.signal.removeEventListener("abort", abort); streams.delete(close);
        buffered.clear(); bufferedLimits = undefined; sent.clear();
        try { controller.close(); } catch { /* Потребитель уже отменил поток. */ }
      };
      // AIDEV-NOTE: Один кадр HTTP и максимум16 последних снимков; diff строится от отправленной базы.
      const schedule = () => {
        if (closed || !generation || delivery || (!readyPending && !bufferedLimits && !buffered.size) || (controller.desiredSize ?? 0) <= 0) return;
        delivery = setTimeout(() => {
          delivery = undefined;
          try {
            if (readyPending) { if (write("ready", { generation })) readyPending = false; }
            else if (bufferedLimits) {
              const value = bufferedLimits;
              if (value.generation === generation && write("limits", value)) bufferedLimits = undefined;
              else if (value.generation !== generation) bufferedLimits = undefined;
            } else {
              const entry = buffered.entries().next().value;
              if (entry) {
                const [key, value] = entry;
                if (write("agent", command ? value : encodeFrame(value, sent.get(key)))) {
                  buffered.delete(key); sent.delete(key); sent.set(key, value.event.snapshot);
                  if (sent.size > limits.threads) sent.delete(sent.keys().next().value!);
                }
              }
            }
            schedule();
          } catch { close(); }
        }, 50);
      };
      pump = schedule;
      const accept = (value: EventEnvelope) => {
        if (command && (value.projectId !== command.projectId || value.threadId !== command.threadId)) return;
        if (generation && !allowed.has(value.projectId)) return;
        if (generation && value.generation !== generation) return close();
        const key = `${value.projectId}:${value.threadId}`, previous = buffered.get(key)?.event.snapshot ?? sent.get(key);
        if (previous && previous.generation === value.generation && previous.epoch === value.epoch && value.seq <= previous.seq) return;
        if (command && previous && previous.epoch !== value.epoch) return close();
        if (!buffered.has(key) && buffered.size >= limits.threads) return close();
        buffered.set(key, agentBrowserResult(value, ownerId, session.user.id)); schedule();
      };
      const subscription = nc.subscribe(subjects.event, { callback(error, message) {
        if (closed) return;
        try {
          if (error || message.data.byteLength > limits.frame) throw new Error("BAD_FRAME");
          const value = JSON.parse(Buffer.from(message.data).toString("utf8"));
          if (!validateEnvelope(value) || bytes(value.event.snapshot) > limits.state) throw new Error("BAD_EVENT");
          accept(value);
        } catch { close(); }
      } });
      let checkStatus: (heartbeat?: boolean) => Promise<void> = async () => {};
      const timer = setInterval(() => checkStatus(), 5000);
      checkStatus = async (heartbeat = true) => {
        if (closed || checking) return;
        if (heartbeat && generation) write("heartbeat", null);
        checking = true;
        const checkedGeneration = generation;
        const current = await requireTimerSession(request, true).catch(() => null);
        const authorized = current && permittedAgent(current) && (() => { try { return agentOwnerId(current) === ownerId; } catch { return false; } })();
        const status = !closed && authorized && checkedGeneration ? await rpc<{ generation: string; ready: boolean; limits?: unknown }>({ action: "status" }).catch(() => null) : null;
        checking = false;
        if (closed || generation !== checkedGeneration) return;
        if (generation) {
          missedStatus = status ? 0 : missedStatus + 1;
          if ((status && (!status.ready || status.generation !== generation)) || missedStatus >= 3) close();
        }
        if (!current || !authorized || current.session.id !== session.session.id || current.user.id !== session.user.id) close();
        if (!command && status && status.generation === checkedGeneration && status.ready) {
          const next = validateLimits(status.limits) ? status.limits : unavailableLimits();
          publishLimits(next);
        } else if (!command) publishLimits(lastLimits?.windows.length ? { ...lastLimits, state: "stale" } : unavailableLimits());
      };
      const abort = () => close(false);
      cleanup = abort; streams.set(close, session.session.id);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) abort();
      void (async () => {
        if (command) {
          const snapshot = await rpc<NativeSnapshot>(command);
          if (closed) return;
          const value = { projectId: command.projectId!, threadId: command.threadId!, generation: snapshot.generation, epoch: snapshot.epoch, seq: snapshot.seq, event: { type: "STATE_SNAPSHOT" as const, snapshot } };
          if (!validateEnvelope(value)) return close();
          generation = snapshot.generation; allowed = new Set([command.projectId!]); accept(value);
        } else {
          const projects = await rpc<{ generation: string; projects: { projectId: string; available: boolean }[] }>({ action: "projects" });
          if (closed) return;
          if (typeof projects.generation !== "string" || !projects.generation || !Array.isArray(projects.projects)) return close();
          generation = projects.generation; allowed = new Set(projects.projects.filter(p => p.available).map(p => p.projectId));
          for (const [key, value] of buffered) { if (!allowed.has(value.projectId)) buffered.delete(key); else if (value.generation !== generation) return close(); }
          readyPending = true;
          void checkStatus(false);
        }
        schedule();
      })().catch(() => close());
    },
    pull() { pump(); }, cancel() { cleanup(); },
  }, { highWaterMark: 1 });
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
/** Проверяет аккаунт, Origin и закрытый action до передачи единственной команды владельцу. */
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const disabled = disabledAgentResponse();
  if (disabled) return disabled;
  let outcome: ErrorResponse["outcome"] = request.method === "POST" ? "not-sent" : "query";
  if (pending >= limits.clients) return Response.json({ code: "CAPACITY_EXHAUSTED", outcome }, { status: 429 });
  pending++;
  try {
    const { path } = await context.params, url = new URL(request.url), eventStream = path[0] === "events";
    if (request.method === "POST") checkOrigin(request);
    const session = await requireTimerSession(request, eventStream);
    if (!permittedAgent(session)) throw fail(403, "AGENT_ACCESS_DENIED", outcome);
    const ownerId = agentOwnerId(session);
    if (path.length !== 1 || (eventStream && request.method !== "GET")) throw fail(404, "NOT_FOUND", outcome);
    if (url.searchParams.getAll("expectedUserId").length > 1 || (!eventStream && url.searchParams.has("expectedUserId"))) throw fail(400, "INVALID_ARGUMENT", outcome);
    const query = [...url.searchParams].filter(([key]) => key !== "expectedUserId");
    if (new Set(query.map(([key]) => key)).size !== query.length) throw fail(400, "INVALID_ARGUMENT", outcome);
    if (request.method === "POST" && (query.length || Number(request.headers.get("content-length")) > limits.input)) throw fail(400, "INVALID_ARGUMENT", outcome);
    let value = "", size = 0;
    const reader = request.method === "POST" ? request.body?.getReader() : undefined, decoder = new TextDecoder("utf8", { fatal: true });
    if (reader) for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limits.input) { await reader.cancel(); throw fail(413, "REQUEST_TOO_LARGE", outcome); }
      value += decoder.decode(part.value, { stream: true });
    }
    value += decoder.decode();
    if (eventStream && !query.length) return await events(request, session);
    const command = { action: eventStream ? "open" : path[0], ...(value ? JSON.parse(value) : Object.fromEntries(query)) };
    if (Object.hasOwn(command, "ownerId")) throw fail(400, "INVALID_ARGUMENT", outcome);
    if (typeof command.threadId === "string" || command.action === "readState") command.ownerId = ownerId;
    if (typeof command.itemIds === "string") command.itemIds = JSON.parse(command.itemIds);
    if (command.action !== (eventStream ? "open" : path[0])) throw fail(400, "INVALID_ARGUMENT", outcome);
    if (!validateCommand(command) || (!eventStream && reads.has(command.action) !== (request.method === "GET"))) throw fail(400, "INVALID_ARGUMENT", outcome);
    if (eventStream) return await events(request, session, command);
    outcome = request.method === "POST" ? "unknown" : "query";
    return Response.json(agentBrowserResult(await rpc(command), ownerId, session.user.id), { status: request.method === "POST" ? 202 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof GatewayError) return Response.json({ code: error.code }, { status: error.status });
    const known = error instanceof Failure ? error : fail(400, "INVALID_ARGUMENT", outcome);
    return Response.json(known.body, { status: known.status, headers: { "Cache-Control": "no-store" } });
  } finally { pending--; }
}
/** Обрабатывает авторизованный GET/POST; method определяет чтение или явную мутацию. */
export { handle as agentGet, handle as agentPost };
