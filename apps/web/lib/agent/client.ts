// ABOUTME: Передаёт явные HTTP команды и применяет пассивный STATE_SNAPSHOT через AG-UI SDK.
// ABOUTME: EventSource восстанавливает только чтение; клиент не начинает и не повторяет ход.
import { AbstractAgent, defaultApplyEvents } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import { EventSchema } from "@ag-ui/core/schemas";
import { Subject, type Observable } from "rxjs";
import { decodeFrame, type StreamFrame } from "./stream";
import { bytes, limits, validateCommand, validateEnvelope, validateLimits } from "@brai/agent/contracts";
import type { AgentLimits, Command, NativeSnapshot, DisplayItem, ThreadMetadata, ModelCatalog } from "@brai/agent/contracts";
type Page<T> = { generation: string; data: T[]; nextCursor: string | null };
type MutationReply = { generation: string; operationId: string; threadId: string; turnId?: string; requestId?: string; outcome: "accepted" };
type Replies = Record<"create" | "start" | "steer" | "interrupt" | "answer" | "archive", MutationReply> & {
  projects: { generation: string; projects: { projectId: string; name: string; available: boolean }[] };
  models: ModelCatalog;
  status: { generation: string; ready: boolean; connection: string; authorization: string; limits?: AgentLimits };
  threads: Page<ThreadMetadata>;
  turns: Page<{ id: string; status: string }>;
  items: Page<DisplayItem>;
  activities: { generation: string; data: DisplayItem[] };
  item: { generation: string; item: DisplayItem };
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
  async function request<A extends Command["action"]>(command: Command & { action: A }): Promise<Replies[A]> {
    if (!validateCommand(command)) throw new AgentError("INVALID_ARGUMENT", "not-sent");
    const reading = ["projects", "status", "models", "threads", "open", "turns", "items", "activities", "item"].includes(command.action);
    const { action, ...body } = command;
    const query = new URLSearchParams(Object.entries(body).map(([key, value]) => [key, Array.isArray(value) ? JSON.stringify(value) : String(value)]));
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
  type LiveChat = { projectId: string; threadId: string; snapshot: NativeSnapshot | null; confirmed: string; reading: boolean; accept: (snapshot: NativeSnapshot, authoritative?: boolean) => void; close: () => void };
  const chats = new Map<string, LiveChat>();
  const threadListeners = new Set<(snapshot: NativeSnapshot) => void>();
  const limitsListeners = new Set<(value: AgentLimits) => void>();
  const emptyLimits = (): AgentLimits => ({ state: "loading", revision: 0, observedAt: null, windows: [] });
  let limitsValue = emptyLimits(), limitsGeneration = "", limitsNeedsFresh = true;
  const notifyLimits = () => { for (const listener of limitsListeners) listener(limitsValue); };
  const notifyThread = (snapshot: NativeSnapshot) => { for (const listener of threadListeners) listener(snapshot); };
  const bases = new Map<string, NativeSnapshot>();
  let source: EventSource | undefined, connected = false, generation = "", version = 0, disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let selected: { key: string; update: (snapshot: NativeSnapshot | null) => void } | undefined;
  const identity = (snapshot: NativeSnapshot) => `${snapshot.generation}:${snapshot.epoch}`;
  function current(projectId: string, threadId: string): NativeSnapshot | null {
    const chat = chats.get(`${projectId}:${threadId}`), snapshot = chat?.snapshot;
    return connected && snapshot && snapshot.generation === generation && chat?.confirmed === identity(snapshot) ? snapshot : null;
  }
  const notify = () => { const chat = selected && chats.get(selected.key); selected?.update(chat ? current(chat.projectId, chat.threadId) : null); };
  function reset() {
    connected = false; version++;
    limitsValue = limitsValue.windows.length ? { ...limitsValue, state: "stale" } : { ...limitsValue, state: "unavailable" };
    limitsNeedsFresh = true; notifyLimits();
    for (const chat of chats.values()) chat.confirmed = "";
    notify();
  }
  function reconnect() {
    reset(); source?.close(); source = undefined;
    clearTimeout(retry);
    if (!disposed) retry = setTimeout(connectStream, 500);
  }
  function createLive(projectId: string, threadId: string): LiveChat {
    const key = `${projectId}:${threadId}`;
    let latest: NativeSnapshot | null = null, closed = false;
    let stopPipe = () => {}, push = () => {};
    let pipeRetry: ReturnType<typeof setTimeout> | undefined;
    const chat: LiveChat = { projectId, threadId, snapshot: null, confirmed: "", reading: false,
      accept(value, authoritative = false) {
        if (closed) return;
        if (authoritative) {
          chat.confirmed = identity(value);
          if (latest && identity(latest) === identity(value) && latest.seq > value.seq) value = latest;
        } else if (latest) {
          if (identity(latest) === identity(value) && value.seq <= latest.seq) return;
          if (identity(latest) !== identity(value)) chat.confirmed = "";
        }
        latest = value; push();
        if (selected?.key === key && !chat.confirmed) { notify(); void load(chat); }
      },
      close() { closed = true; clearTimeout(pipeRetry); stopPipe(); },
    };
    function startPipe() {
      if (closed) return;
      const agent = new PassiveAgent({ threadId }), feed = new Subject<BaseEvent>();
      const input = { threadId, runId: "passive", messages: [], tools: [], context: [], state: {}, forwardedProps: {} };
      let applying = false;
      push = () => { if (latest && !applying && !closed) { applying = true; feed.next(EventSchema.parse({ type: "STATE_SNAPSHOT", snapshot: latest })); } };
      const applied = defaultApplyEvents(input, feed, agent, []).subscribe({ next: mutation => {
        const value = mutation.state as NativeSnapshot | undefined;
        if (closed || !value || !latest) return;
        applying = false;
        if (identity(value) === identity(latest)) { chat.snapshot = value; if (selected?.key === key) notify(); }
        if (identity(value) !== identity(latest) || value.seq < latest.seq) push();
      }, error: () => {
        stopPipe(); chat.confirmed = "";
        if (selected?.key === key) notify();
        pipeRetry = setTimeout(() => { startPipe(); if (selected?.key === key) void load(chat); }, 500);
      } });
      stopPipe = () => { feed.complete(); applied.unsubscribe(); };
    }
    startPipe();
    return chat;
  }
  async function load(chat: LiveChat) {
    if (!connected || chat.reading || chat.confirmed || disposed) return;
    const key = `${chat.projectId}:${chat.threadId}`, before = version;
    chat.reading = true;
    try {
      const snapshot = await request({ action: "open", projectId: chat.projectId, threadId: chat.threadId });
      if (disposed || chats.get(key) !== chat || !connected || before !== version) return;
      const envelope = { projectId: chat.projectId, threadId: chat.threadId, generation: snapshot.generation, epoch: snapshot.epoch, seq: snapshot.seq, event: { type: "STATE_SNAPSHOT", snapshot } };
      if (!validateEnvelope(envelope) || bytes(snapshot) > limits.state || snapshot.generation !== generation) throw new Error("BAD_REPLY");
      chat.accept(snapshot, true);
      notifyThread(snapshot);
    } catch { if (!disposed && chats.get(key) === chat && selected?.key === key && before === version) reconnect(); }
    finally { chat.reading = false; if (chats.get(key) === chat && before !== version && selected?.key === key) void load(chat); }
  }
  function connectStream() {
    if (disposed || source) return;
    const next = new EventSource(`/api/agent/events?${new URLSearchParams({ expectedUserId: userId })}`);
    source = next;
    next.addEventListener("ready", raw => {
      if (source !== next || disposed) return;
      try {
        const value = JSON.parse((raw as MessageEvent).data);
        if (typeof value.generation !== "string" || !value.generation || value.generation.length > 128) throw new Error("BAD_READY");
        if (generation && generation !== value.generation) {
          limitsValue = emptyLimits(); limitsGeneration = value.generation; notifyLimits();
        }
        generation = value.generation; connected = true; version++; bases.clear();
        limitsGeneration = generation; limitsNeedsFresh = true;
        for (const entry of chats.values()) entry.confirmed = "";
        const chat = selected && chats.get(selected.key);
        if (chat) void load(chat);
      } catch { reconnect(); }
    });
    next.addEventListener("limits", raw => {
      if (source !== next || disposed || !connected) return;
      try {
        const value = JSON.parse((raw as MessageEvent).data);
        if (value?.generation !== generation) return;
        if (!validateLimits(value?.limits)) {
          limitsValue = limitsValue.windows.length ? { ...limitsValue, state: "stale" } : { ...limitsValue, state: "unavailable" };
          limitsNeedsFresh = true; notifyLimits(); return;
        }
        const incoming = value.limits as AgentLimits;
        if (limitsGeneration !== generation) { limitsValue = emptyLimits(); limitsGeneration = generation; limitsNeedsFresh = true; }
        if (incoming.revision < limitsValue.revision) return;
        const reconnectSnapshot = limitsNeedsFresh;
        if (!reconnectSnapshot && incoming.revision === limitsValue.revision && incoming.state === limitsValue.state) return;
        limitsValue = incoming; limitsNeedsFresh = false; notifyLimits();
      } catch {
        limitsValue = limitsValue.windows.length ? { ...limitsValue, state: "stale" } : { ...limitsValue, state: "unavailable" };
        limitsNeedsFresh = true; notifyLimits();
      }
    });
    next.addEventListener("agent", raw => {
      if (source !== next || disposed || !connected) return;
      try {
        const frame = JSON.parse((raw as MessageEvent).data) as StreamFrame;
        if (frame.generation !== generation) throw new Error("BAD_EVENT");
        const key = `${frame.projectId}:${frame.threadId}`, old = bases.get(key);
        if (old && old.generation === frame.generation && old.epoch === frame.epoch && frame.seq <= old.seq) return;
        // AIDEV-NOTE: База wire живёт и до выбора чата; GETopen может быть новее отправленного SSE.
        const snapshot = decodeFrame(frame, old);
        bases.delete(key); bases.set(key, snapshot);
        if (bases.size > limits.threads) bases.delete(bases.keys().next().value!);
        const chat = chats.get(key);
        chat?.accept(snapshot);
        const shown = chat?.snapshot;
        notifyThread(shown && identity(shown) === identity(snapshot) && shown.seq > snapshot.seq ? shown : snapshot);
      } catch { reconnect(); }
    });
    next.addEventListener("resync", () => { if (source === next && !disposed) reset(); });
    next.onerror = () => { if (source === next && !disposed) reset(); };
  }
  /** Выбор меняет только получателя: транспорт и до восьми passive SDK views живут до dispose. */
  function watch(projectId: string, threadId: string, update: (snapshot: NativeSnapshot | null) => void) {
    const key = `${projectId}:${threadId}`, chat = chats.get(key) ?? createLive(projectId, threadId);
    chats.delete(key); chats.set(key, chat);
    if (chats.size > 8) { const oldest = chats.keys().next().value!; chats.get(oldest)!.close(); chats.delete(oldest); }
    const listener = { key, update };
    selected = listener;
    notify(); connectStream(); void load(chat);
    return () => { if (selected === listener) selected = undefined; };
  }
  /** Получает metadata всех кадров через общий SSE, без создания passive view или HTTPopen. */
  function subscribeThreads(update: (snapshot: NativeSnapshot) => void) {
    threadListeners.add(update); connectStream();
    return () => { threadListeners.delete(update); };
  }
  /** Подписывает интерфейс на проекцию аккаунта через общее SSE, даже без выбранного чата. */
  function subscribeLimits(update: (value: AgentLimits) => void) {
    limitsListeners.add(update); update(limitsValue); connectStream();
    return () => { limitsListeners.delete(update); };
  }
  return { request, watch, current, subscribeThreads, subscribeLimits, dispose() { disposed = true; selected = undefined; limitsValue = emptyLimits(); limitsGeneration = ""; limitsNeedsFresh = true; abort.abort(); source?.close(); clearTimeout(retry); for (const chat of chats.values()) chat.close(); chats.clear(); bases.clear(); threadListeners.clear(); limitsListeners.clear(); } };
}
