// ABOUTME: Передаёт закрытые HTTP команды agent v2 и ограниченный поток снимков.
// ABOUTME: Авторизует web сессию; не повторяет мутации и не хранит историю агента.
import { checkOrigin, requireTimerSession, type Session } from "./auth";
import { GatewayError, natsConnection } from "./gateway";
import { bytes, limits, subjects, validateCommand, validateEnvelope } from "@brai/agent/contracts";
import type { Command, ErrorResponse, EventEnvelope, NativeSnapshot } from "@brai/agent/contracts";
import { encodeFrame } from "../lib/agent/stream";
const reads = new Set(["projects", "status", "models", "threads", "open", "turns", "items"]);
const key = Symbol.for("brai.web.agent-streams.v2");
const globals = globalThis as typeof globalThis & { [key]?: Map<() => void, string> };
const streams = globals[key] ??= new Map<() => void, string>();
const watched = new WeakSet<object>();
let pending = 0;
class Failure extends Error {
  constructor(public status: number, public body: ErrorResponse) { super(body.code); }
}
const permitted = (session: Session) => (process.env.BRAI_AGENT_ALLOWED_EMAILS ?? "").split(",").map(email => email.trim().toLowerCase()).filter(Boolean).includes(session.user.email.trim().toLowerCase());
const fail = (status: number, code: string, outcome: ErrorResponse["outcome"]) => new Failure(status, { code, outcome });
/** Делает один request-reply; любой транспортный сбой после отправки мутации имеет неизвестный исход. */
async function rpc<T = unknown>(command: Command): Promise<T> {
  const mutation = !reads.has(command.action);
  const nc = await natsConnection().catch(() => { throw fail(503, "UNAVAILABLE", mutation ? "not-sent" : "query"); });
  try {
    const reply = await nc.request(subjects.rpc, Buffer.from(JSON.stringify(command)), { timeout: 10000 });
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
        buffered.clear(); sent.clear();
        try { controller.close(); } catch { /* Потребитель уже отменил поток. */ }
      };
      // AIDEV-NOTE: Один кадр HTTP и максимум16 последних снимков; diff строится от отправленной базы.
      const schedule = () => {
        if (closed || !generation || delivery || (!readyPending && !buffered.size) || (controller.desiredSize ?? 0) <= 0) return;
        delivery = setTimeout(() => {
          delivery = undefined;
          try {
            if (readyPending) { if (write("ready", { generation })) readyPending = false; }
            else {
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
        buffered.set(key, value); schedule();
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
      const timer = setInterval(async () => {
        if (closed || checking) return;
        if (generation) write("heartbeat", null);
        checking = true;
        const current = await requireTimerSession(request, true).catch(() => null);
        const status = !closed && current && permitted(current) && generation ? await rpc<{ generation: string; ready: boolean }>({ action: "status" }).catch(() => null) : null;
        checking = false;
        if (generation) {
          missedStatus = status ? 0 : missedStatus + 1;
          if ((status && (!status.ready || status.generation !== generation)) || missedStatus >= 3) close();
        }
        if (!current || !permitted(current) || current.session.id !== session.session.id || current.user.id !== session.user.id) close();
      }, 5000);
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
  let outcome: ErrorResponse["outcome"] = request.method === "POST" ? "not-sent" : "query";
  if (pending >= limits.clients) return Response.json({ code: "CAPACITY_EXHAUSTED", outcome }, { status: 429 });
  pending++;
  try {
    const { path } = await context.params, url = new URL(request.url), eventStream = path[0] === "events";
    if (request.method === "POST") checkOrigin(request);
    const session = await requireTimerSession(request, eventStream);
    if (!permitted(session)) throw fail(403, "AGENT_ACCESS_DENIED", outcome);
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
    if (command.action !== (eventStream ? "open" : path[0])) throw fail(400, "INVALID_ARGUMENT", outcome);
    if (!validateCommand(command) || (!eventStream && reads.has(command.action) !== (request.method === "GET"))) throw fail(400, "INVALID_ARGUMENT", outcome);
    if (eventStream) return await events(request, session, command);
    outcome = request.method === "POST" ? "unknown" : "query";
    return Response.json(await rpc(command), { status: request.method === "POST" ? 202 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof GatewayError) return Response.json({ code: error.code }, { status: error.status });
    const known = error instanceof Failure ? error : fail(400, "INVALID_ARGUMENT", outcome);
    return Response.json(known.body, { status: known.status, headers: { "Cache-Control": "no-store" } });
  } finally { pending--; }
}
/** Обрабатывает авторизованный GET/POST; method определяет чтение или явную мутацию. */
export { handle as agentGet, handle as agentPost };
