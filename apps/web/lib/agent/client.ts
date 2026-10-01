// ABOUTME: Соединяет браузерный экран с HTTP/SSE шлюзом agent и SDK AG-UI.
// ABOUTME: Подписка только принимает поток; команды отправляются явно и один раз.
import { AbstractAgent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import type { BaseEvent, Event as AguiEvent, Message } from "@ag-ui/core";
import { Observable, type Subscriber } from "rxjs";
import {
  assertDto, limits, serializedBytes, validateDto, validateEventEnvelope, validateUpstreamAnswer,
} from "@brai/agent/contracts";
import type {
  DtoName, ErrorResponse, EventEnvelope, HistoryResponse, PendingRequest, ProjectsResponse,
  RequestRespondRequest, RequestRespondResponse, StatusResponse, ThreadCreateResponse,
  ThreadSnapshot, ThreadsResponse, TurnInterruptRequest, TurnMutationResponse,
  TurnStartRequest, TurnSteerRequest,
} from "@brai/agent/contracts";
import { reduceAgentState, type AgentStateAction } from "./state.ts";
import { initialAgentClientState, type AgentClientState } from "./types.ts";

type SseMessage = { data: string };
export interface AgentEventSource {
  addEventListener(type: string, listener: (event: SseMessage) => void): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
}
export type MutationResult =
  | { outcome: "accepted"; turnId?: string; threadId?: string; requestId?: string }
  | { outcome: "unknown"; error: string }
  | { outcome: "failed"; code: string; error: string };
export type AgentClientOptions = {
  expectedUserId: string;
  fetch?: typeof fetch;
  createEventSource?: (url: string) => AgentEventSource;
  createId?: () => string;
  onUnauthorized?: () => void;
};

type PassiveFeed = {
  push(event: BaseEvent): boolean;
  close(): void;
  agent: PassiveAguiAgent;
  runId: string;
  completion: Promise<unknown>;
};

/** Создаёт пассивный клиент, которым экран получает snapshot, события и явные команды. */
export function createAgentClient(options: AgentClientOptions) {
  if (!options.expectedUserId) throw new TypeError("Ожидаемый аккаунт обязателен");
  const fetcher = options.fetch ?? fetch;
  const createId = options.createId ?? (() => crypto.randomUUID());
  const createEventSource = options.createEventSource ?? (url => new EventSource(url, { withCredentials: true }));
  const aborts = new Set<AbortController>();
  const listeners = new Set<(state: AgentClientState) => void>();
  let state = initialAgentClientState();
  let knownGeneration: string | null = null;
  let source: AgentEventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let streamToken = 0;
  let selectionToken = 0;
  let queue: EventEnvelope[] = [];
  let queueBytes = 0;
  let bootstrapped = false;
  let disposed = false;
  let unauthorizedNotified = false;
  let feed: PassiveFeed | null = null;
  let sdkFeedVersion = 0;

  function dispatch(action: AgentStateAction) {
    if (disposed) return;
    state = reduceAgentState(state, action);
    for (const listener of listeners) listener(state);
  }

  function setUnauthorized() {
    dispatch({ type: "connection", value: "unauthorized" });
    if (!unauthorizedNotified) {
      unauthorizedNotified = true;
      options.onUnauthorized?.();
    }
    stopStream();
  }

  async function readJson<T>(response: Response, cap: number): Promise<T> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cap) throw new Error("Ответ agent превышает предел размера");
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > cap) {
          await reader.cancel();
          throw new Error("Ответ agent превышает предел размера");
        }
        chunks.push(part.value);
      }
    }
    try {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
    } catch {
      throw new Error("Некорректный JSON от agent");
    }
  }

  async function request<T>(path: string, init?: RequestInit, cap = limits.natsSseFrameBytes, dto?: DtoName, isCurrent: () => boolean = () => true): Promise<T> {
    if (disposed) throw new Error("Клиент agent отключён");
    const controller = new AbortController();
    aborts.add(controller);
    try {
      const headers = new Headers(init?.headers);
      headers.set("X-Brai-User", options.expectedUserId);
      if (init?.body) headers.set("Content-Type", "application/json");
      const response = await fetcher(`/api/agent/${path}`, { ...init, headers, signal: controller.signal, credentials: "same-origin" });
      if (response.status === 401) setUnauthorized();
      const value = await readJson<unknown>(response, cap);
      if (!response.ok) {
        const err = validateDto("ErrorResponse", value) ? value as ErrorResponse : null;
        throw new AgentHttpError(response.status, err);
      }
      if (!dto || !validateDto(dto, value)) throw new Error(`Некорректный ответ agent (${dto ?? "unknown"})`);
      if (!init?.method && isCurrent()) dispatch({ type: "read-error", value: null });
      return value as T;
    } catch (error) {
      if (!init?.method && isCurrent()) dispatch({ type: "read-error", value: error instanceof Error ? error.message : "Ошибка чтения agent" });
      throw error;
    } finally { aborts.delete(controller); }
  }

  async function ensureGeneration(): Promise<string> {
    if (knownGeneration) return knownGeneration;
    const response = await get<StatusResponse>("status", "StatusResponse");
    knownGeneration = response.generation;
    dispatch({ type: "status", value: response });
    return knownGeneration;
  }

  async function get<T>(path: string, dto: DtoName, cap = limits.natsSseFrameBytes, isCurrent?: () => boolean): Promise<T> {
    return request<T>(path, undefined, cap, dto, isCurrent);
  }

  async function post<T>(path: string, body: unknown, requestDto: DtoName, responseDto: DtoName): Promise<T> {
    try {
      assertDto(requestDto, body);
      if (serializedBytes(body) > limits.natsSseFrameBytes) throw new TypeError("Команда agent превышает предел размера");
    } catch (error) {
      throw new AgentPreflightError(error instanceof Error ? error.message : "Некорректная команда", "INVALID_ARGUMENT");
    }
    return request<T>(path, { method: "POST", body: JSON.stringify(body) }, limits.natsSseFrameBytes, responseDto);
  }

  function stopStream() {
    streamToken += 1;
    bootstrapped = false;
    queue = [];
    queueBytes = 0;
    source?.close();
    source = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  async function detachFeed() {
    const previous = feed;
    feed = null;
    sdkFeedVersion += 1;
    if (previous) {
      previous.close();
      await previous.agent.detachActiveRun();
    }
  }

  function newFeed(snapshot: ThreadSnapshot, hydrateRunStart: boolean): PassiveFeed {
    const agent = new PassiveAguiAgent(snapshot.threadId, snapshot.messages);
    const currentRun = snapshot.activeTurnId;
    const runId = currentRun ?? "passive";
    const feedVersion = ++sdkFeedVersion;
    let value: PassiveFeed | null = null;
    const completion = agent.connectAgent({ runId }, {
      onEvent: ({ messages }) => {
        agent.acknowledge();
        const bounded = boundSdkMessages(messages as Message[]);
        return bounded.changed ? { messages: bounded.messages } : undefined;
      },
      onMessagesChanged: ({ messages }) => {
        if (feedVersion !== sdkFeedVersion || snapshot.threadId !== state.selectedThreadId || snapshot.generation !== state.generation || snapshot.streamEpoch !== state.streamEpoch) return;
        dispatch({ type: "messages", value: boundSdkMessages(messages as Message[]).messages });
      },
    });
    void completion.catch(() => {
      if (value && feed === value) reconnect("gap", true);
    });
    value = { agent, runId, completion, push: event => agent.push(event), close: () => agent.closeFeed() };
    if (hydrateRunStart && currentRun) agent.push({ type: EventType.RUN_STARTED, threadId: snapshot.threadId, runId: currentRun });
    return value;
  }

  async function applySnapshot(snapshot: ThreadSnapshot, isCurrent: () => boolean = () => true): Promise<boolean> {
    if (!isCurrent()) return false;
    const previous = state;
    const newGeneration = knownGeneration !== null && knownGeneration !== snapshot.generation;
    await detachFeed();
    if (!isCurrent()) return false;
    knownGeneration = snapshot.generation;
    dispatch({ type: "thread", value: snapshot });
    if (snapshot.activeTurnId) feed = newFeed(snapshot, true);
    if (newGeneration || (previous.streamEpoch && previous.streamEpoch !== snapshot.streamEpoch)) {
      dispatch({ type: "resyncing", value: false });
    }
    return true;
  }

  function acceptEnvelope(envelope: EventEnvelope) {
    if (!bootstrapped) {
      const bytes = serializedBytes(envelope);
      if (queue.length >= limits.uiQueue || queueBytes + bytes > limits.snapshotBytes) { reconnect("overflow", true); return; }
      queue.push(envelope);
      queueBytes += bytes;
      return;
    }
    if (envelope.generation !== state.generation || envelope.streamEpoch !== state.streamEpoch) {
      reconnect(envelope.generation !== state.generation ? "generation-change" : "epoch-change", true);
      return;
    }
    if (envelope.seq <= (state.lastSeq ?? -1)) return;
    if (envelope.seq !== (state.lastSeq ?? -1) + 1) { reconnect("gap", true); return; }
    if (envelope.event.type === "CUSTOM" && envelope.event.name === "brai.agent.resync-required") {
      reconnect("gap", true);
      return;
    }
    dispatch({ type: "event", value: envelope });
    deliverToSdk(envelope.event);
    if (state.resyncing) reconnect("overflow", true);
  }

  function deliverToSdk(event: BaseEvent) {
    if (event.type === EventType.RUN_STARTED && state.activeTurnId) {
      // AIDEV-NOTE: новый ход требует нового пассивного подключения SDK до доставки следующего события.
      if (!feed || feed.runId !== state.activeTurnId) {
        const previousFeed = feed;
        feed = null;
        sdkFeedVersion += 1;
        if (previousFeed) { previousFeed.close(); void previousFeed.agent.detachActiveRun(); }
        feed = newFeed({
        projectId: state.selectedProjectId!, threadId: state.selectedThreadId!, generation: state.generation!,
        streamEpoch: state.streamEpoch!, seq: state.lastSeq ?? 0, state: "working", messages: state.messages,
        pendingRequests: state.pendingRequests, truncation: state.truncation ?? { truncated: false, reason: "none" },
        activeTurnId: state.activeTurnId, turnStatus: "inProgress", traceItems: state.traceItems,
        }, false);
      }
    }
    if (!feed) return;
    if (!feed.push(event)) { reconnect("overflow", true); return; }
    if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
      const finishedFeed = feed;
      finishedFeed.close();
      void finishedFeed.completion.finally(() => {
        if (feed === finishedFeed) feed = null;
      });
    }
  }

  function parseFrame(data: string, cap: number): unknown {
    if (new TextEncoder().encode(data).byteLength > cap) throw new Error("SSE frame exceeds byte limit");
    return JSON.parse(data);
  }

  function openStream(projectId: string, threadId: string) {
    if (disposed || state.connection === "unauthorized") return;
    stopStream();
    const token = streamToken;
    const selected = selectionToken;
    let latestSnapshot = 0;
    bootstrapped = false;
    queue = [];
    dispatch({ type: "connection", value: "connecting" });
    const query = new URLSearchParams({ projectId, threadId, expectedUserId: options.expectedUserId });
    const nextSource = createEventSource(`/api/agent/events?${query}`);
    source = nextSource;
    nextSource.addEventListener("snapshot", raw => {
      if (token !== streamToken || source !== nextSource) return;
      try {
        const value = parseFrame(raw.data, limits.snapshotBytes);
        if (!validateDto("ThreadSnapshot", value)) throw new Error("Некорректный snapshot agent");
        const snapshot = value as ThreadSnapshot;
        if (snapshot.projectId !== projectId || snapshot.threadId !== threadId) throw new Error("SSE snapshot адресован другому треду");
        const applyToken = ++latestSnapshot;
        const isCurrent = () => applyToken === latestSnapshot && selected === selectionToken && token === streamToken && source === nextSource && !disposed;
        bootstrapped = false;
        void applySnapshot(snapshot, isCurrent).then(applied => {
          if (!applied || !isCurrent()) return;
          const pending = queue;
          queue = [];
          queueBytes = 0;
          bootstrapped = true;
          dispatch({ type: "connection", value: "connected" });
          if (state.resyncing) { reconnect("overflow", true); return; }
          let expected = snapshot.seq;
          for (const envelope of pending) {
            if (envelope.generation !== snapshot.generation || envelope.streamEpoch !== snapshot.streamEpoch || envelope.seq <= snapshot.seq) continue;
            if (envelope.seq !== expected + 1) { reconnect("gap", true); return; }
            expected = envelope.seq;
            acceptEnvelope(envelope);
          }
          dispatch({ type: "resyncing", value: false });
        }).catch(() => { if (isCurrent()) reconnect("gap", true); });
      } catch { reconnect("gap", true); }
    });
    nextSource.addEventListener("agent", raw => {
      if (token !== streamToken || source !== nextSource) return;
      try {
        const value = parseFrame(raw.data, limits.natsSseFrameBytes);
        if (!validateEventEnvelope(value)) throw new Error("Некорректное событие agent");
        const envelope = value as EventEnvelope;
        if (envelope.projectId !== projectId || envelope.threadId !== threadId) throw new Error("SSE событие адресовано другому треду");
        acceptEnvelope(envelope);
      } catch { reconnect("gap", true); }
    });
    nextSource.onerror = () => {
      if (token !== streamToken || source !== nextSource || disposed) return;
      nextSource.close();
      source = null;
      dispatch({ type: "connection", value: "connection-lost" });
      void get<StatusResponse>("status", "StatusResponse").catch(error => {
        if (error instanceof AgentHttpError && error.status === 401) setUnauthorized();
      });
      scheduleReconnect(projectId, threadId);
    };
  }

  function scheduleReconnect(projectId: string, threadId: string) {
    if (disposed || state.connection === "unauthorized" || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openStream(projectId, threadId);
    }, 500);
  }

  function reconnect(_reason: string, immediate: boolean) {
    const projectId = state.selectedProjectId;
    const threadId = state.selectedThreadId;
    if (!projectId || !threadId || disposed) return;
    stopStream();
    dispatch({ type: "resyncing", value: true });
    if (immediate) openStream(projectId, threadId);
    else scheduleReconnect(projectId, threadId);
  }

  async function loadThreads(projectId: string, cursor?: string, expectedSelection = selectionToken): Promise<ThreadsResponse> {
    const query = new URLSearchParams({ projectId });
    if (cursor) query.set("cursor", cursor);
    const value = await get<ThreadsResponse>(`threads?${query}`, "ThreadsResponse");
    if (expectedSelection === selectionToken && projectId === state.selectedProjectId) {
      knownGeneration = value.generation;
      dispatch({ type: "threads", value: value.threads, cursor: value.nextCursor, append: Boolean(cursor) });
    }
    return value;
  }

  async function loadHistoryPage(cursor?: string) {
    if (!state.selectedProjectId || !state.selectedThreadId) throw new Error("Сначала выберите чат");
    const projectId = state.selectedProjectId;
    const threadId = state.selectedThreadId;
    const token = selectionToken;
    const isCurrent = () => token === selectionToken && state.selectedProjectId === projectId && state.selectedThreadId === threadId;
    const query = new URLSearchParams({ projectId, limit: "100" });
    const pageCursor = cursor ?? state.historyCursor;
    if (pageCursor) query.set("cursor", pageCursor);
    try {
      const value = await get<HistoryResponse>(`threads/${encodeURIComponent(threadId)}/history?${query}`, "HistoryResponse", limits.historyResponseBytes, isCurrent);
      if (!isCurrent()) return value;
      if (knownGeneration && value.generation !== knownGeneration) {
        reconnect("generation-change", true);
        throw new Error("Поколение agent изменилось; история будет повторно согласована снимком");
      }
      if (isCurrent()) {
        dispatch({ type: "history", value: value.items, cursor: value.nextCursor, append: Boolean(pageCursor) });
      }
      return value;
    } catch (error) {
      if (isCurrent()) {
        dispatch({ type: "history-error", value: error instanceof Error ? error.message : "Не удалось загрузить историю agent" });
      }
      throw error;
    }
  }

  async function selectThread(projectId: string, threadId: string) {
    const token = ++selectionToken;
    stopStream();
    await detachFeed();
    if (token !== selectionToken || disposed) return;
    dispatch({ type: "project", value: projectId });
    dispatch({ type: "thread", value: {
      projectId, threadId, generation: knownGeneration ?? "", streamEpoch: "", seq: 0, state: "ready",
      messages: [], pendingRequests: [], truncation: { truncated: false, reason: "none" },
      activeTurnId: null, turnStatus: null, traceItems: [],
    } });
    dispatch({ type: "connection", value: "connecting" });
    try {
      await loadThreads(projectId, undefined, token);
      const snapshot = await get<ThreadSnapshot>(`threads/${encodeURIComponent(threadId)}?projectId=${encodeURIComponent(projectId)}`, "ThreadSnapshot", limits.snapshotBytes);
      if (token !== selectionToken || disposed) return;
      if (snapshot.projectId !== projectId || snapshot.threadId !== threadId) throw new Error("Ответ agent адресован другому треду");
      if (!await applySnapshot(snapshot, () => token === selectionToken && !disposed && state.selectedProjectId === projectId && state.selectedThreadId === threadId)) return;
      try { await loadHistoryPage(); } catch { /* Ошибка истории видна в состоянии; SSE живого чата всё равно подключается. */ }
      if (token === selectionToken && !disposed) openStream(projectId, threadId);
    } catch (error) {
      if (token === selectionToken && !disposed) dispatch({ type: "connection", value: "connection-lost" });
      throw error;
    }
  }

  function isCurrent(target: { projectId: string; threadId: string; generation: string }): boolean {
    return state.selectedProjectId === target.projectId && state.selectedThreadId === target.threadId && state.generation === target.generation;
  }

  return {
    /** Возвращает неизменяемое состояние для чтения; обновления доступны через подписку. */
    getState: () => state,
    /** Подписывает экран и возвращает функцию удаления подписки. */
    subscribe(listener: (next: AgentClientState) => void) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    /** Загружает проекты и сохраняет поколение ответа для следующих команд. */
    async getProjects(): Promise<ProjectsResponse> {
      const token = selectionToken;
      const value = await get<ProjectsResponse>("projects", "ProjectsResponse");
      if (token === selectionToken) knownGeneration = value.generation;
      dispatch({ type: "projects", value: value.projects });
      return value;
    },
    /** Загружает status исполнителя и обновляет поколение команд. */
    async getStatus(): Promise<StatusResponse> {
      const token = selectionToken;
      const value = await get<StatusResponse>("status", "StatusResponse");
      if (token === selectionToken) knownGeneration = value.generation;
      dispatch({ type: "status", value });
      return value;
    },
    /** Выбирает проект и загружает первую страницу его чатов. */
    async selectProject(projectId: string) {
      selectionToken += 1;
      const token = selectionToken;
      stopStream();
      await detachFeed();
      if (token !== selectionToken || disposed) return null;
      dispatch({ type: "project", value: projectId });
      return loadThreads(projectId, undefined, token);
    },
    /** Загружает следующую страницу чатов выбранного проекта. */
    async loadMoreThreads() {
      if (!state.selectedProjectId || !state.threadsCursor) return null;
      return loadThreads(state.selectedProjectId, state.threadsCursor, selectionToken);
    },
    /** Загружает снимок, первую страницу истории и подключает пассивный SSE поток. */
    selectThread,
    /** Загружает одну ограниченную страницу истории Codex и соблюдает общий лимит памяти. */
    loadHistory: loadHistoryPage,
    /** Создаёт чат и выбирает его с исходным идентификатором agent. */
    async createThread(projectId = state.selectedProjectId): Promise<ThreadCreateResponse> {
      if (!projectId) throw new Error("Сначала выберите проект");
      const generation = await ensureGeneration();
      const body = { projectId, generation, operationId: createId() };
      const selectionAtStart = selectionToken;
      const value = await post<ThreadCreateResponse>("threads", body, "ThreadCreateRequest", "ThreadCreateResponse");
      if (value.operationId !== body.operationId || value.generation !== generation) throw new Error("Ответ создания чата не совпадает с командой");
      if (selectionToken === selectionAtStart && state.selectedProjectId === projectId) await selectThread(projectId, value.threadId);
      return value;
    },
    /** Задаёт текст draft без отправки команды. */
    setDraft(value: string) { dispatch({ type: "draft", value }); },
    /** Запускает один start или steer; conflict и unknown сохраняют draft, повтора нет. */
    async submitDraft(): Promise<MutationResult> {
      const { draft, selectedProjectId: projectId, selectedThreadId: threadId, generation, activeTurnId } = state;
      if (!projectId || !threadId || !draft.trim()) return { outcome: "failed", code: "INVALID_ARGUMENT", error: "Выберите чат и введите текст" };
      const currentGeneration = generation ?? await ensureGeneration();
      if (!activeTurnId && state.threadStatus === "working") return { outcome: "failed", code: "STALE_GENERATION", error: "Неизвестен активный ход; текст сохранён" };
      const submittedDraft = draft;
      const selectedAtSubmit = { projectId, threadId, generation: currentGeneration };
      const operationId = createId();
      const streamAtSubmit = streamToken;
      const lastSeqAtSubmit = state.lastSeq;
      const body: TurnStartRequest | TurnSteerRequest = activeTurnId
        ? { projectId, threadId, generation: currentGeneration, operationId, expectedTurnId: activeTurnId, text: draft }
        : { projectId, threadId, generation: currentGeneration, operationId, text: draft };
      dispatch({ type: "mutation", value: "pending" });
      try {
        const path = activeTurnId ? "turns/steer" : "turns/start";
        const requestDto = activeTurnId ? "TurnSteerRequest" : "TurnStartRequest";
        const response = await post<TurnMutationResponse>(path, body, requestDto, "TurnMutationResponse");
        if (response.outcome !== "accepted" || response.operationId !== operationId || response.generation !== currentGeneration || response.threadId !== threadId) throw new Error("Ответ agent не подтверждает эту команду");
        if (isCurrent(selectedAtSubmit)) {
          if (state.draft === submittedDraft) dispatch({ type: "draft", value: "" });
          if (!activeTurnId && streamToken === streamAtSubmit && state.lastSeq === lastSeqAtSubmit && state.activeTurnId === null) {
            state = { ...state, activeTurnId: response.turnId };
          }
          dispatch({ type: "mutation", value: "accepted" });
        }
        return { outcome: "accepted", turnId: response.turnId };
      } catch (error) { return mutationFailure(error, selectedAtSubmit); }
    },
    /** Прерывает указанный активный ход только по явному нажатию страницы. */
    async interrupt(): Promise<MutationResult> {
      const { selectedProjectId: projectId, selectedThreadId: threadId, generation, activeTurnId } = state;
      if (!projectId || !threadId || !generation || !activeTurnId) return { outcome: "failed", code: "INVALID_ARGUMENT", error: "Нет подтверждённого активного хода" };
      const operationId = createId();
      const body: TurnInterruptRequest = { projectId, threadId, generation, operationId, turnId: activeTurnId };
      dispatch({ type: "mutation", value: "pending" });
      try {
        const response = await post<TurnMutationResponse>("turns/interrupt", body, "TurnInterruptRequest", "TurnMutationResponse");
        if (response.outcome !== "accepted" || response.operationId !== operationId || response.generation !== generation || response.threadId !== threadId || response.turnId !== activeTurnId) throw new Error("Ответ agent не подтверждает эту команду");
        if (isCurrent({ projectId, threadId, generation })) dispatch({ type: "mutation", value: "accepted" });
        return { outcome: "accepted", turnId: response.turnId };
      } catch (error) { return mutationFailure(error, { projectId, threadId, generation }); }
    },
    /** Проверяет ответ относительно живой формы и отправляет его как request/respond. */
    async respond(requestId: string, kind: PendingRequest["kind"], answer: unknown): Promise<MutationResult> {
      const request = state.pendingRequests.find(item => item.requestId === requestId);
      if (!request || request.kind === "unsupported" || kind === "unsupported" || request.kind !== kind || !state.selectedProjectId || !state.selectedThreadId || !state.generation) {
        return { outcome: "failed", code: "STALE_REQUEST", error: "Форма устарела или не поддерживается" };
      }
      if (!validateUpstreamAnswer(kind, answer, request.params)) return { outcome: "failed", code: "INVALID_ARGUMENT", error: "Ответ не соответствует ожидающему запросу" };
      const identity = { projectId: state.selectedProjectId, threadId: state.selectedThreadId, generation: state.generation };
      const operationId = createId();
      const body: RequestRespondRequest = {
        projectId: state.selectedProjectId, threadId: state.selectedThreadId, generation: state.generation,
        operationId, requestId, kind, answer,
      } as RequestRespondRequest;
      dispatch({ type: "mutation", value: "pending" });
      try {
        const response = await post<RequestRespondResponse>("requests/respond", body, "RequestRespondRequest", "RequestRespondResponse");
        if (response.outcome !== "accepted" || response.operationId !== operationId || response.generation !== state.generation || response.requestId !== requestId) throw new Error("Ответ agent не подтверждает решение формы");
        if (isCurrent(identity)) dispatch({ type: "mutation", value: "accepted" });
        return { outcome: "accepted", requestId };
      } catch (error) { return mutationFailure(error, identity); }
    },
    /** Закрывает HTTP/SSE и пассивную SDK подписку без interrupt или иной команды. */
    async dispose() {
      if (disposed) return;
      disposed = true;
      stopStream();
      for (const controller of aborts) controller.abort();
      aborts.clear();
      await detachFeed();
      listeners.clear();
    },
  };

  function mutationFailure(error: unknown, target?: { projectId: string; threadId: string; generation: string }): MutationResult {
    const stillSelected = !target || isCurrent(target);
    if (error instanceof AgentPreflightError) {
      if (stillSelected) dispatch({ type: "mutation", value: "failed", error: error.message });
      return { outcome: "failed", code: error.code, error: error.message };
    }
    if (error instanceof AgentHttpError && error.body?.outcome === "unknown") {
      if (stillSelected) dispatch({ type: "mutation", value: "unknown", error: error.message });
      return { outcome: "unknown", error: error.message };
    }
    if (error instanceof AgentHttpError && error.body?.code === "STALE_REQUEST") {
      if (stillSelected) dispatch({ type: "mutation", value: "failed", error: error.message });
      if (stillSelected) reconnect("gap", true);
      return { outcome: "failed", code: "STALE_REQUEST", error: error.message };
    }
    if (error instanceof AgentHttpError) {
      if (stillSelected) dispatch({ type: "mutation", value: "failed", error: error.message });
      return { outcome: "failed", code: error.body?.code ?? `HTTP_${error.status}`, error: error.message };
    }
    const message = error instanceof Error ? error.message : "Неизвестный исход команды";
    if (stillSelected) dispatch({ type: "mutation", value: "unknown", error: message });
    return { outcome: "unknown", error: message };
  }
}

class AgentHttpError extends Error {
  readonly status: number;
  readonly body: ErrorResponse | null;

  constructor(status: number, body: ErrorResponse | null) {
    super(body?.message ?? body?.code ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

class AgentPreflightError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function boundSdkMessages(messages: Message[]): { messages: Message[]; changed: boolean } {
  let bounded = messages.slice(-256);
  while (bounded.length > 1 && serializedBytes(bounded) > limits.snapshotBytes) bounded = bounded.slice(1);
  if (serializedBytes(bounded) > limits.snapshotBytes && bounded.length === 1) {
    const item = bounded[0] as Message;
    bounded = item.role !== "activity" && typeof item.content === "string"
      ? [{ ...item, content: `[Вывод ограничен локальным буфером]\n${item.content.slice(-120_000)}` }]
      : [];
  }
  return { messages: bounded, changed: bounded.length !== messages.length || serializedBytes(bounded) !== serializedBytes(messages) };
}

class PassiveAguiAgent extends AbstractAgent {
  #subscriber: Subscriber<BaseEvent> | null = null;
  #queue: BaseEvent[] = [];
  #pending: { event: BaseEvent; bytes: number }[] = [];
  #pendingBytes = 0;
  #feedClosed = false;
  #messages: Message[];
  #textMessages = new Set<string>();
  #toolCalls = new Set<string>();

  constructor(threadId: string, messages: Message[]) {
    super({ threadId, initialMessages: messages });
    this.#messages = messages;
  }

  override run(): Observable<BaseEvent> {
    throw new Error("Пассивное подключение не запускает ход agent");
  }

  protected override connect(): Observable<BaseEvent> {
    return new Observable(subscriber => {
      this.#subscriber = subscriber;
      for (const event of this.#queue) {
        if (!this.deliver(event)) {
          subscriber.error(new Error("Не удалось согласовать lifecycle SDK с snapshot"));
          return () => { if (this.#subscriber === subscriber) this.#subscriber = null; };
        }
      }
      this.#queue = [];
      if (this.#feedClosed) subscriber.complete();
      return () => { if (this.#subscriber === subscriber) this.#subscriber = null; };
    });
  }

  push(event: BaseEvent): boolean {
    if (this.#feedClosed) return false;
    if (!this.enqueue(event)) return false;
    if (!this.#subscriber) {
      this.#queue.push(event);
      return true;
    }
    if (this.deliver(event)) return true;
    this.removePending(event);
    return false;
  }

  acknowledge() {
    const pending = this.#pending.shift();
    if (pending) this.#pendingBytes -= pending.bytes;
  }

  enqueue(event: BaseEvent, first = false): boolean {
    const bytes = serializedBytes(event);
    if (this.#pending.length >= limits.uiQueue || this.#pendingBytes + bytes > limits.natsSseFrameBytes) return false;
    const value = { event, bytes };
    if (first) this.#pending.unshift(value); else this.#pending.push(value);
    this.#pendingBytes += bytes;
    return true;
  }

  removePending(event: BaseEvent) {
    const index = this.#pending.findIndex(item => item.event === event);
    if (index < 0) return;
    this.#pendingBytes -= this.#pending[index].bytes;
    this.#pending.splice(index, 1);
  }

  deliver(event: BaseEvent): boolean {
    if (!this.#subscriber) return false;
    const aguiEvent = event as AguiEvent;
    if (aguiEvent.type === EventType.TEXT_MESSAGE_START && this.#textMessages.size >= 256 && !this.#textMessages.has(aguiEvent.messageId)) return false;
    if (aguiEvent.type === EventType.TOOL_CALL_START && this.#toolCalls.size >= 256 && !this.#toolCalls.has(aguiEvent.toolCallId)) return false;
    // AIDEV-NOTE: снимок может застать открытое сообщение или вызов инструмента;
    // локальные события восстанавливают состояние проверки SDK, не меняя ход сервера.
    if (aguiEvent.type === EventType.TEXT_MESSAGE_CONTENT || aguiEvent.type === EventType.TEXT_MESSAGE_END) {
      if (!this.#textMessages.has(aguiEvent.messageId)) {
        const message = this.#messages.find(item => item.id === aguiEvent.messageId);
        const role = message?.role;
        if (role !== "assistant" && role !== "user" && role !== "system" && role !== "developer") return false;
        if (!this.send({ type: EventType.TEXT_MESSAGE_START, messageId: aguiEvent.messageId, role } as BaseEvent)) return false;
        this.#textMessages.add(aguiEvent.messageId);
      }
    }
    if ((aguiEvent.type === EventType.TOOL_CALL_ARGS || aguiEvent.type === EventType.TOOL_CALL_END) && !this.#toolCalls.has(aguiEvent.toolCallId)) {
      const parent = this.#messages.find(message => message.role === "assistant" && message.toolCalls?.some(call => call.id === aguiEvent.toolCallId));
      const tool = parent?.role === "assistant" ? parent.toolCalls?.find(call => call.id === aguiEvent.toolCallId) : undefined;
      if (!parent || !tool) return false;
      if (!this.send({ type: EventType.TOOL_CALL_START, toolCallId: tool.id, toolCallName: tool.function.name, parentMessageId: parent.id } as BaseEvent)) return false;
      this.#toolCalls.add(tool.id);
    }
    this.#subscriber.next(event);
    if (aguiEvent.type === EventType.TEXT_MESSAGE_START) this.#textMessages.add(aguiEvent.messageId);
    if (aguiEvent.type === EventType.TEXT_MESSAGE_END) this.#textMessages.delete(aguiEvent.messageId);
    if (aguiEvent.type === EventType.MESSAGES_SNAPSHOT) this.#messages = aguiEvent.messages;
    if (aguiEvent.type === EventType.TOOL_CALL_START) this.#toolCalls.add(aguiEvent.toolCallId);
    if (aguiEvent.type === EventType.TOOL_CALL_RESULT) this.#toolCalls.delete(aguiEvent.toolCallId);
    return true;
  }

  send(event: BaseEvent): boolean {
    if (!this.enqueue(event, true)) return false;
    this.#subscriber?.next(event);
    return true;
  }

  closeFeed() {
    this.#feedClosed = true;
    this.#subscriber?.complete();
    this.#subscriber = null;
    this.#queue = [];
    this.#pending.length = 0;
    this.#pendingBytes = 0;
  }
}
