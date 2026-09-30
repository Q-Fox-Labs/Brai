// ABOUTME: Раздаёт события agent через ограниченные персональные SSE очереди.
// ABOUTME: Bootstrap согласует snapshot с подпиской; потеря порядка закрывает поток.
import { validateEventEnvelope, validateDto, serializedBytes, limits } from "@brai/agent/contracts";
import type { EventEnvelope, ThreadSnapshot } from "@brai/agent/contracts";

type Client = { userId: string; sessionId: string; projectId: string; threadId: string; send: (event: EventEnvelope) => void; close: () => void };
export type AgentFrame = { type: "snapshot"; data: ThreadSnapshot } | { type: "agent"; data: EventEnvelope } | { type: "heartbeat"; data: null };

/** Ограниченный fan-out без хранения истории событий в web. */
export class AgentHub {
  private clients = new Set<Client>();

  /** Подключает подписчика до запроса снимка и возвращает локальное освобождение. */
  attach(client: Client): () => void {
    if (this.clients.size >= limits.clients) throw new Error("CLIENT_LIMIT");
    this.clients.add(client);
    return () => { this.clients.delete(client); };
  }

  /** Передаёт только событие нужного проекта и треда; некорректные кадры закрывают потоки. */
  broadcast(event: EventEnvelope): void {
    if (!validateEventEnvelope(event)) { this.disconnect(); return; }
    for (const client of [...this.clients]) if (client.projectId === event.projectId && client.threadId === event.threadId) client.send(event);
  }

  /** Закрывает все потоки определённой сессии после подтверждённого logout. */
  invalidate(sessionId: string): void { for (const client of [...this.clients]) if (client.sessionId === sessionId) client.close(); }

  /** Закрывает подписки после потери Core NATS события. */
  disconnect(): void { for (const client of [...this.clients]) client.close(); }
}

/** Создаёт поток snapshot/agent/heartbeat и не связывает его отмену с ходом agent. */
export function agentEventStream(hub: AgentHub, snapshot: () => Promise<ThreadSnapshot>, signal: AbortSignal,
  identity: Omit<Client, "send" | "close">, authorized: () => Promise<boolean>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let stop = () => {};
  let pump = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false, bootstrapping = true, pumping = false;
      let watermark: ThreadSnapshot | undefined;
      const pending: EventEnvelope[] = [];
      const queue: Uint8Array[] = [];
      let queuedBytes = 0;
      const lifecycle: { heartbeat?: ReturnType<typeof setInterval> } = {};
      let detach = () => {};
      const enqueue = (frame: AgentFrame) => {
        if (closed) return;
        const watermarkId = frame.type === "snapshot" ? `${frame.data.generation}:${frame.data.streamEpoch}:${frame.data.seq}` : frame.type === "agent" ? `${frame.data.generation}:${frame.data.streamEpoch}:${frame.data.seq}` : undefined;
        const encoded = encoder.encode(`${watermarkId ? `id: ${watermarkId}\n` : ""}event: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`);
        if (serializedBytes(frame.data) > limits.natsSseFrameBytes || encoded.byteLength > limits.natsSseFrameBytes || queue.length >= limits.queuePerClient || queuedBytes + encoded.byteLength > limits.natsSseFrameBytes) { stop(); return; }
        queue.push(encoded); queuedBytes += encoded.byteLength; pump();
      };
      stop = () => {
        if (closed) return;
        closed = true; detach(); clearInterval(lifecycle.heartbeat); signal.removeEventListener("abort", stop);
        try { controller.close(); } catch { /* Читатель уже отменил поток. */ }
      };
      pump = () => {
        if (pumping || closed) return;
        pumping = true;
        void (async () => {
          try {
            while (!closed && queue.length && (controller.desiredSize ?? 0) > 0) {
              if (!await authorized()) { stop(); return; }
              if (closed) return;
              const bytes = queue.shift()!; queuedBytes -= bytes.byteLength;
              controller.enqueue(bytes);
            }
          } catch { stop(); }
          finally { pumping = false; if (!closed && queue.length && (controller.desiredSize ?? 0) > 0) pump(); }
        })();
      };
      const accept = (event: EventEnvelope) => {
        if (closed || event.projectId !== identity.projectId || event.threadId !== identity.threadId) return;
        if (event.event.type === "CUSTOM" && event.event.name === "brai.agent.resync-required") { stop(); return; }
        if (bootstrapping) {
          if (pending.length >= limits.queuePerClient) { stop(); return; }
          pending.push(event); return;
        }
        if (!watermark || event.generation !== watermark.generation || event.streamEpoch !== watermark.streamEpoch) { stop(); return; }
        if (event.seq <= watermark.seq) return;
        if (event.seq !== watermark.seq + 1) { stop(); return; }
        watermark = { ...watermark, seq: event.seq };
        enqueue({ type: "agent", data: event });
      };
      try { detach = hub.attach({ ...identity, send: accept, close: stop }); }
      catch { stop(); return; }
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) { stop(); return; }
      void (async () => {
        try {
          const data = await snapshot();
          if (closed) return;
          if (!validateDto("ThreadSnapshot", data)) { stop(); return; }
          watermark = data;
          enqueue({ type: "snapshot", data });
          bootstrapping = false;
          // AIDEV-NOTE: Снимок авторитетен для собранного bootstrap буфера; live события после него уже требуют непрерывной seq.
          for (const event of pending.splice(0)) {
            if (event.generation !== data.generation || event.streamEpoch !== data.streamEpoch || event.seq <= data.seq) continue;
            accept(event);
          }
        } catch { stop(); }
      })();
      lifecycle.heartbeat = setInterval(() => {
        if (closed || bootstrapping) return;
        void authorized().then(ok => { if (!ok) stop(); else enqueue({ type: "heartbeat", data: null }); }).catch(stop);
      }, 2000);
    },
    pull() { pump(); },
    cancel() { stop(); },
  }, { highWaterMark: 1 });
}
