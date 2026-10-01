// ABOUTME: Передаёт явные HTTP команды и применяет пассивный STATE_SNAPSHOT через AG-UI SDK.
// ABOUTME: EventSource восстанавливает только чтение; клиент не начинает и не повторяет ход.
import { AbstractAgent, defaultApplyEvents } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import { EventSchema } from "@ag-ui/core/schemas";
import { Subject, type Observable } from "rxjs";
import { bytes, limits, validateCommand, validateEnvelope } from "@brai/agent/contracts";
import type { Command, NativeSnapshot, DisplayItem, ThreadMetadata } from "@brai/agent/contracts";
type Page<T> = { generation: string; data: T[]; nextCursor: string | null };
type MutationReply = { generation: string; operationId: string; threadId: string; turnId?: string; requestId?: string; outcome: "accepted" };
type Replies = Record<"create" | "start" | "steer" | "interrupt" | "answer", MutationReply> & {
  projects: { generation: string; projects: { projectId: string; name: string; available: boolean }[] };
  status: { generation: string; ready: boolean; connection: string; authorization: string };
  threads: Page<ThreadMetadata>;
  turns: Page<{ id: string; status: string }>;
  items: Page<DisplayItem>;
  open: NativeSnapshot;
};
class PassiveAgent extends AbstractAgent {
  run(): Observable<BaseEvent> { throw new Error("PASSIVE_ONLY"); }
}
/** Ошибка HTTP сохраняет неопределённый исход для запрета автоматического повтора. */
export class AgentError extends Error {
  constructor(public code: string, public outcome: string) { super(outcome === "unknown" ? "Результат неизвестен. Проверьте чат перед новым действием." : code === "STALE_REQUEST" ? "Форма устарела: решение уже получено или запрос закрыт." : code); }
}
/** Создаёт клиент текущего аккаунта; dispose отменяет HTTP и освобождает SSE/SDK. */
export function createAgentClient(userId: string, unauthorized: () => void) {
  const abort = new AbortController();
  let stop = () => {};
  async function request<A extends Command["action"]>(command: Command & { action: A }): Promise<Replies[A]> {
    if (!validateCommand(command)) throw new AgentError("INVALID_ARGUMENT", "not-sent");
    const reading = ["projects", "status", "threads", "open", "turns", "items"].includes(command.action);
    const { action, ...body } = command;
    const query = new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)]));
    try {
      const response = await fetch(`/api/agent/${action}${reading ? `?${query}` : ""}`, {
        method: reading ? "GET" : "POST", signal: abort.signal, cache: "no-store",
        headers: { "X-Brai-User": userId, "Content-Type": "application/json" }, body: reading ? undefined : JSON.stringify(body),
      });
      if (!abort.signal.aborted && response.status === 401) unauthorized();
      const value = await response.json();
      if (bytes(value) > limits.frame) throw new Error("FRAME_LIMIT");
      if (!response.ok) throw new AgentError(value.code || "UNAVAILABLE", value.outcome || "query");
      return value;
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError("UNAVAILABLE", reading ? "query" : "unknown");
    }
  }
  function watch(projectId: string, threadId: string, update: (snapshot: NativeSnapshot | null) => void) {
    stop();
    let active = true, checking = false, applying = false, latest: NativeSnapshot | null = null;
    const agent = new PassiveAgent({ threadId }), feed = new Subject<BaseEvent>();
    const input = { threadId, runId: "passive", messages: [], tools: [], context: [], state: {}, forwardedProps: {} };
    const query = new URLSearchParams({ projectId, threadId, expectedUserId: userId });
    const source = new EventSource(`/api/agent/events?${query}`);
    const reset = () => { latest = null; if (active) update(null); };
    const reconnect = () => {
      stop(); update(null);
      const timer = setTimeout(() => watch(projectId, threadId, update), 500);
      stop = () => clearTimeout(timer);
    };
    // AIDEV-NOTE: Держим только applying и latest полные снимки; SDK очередь не растёт.
    const deliver = () => { if (active && latest && !applying) { applying = true; feed.next(EventSchema.parse({ type: "STATE_SNAPSHOT", snapshot: latest })); } };
    const applied = defaultApplyEvents(input, feed, agent, []).subscribe({ next: mutation => {
      applying = false;
      const value = mutation.state as NativeSnapshot | undefined;
      if (!active || !value || !latest) return;
      if (value.generation === latest.generation && value.epoch === latest.epoch && value.seq === latest.seq) update(value);
      else deliver();
    }, error: reconnect });
    source.addEventListener("agent", raw => {
      if (!active) return;
      try {
        const envelope = JSON.parse((raw as MessageEvent).data);
        if (!validateEnvelope(envelope) || envelope.projectId !== projectId || envelope.threadId !== threadId) throw new Error("BAD_EVENT");
        EventSchema.parse(envelope.event);
        if (bytes(envelope.event.snapshot) > limits.state) throw new Error("STATE_LIMIT");
        if (latest && envelope.generation === latest.generation && envelope.epoch === latest.epoch && envelope.seq <= latest.seq) return;
        latest = envelope.event.snapshot;
        deliver();
      } catch { reconnect(); }
    });
    source.addEventListener("resync", reset);
    source.onerror = () => {
      reset();
      if (!active || checking) return;
      checking = true;
      void request({ action: "status" }).catch(() => {}).finally(() => { checking = false; });
    };
    stop = () => { active = false; source.close(); feed.complete(); applied.unsubscribe(); };
    return () => stop();
  }
  return { request, watch, dispose() { abort.abort(); stop(); } };
}
