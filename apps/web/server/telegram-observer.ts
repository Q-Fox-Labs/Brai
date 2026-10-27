// ABOUTME: Предоставляет авторизованное чтение и SSE журнала Telegram.
// ABOUTME: Не запускает агента, не принимает мутации и не раскрывает внутренние пути.
import { requireSession } from "./auth";
import { GatewayError, natsConnection } from "./gateway";
import { subjects as artifacts, validateRequest, validateResponse } from "../../../services/artifacts/contracts/index.mjs";

const subject = "brai.hermes.telegram.observer.v1.query";
const noStore = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const maxStreams = 64;
let activeStreams = 0;
const enabled = () => process.env.BRAI_ENVIRONMENT === "dev" && process.env.BRAI_WEB_AGENT_MODE === "hermes_telegram" && process.env.BRAI_WEB_TELEGRAM_OBSERVER_ENABLED !== "0";
const natural = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new GatewayError(400, "INVALID_ARGUMENT");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new GatewayError(400, "INVALID_ARGUMENT");
  return number;
};

/** Читает фиксированный порт Hermes без передачи пользовательской identity. */
export async function observerQuery<T>(body: object): Promise<T> {
  try {
    const nc = await natsConnection();
    const reply = await nc.request(subject, Buffer.from(JSON.stringify(body)), { timeout: 2000 });
    if (reply.headers?.has("Nats-Service-Error") || reply.headers?.has("Nats-Service-Error-Code")) throw new Error("UPSTREAM");
    if (reply.data.length > 1_048_576) throw new Error("TOO_LARGE");
    return JSON.parse(Buffer.from(reply.data).toString()) as T;
  } catch { throw new GatewayError(503, "UNAVAILABLE"); }
}

function failure(error: unknown): Response {
  const value = error instanceof GatewayError ? error : new GatewayError(503, "UNAVAILABLE");
  return Response.json({ code: value.code }, { status: value.status, headers: noStore });
}

/** Обрабатывает только GET и отдаёт поток сохранённых изменений с курсором восстановления. */
export async function observerGet(request: Request): Promise<Response> {
  try {
    if (!enabled()) throw new GatewayError(404, "NOT_FOUND");
    const session = await requireSession(request);
    const url = new URL(request.url), action = url.pathname.split("/").at(-1);
    if (action === "events") {
      const after = natural(request.headers.get("last-event-id") ?? url.searchParams.get("after")) ?? 0;
      return observerEvents(request, after, session.session.id);
    }
    const limit = natural(url.searchParams.get("limit")) ?? 50;
    if (limit < 1 || limit > 100) throw new GatewayError(400, "INVALID_ARGUMENT");
    const before = natural(url.searchParams.get("before"));
    let body: object;
    if (action === "status") body = { action };
    else if (action === "chats") body = { action, limit, ...(before === undefined ? {} : { before }) };
    else if (action === "messages") {
      const chatId = url.searchParams.get("chatId"), threadId = url.searchParams.get("threadId") ?? "";
      if (!chatId || !/^-?[1-9][0-9]{0,24}$/.test(chatId) || !/^([1-9][0-9]{0,24})?$/.test(threadId)) throw new GatewayError(400, "INVALID_ARGUMENT");
      body = { action, chatId, threadId, limit, ...(before === undefined ? {} : { before }) };
    } else throw new GatewayError(404, "NOT_FOUND");
    return Response.json(await observerQuery(body), { headers: noStore });
  } catch (error) { return failure(error); }
}

function observerEvents(request: Request, after: number, sessionId: string): Response {
  if (activeStreams >= maxStreams) throw new GatewayError(503, "UNAVAILABLE");
  activeStreams++;
  const encoder = new TextEncoder();
  let cursor = after, closed = false, busy = false, ticks = 0;
  let timer: ReturnType<typeof setInterval>;
  let close: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => { if (closed) return; closed = true; activeStreams--; clearInterval(timer); request.signal.removeEventListener("abort", close); try { controller.close(); } catch { /* Клиент уже отключился. */ } };
      const poll = async () => {
        if (closed || busy) return;
        busy = true;
        try {
          if (++ticks % 15 === 0 && (await requireSession(request)).session.id !== sessionId) { close(); return; }
          const batch = await observerQuery<{ changes: { change_seq: number }[]; cursor: number }>({ action: "changes", after: cursor, limit: 100 });
          if (!Array.isArray(batch.changes) || !Number.isSafeInteger(batch.cursor) || batch.cursor < cursor) throw new Error("BAD_REPLY");
          for (const event of batch.changes) {
            if (closed || (controller.desiredSize ?? 0) <= 0) { close(); return; }
            if (!Number.isSafeInteger(event.change_seq) || event.change_seq <= cursor) throw new Error("BAD_REPLY");
            controller.enqueue(encoder.encode(`id: ${event.change_seq}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`));
            cursor = event.change_seq;
          }
          if (!batch.changes.length && !closed && (controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch { close(); }
        finally { busy = false; }
      };
      request.signal.addEventListener("abort", close, { once: true });
      timer = setInterval(() => { void poll(); }, 1000);
      if (request.signal.aborted) { close(); return; }
      void poll();
    },
    cancel() { close(); },
  }, { highWaterMark: 2 * 1_048_576, size: chunk => chunk.byteLength });
  return new Response(body, { headers: { ...noStore, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" } });
}

/** Проверяет связь файла с сообщением, владельца artifacts и действующую сессию браузера. */
export async function observerFileAuth(request: Request): Promise<Response> {
  try {
    if (!enabled()) throw new GatewayError(404, "NOT_FOUND");
    await requireSession(request);
    if (!["GET", "HEAD"].includes(request.headers.get("x-forwarded-method") ?? "")) throw new GatewayError(405, "METHOD_NOT_ALLOWED");
    const original = request.headers.get("x-forwarded-uri");
    if (!original?.startsWith("/") || original.startsWith("//") || original.includes("\\")) throw new GatewayError(400, "INVALID_ARGUMENT");
    const url = new URL(original, request.url);
    if (url.origin !== new URL(request.url).origin || url.hash) throw new GatewayError(400, "INVALID_ARGUMENT");
    const match = /^\/api\/telegram-observer\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
    const identity = url.searchParams.get("message"), download = url.searchParams.get("download");
    if (!match || !identity || identity.length > 256 || url.searchParams.getAll("message").length !== 1 ||
        url.searchParams.getAll("download").length > 1 || (download !== null && download !== "1") ||
        [...url.searchParams.keys()].some(key => key !== "message" && key !== "download")) throw new GatewayError(400, "INVALID_ARGUMENT");
    const artifactId = match[1];
    const linked = await observerQuery<{ allowed: boolean; ownerId?: unknown }>({ action: "attachment", identity, artifactId });
    if (linked.allowed !== true || typeof linked.ownerId !== "string" || !linked.ownerId || linked.ownerId.length > 128 || /\s/.test(linked.ownerId) ||
        !validateRequest(artifacts.get, { artifactId })) throw new GatewayError(404, "NOT_FOUND");
    // AIDEV-NOTE: Telegram-файлы Hermes принадлежат DEV Artifacts, а не общему хранилищу результатов Codex.
    const nc = await natsConnection(), reply = await nc.request(artifacts.get, Buffer.from(JSON.stringify({ artifactId })), { timeout: 5000 });
    if (reply.headers?.has("Nats-Service-Error")) throw new GatewayError(404, "NOT_FOUND");
    const item = JSON.parse(Buffer.from(reply.data).toString()) as { ownerId: string; status: string; filename: string; mimeType: string };
    if (!validateResponse(artifacts.get, item) || item.ownerId !== linked.ownerId || item.status !== "ready") throw new GatewayError(404, "NOT_FOUND");
    const inline = !download && ["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm", "audio/ogg", "audio/mpeg"].includes(item.mimeType);
    const encoded = encodeURIComponent(item.filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(null, { headers: { ...noStore, "Content-Type": inline ? item.mimeType : "application/octet-stream",
      "Content-Disposition": inline ? "inline" : `attachment; filename="download"; filename*=UTF-8''${encoded}`,
      "Cross-Origin-Resource-Policy": "same-origin", "X-Frame-Options": "DENY" } });
  } catch (error) { return failure(error); }
}
