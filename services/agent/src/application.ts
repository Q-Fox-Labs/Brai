// ABOUTME: Реализует прикладные сценарии agent через CodexPort.
// ABOUTME: Не импортирует транспорт, NATS, UI или файловую систему хоста.

import {
  limits,
  validateDto,
  validateUpstreamAnswer,
  serializedBytes,
} from "../contracts/index.mjs";
import type { CodexPort, CodexObservation } from "./ports.js";
import { createState, type Session, type StateChange } from "./state.js";
import { readHistory } from "./history.js";
import type {
  HistoryRequest,
  ErrorResponse,
  RequestRespondResponse,
  ThreadCreateResponse,
  TurnMutationResponse,
  RequestRespondRequest,
  ThreadCreateRequest,
  ThreadReadRequest,
  ThreadsRequest,
  TurnInterruptRequest,
  TurnStartRequest,
  TurnSteerRequest,
} from "../contracts/index.mjs";

/** Явная привязка безопасного project ID к абсолютному рабочему каталогу. */
export type ProjectDefinition = {
  projectId: string;
  name: string;
  cwd: string;
  available?: boolean;
};
/** Требуемые адаптеры и конфигурация одного экземпляра сценариев agent. */
export type ApplicationOptions = {
  codex: CodexPort;
  projects: ProjectDefinition[];
  allowedModels?: string[];
  newThread?: { approvalsReviewer?: "user" | "auto_review" | "guardian_subagent" | null };
  onSubscription?: (session: Session, generation: string) => void;
  onEvict?: (session: Session, generation: string) => Promise<"released" | "unresolved">;
  onObservation?: (
    e: CodexObservation,
    s: Readonly<Session> | undefined,
    state: ReturnType<typeof createState>,
    change: StateChange,
  ) => void;
  onResync?: (s: Session, state: ReturnType<typeof createState>) => void;
};

/** Преобразует ошибки порта и сценария в безопасный DTO и HTTP status. */
export function toErrorResponse(
  error: unknown,
  generation: string,
  operationId?: string,
): { body: ErrorResponse; httpStatus: number } {
  const source =
    error && typeof error === "object"
      ? (error as { code?: unknown; outcome?: unknown })
      : {};
  const known = new Set<ErrorResponse["code"]>([
    "INVALID_ARGUMENT",
    "STALE_GENERATION",
    "OPERATION_CONFLICT",
    "REQUEST_TOO_LARGE",
    "ITEM_TOO_LARGE",
    "CAPACITY_EXHAUSTED",
    "UPSTREAM_UNAVAILABLE",
    "TIMEOUT",
    "NOT_FOUND",
    "UNSUPPORTED",
    "STALE_REQUEST",
  ]);
  const code =
    typeof source.code === "string" &&
    known.has(source.code as ErrorResponse["code"])
      ? (source.code as ErrorResponse["code"])
      : source.code === "timeout"
        ? "TIMEOUT"
        : "UPSTREAM_UNAVAILABLE";
  const outcome =
    source.outcome === "not-sent" || source.outcome === "query"
      ? source.outcome
      : "unknown";
  const messages: Record<ErrorResponse["code"], string> = {
    INVALID_ARGUMENT: "Request is invalid.",
    STALE_GENERATION: "Connection generation changed.",
    OPERATION_CONFLICT: "Operation conflicts with current thread state.",
    REQUEST_TOO_LARGE: "Request exceeds the allowed size.",
    ITEM_TOO_LARGE: "History item exceeds the allowed size.",
    CAPACITY_EXHAUSTED: "Service capacity is exhausted.",
    UPSTREAM_UNAVAILABLE: "Codex is unavailable.",
    TIMEOUT: "Codex request timed out.",
    NOT_FOUND: "Project or thread was not found.",
    UNSUPPORTED: "Operation is unsupported.",
    STALE_REQUEST: "Request is no longer pending.",
  };
  const body: ErrorResponse = {
    code,
    outcome,
    generation,
    ...(operationId ? { operationId } : {}),
    message: messages[code],
  };
  const httpStatus =
    code === "INVALID_ARGUMENT" || code === "REQUEST_TOO_LARGE"
      ? code === "INVALID_ARGUMENT"
        ? 400
        : 413
      : code === "NOT_FOUND"
        ? 404
        : code === "OPERATION_CONFLICT" ||
            code === "STALE_GENERATION" ||
            code === "STALE_REQUEST"
          ? 409
          : code === "CAPACITY_EXHAUSTED"
            ? 429
            : code === "UNSUPPORTED"
              ? 501
              : code === "TIMEOUT"
                ? 504
                : code === "ITEM_TOO_LARGE"
                  ? 413
                  : 503;
  return { body, httpStatus };
}
/** Создаёт сценарии сервиса. Проекты должны иметь явный абсолютный cwd. */
export function createApplication(options: ApplicationOptions) {
  const state = createState(
    (session, owner) => options.onResync?.(session, owner),
    (session, generation) => options.onEvict?.(session, generation) ?? Promise.resolve("released"),
  );
  const projects = new Map(options.projects.map((p) => [p.projectId, p]));
  const openingThreads = new Set<string>();
  const openings = new Map<string, Promise<Session>>();
  const observed = options.codex.subscribe((e) => {
    const change = state.observe(e);
    if (e.type === "connection") {
      state.syncGeneration(e.status.generation);
      options.onObservation?.(e, undefined, state, change);
    } else {
      options.onObservation?.(e, change.session, state, change);
    }
  });
  const fail = (
    code: string,
    outcome: "not-sent" | "unknown" | "query" = "not-sent",
  ): never => {
    throw Object.assign(new Error(code.replaceAll("_", " ").toLowerCase()), {
      code,
      outcome,
    });
  };
  const project = (id: string): ProjectDefinition => {
    const p = projects.get(id);
    if (!p || p.available === false)
      throw Object.assign(new Error("Project unavailable"), {
        code: "NOT_FOUND",
        outcome: "not-sent",
      });
    if (!p.cwd.startsWith("/"))
      throw Object.assign(new Error("Project cwd must be absolute"), {
        code: "INVALID_ARGUMENT",
        outcome: "not-sent",
      });
    return p;
  };
  const session = (projectId: string, threadId: string): Session => {
    project(projectId);
    const s = state.get(projectId, threadId);
    if (!s)
      throw Object.assign(new Error("Thread not loaded"), {
        code: "NOT_FOUND",
        outcome: "not-sent",
      });
    return s;
  };
  const call = (
    method: string,
    params: Record<string, unknown>,
    mutation: boolean,
  ) => options.codex.call(method, params, { mutation });
  const operation = <T, R extends { generation: string; operationId: string }>(
    r: R,
    fn: () => Promise<T>,
  ) => state.runOperation(r.generation, r.operationId, r, fn);
  function assertCurrentGeneration(
    generation: string,
    s?: Session,
    epoch?: string,
    outcome: "not-sent" | "unknown" = "not-sent",
  ): void {
    if (
      state.generation() !== generation ||
      (s && s.generation !== generation) ||
      (s && epoch !== undefined && s.streamEpoch !== epoch)
    ) fail("STALE_GENERATION", outcome);
  }
  async function openThread(
    projectId: string,
    threadId: string,
  ): Promise<Session> {
    const p = project(projectId);
    const openingGeneration = state.generation();
    let s = state.get(projectId, threadId);
    if (s) state.assertNotClosing(s);
    if (s?.knownNew || s?.opened) return s;
    const key = `${projectId}\0${threadId}`;
    const pending = openings.get(key);
    if (pending) return pending;
    const opening = (async () => {
      if (!s) {
        const metadata: any = await call(
          "thread/read",
          { threadId, includeTurns: false },
          false,
        );
        assertCurrentGeneration(openingGeneration);
        if (metadata?.thread?.id !== threadId || metadata.thread.cwd !== p.cwd)
          fail("INVALID_ARGUMENT");
        s = await state.admit(projectId, threadId, p.cwd);
      }
      const bootstrapRevision = s.revision;
      const epoch = s.streamEpoch;
      state.setOpening(s, true);
      try {
        // Resume can apply its subscription before its reply is lost. Track
        // possible ownership before sending so LRU cleanup can unsubscribe it.
        options.onSubscription?.(s, openingGeneration);
        const resumed: any = await call(
          "thread/resume",
          { threadId, cwd: p.cwd, excludeTurns: true },
          true,
        );
        assertCurrentGeneration(openingGeneration, s, epoch, "unknown");
        if (resumed?.thread?.id !== threadId || resumed.cwd !== p.cwd)
          fail("INVALID_ARGUMENT");
        const canAccept = typeof resumed.thread.canAcceptDirectInput === "boolean" ? resumed.thread.canAcceptDirectInput : null;
        state.setCanAcceptDirectInput(s, canAccept);
        const page: any = await call(
          "thread/turns/list",
          { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" },
          false,
        );
        assertCurrentGeneration(openingGeneration, s, epoch);
        const latest = Array.isArray(page?.data) ? page.data[0] : null;
        const turn = latest && typeof latest.id === "string" ? latest : null;
        const confirmedActive = resumed.thread.status?.type === "active" && turn?.status === "inProgress";
        state.setOpened(
          s,
          typeof resumed.model === "string" ? resumed.model : null,
          confirmedActive ? turn!.id : null,
          turn?.status ?? null,
          bootstrapRevision,
          canAccept,
          confirmedActive,
        );
        return s;
      } finally {
        state.setOpening(s, false);
      }
    })();
    openings.set(key, opening);
    try {
      return await opening;
    } finally {
      openings.delete(key);
    }
  }
  async function start(
    projectId: string,
    text: string,
    operationId: string,
    generation: string,
    s: Session,
  ): Promise<TurnMutationResponse> {
    const p = project(projectId);
    state.assertNotClosing(s);
    assertCurrentGeneration(generation, s);
    if (s.cwd !== p.cwd) fail("INVALID_ARGUMENT");
    if (s.canAcceptDirectInput === false) fail("OPERATION_CONFLICT");
    if (s.turnStatus === "inProgress" && !s.active) fail("OPERATION_CONFLICT");
    state.reserveTurn(s);
    const epoch = s.streamEpoch;
    const startedGeneration = generation;
    if (!s.knownNew) {
      try {
        // A timed-out resume may still have subscribed upstream.
        options.onSubscription?.(s, startedGeneration);
        const resumed: any = await call(
          "thread/resume",
          { threadId: s.threadId, cwd: p.cwd, excludeTurns: true },
          true,
        );
        assertCurrentGeneration(startedGeneration, s, epoch, "unknown");
        if (resumed?.cwd !== p.cwd) {
          state.finishTurn(s, "failed");
          fail("INVALID_ARGUMENT");
        }
        const canAccept = typeof resumed.thread?.canAcceptDirectInput === "boolean" ? resumed.thread.canAcceptDirectInput : null;
        state.setCanAcceptDirectInput(s, canAccept);
        if (canAccept === false) {
          state.finishTurn(s, "failed");
          fail("OPERATION_CONFLICT");
        }
        state.setModel(
          s,
          typeof resumed.model === "string" ? resumed.model : null,
        );
      } catch (error) {
        assertCurrentGeneration(startedGeneration, s, epoch, "unknown");
        if ((error as any)?.outcome === "not-sent")
          state.finishTurn(s, "failed");
        throw error;
      }
    }
    assertCurrentGeneration(startedGeneration, s, epoch);
    if (
      options.allowedModels &&
      (!s.model || !options.allowedModels.includes(s.model))
    ) {
      state.finishTurn(s, "failed");
      fail("UNSUPPORTED");
    }
    state.setModel(s, s.model, false);
    let response: any;
    try {
      response = await call(
        "turn/start",
        { threadId: s.threadId, input: [{ type: "text", text }] },
        true,
      );
    } catch (error) {
      assertCurrentGeneration(startedGeneration, s, epoch, "unknown");
      if ((error as any)?.outcome === "not-sent") state.finishTurn(s, "failed");
      throw error;
    }
    assertCurrentGeneration(startedGeneration, s, epoch, "unknown");
    state.setTurnId(s, response?.turn?.id ?? null);
    const result: TurnMutationResponse = {
      generation,
      operationId,
      outcome: "accepted",
      threadId: s.threadId,
      turnId: s.activeTurnId ?? "",
    };
    if (!validateDto("TurnMutationResponse", result))
      fail("UNSUPPORTED", "unknown");
    return result;
  }
  return {
    /** Список только явно настроенных проектов. */
    projects() {
      const value = {
        generation: state.generation(),
        projects: [...projects.values()].map((p) => ({
          projectId: p.projectId,
          name: p.name,
          available: p.available !== false,
        })),
      };
      if (!validateDto("ProjectsResponse", value)) fail("UNSUPPORTED");
      return value;
    },
    /** Безопасный статус порта и capacity. */
    status() {
      const s = options.codex.status();
      const result = {
        generation: state.generation(),
        ready: s.connection === "connected" && s.authorization === "ready",
        connection: s.connection,
        authorization: s.authorization,
        limits: {
          loadedThreads: limits.loadedThreads,
          activeTurns: limits.activeTurns,
          pendingRpc: limits.pendingRpc,
          pendingForms: limits.pendingForms,
          ledgerEntries: limits.ledgerEntries,
          upstreamFrameBytes: limits.upstreamFrameBytes,
          natsSseFrameBytes: limits.natsSseFrameBytes,
          historyResponseBytes: limits.historyResponseBytes,
        },
      };
      if (!validateDto("StatusResponse", result)) fail("UNSUPPORTED", "query");
      return result;
    },
    /** Перечисляет upstream threads в границах DTO. */
    async threads(r: ThreadsRequest) {
      if (!validateDto("ThreadsRequest", r)) fail("INVALID_ARGUMENT");
      const p = project(r.projectId);
      const x: any = await call(
        "thread/list",
        {
          cwd: p.cwd,
          limit: Math.min(100, r.limit ?? 50),
          ...(r.cursor ? { cursor: r.cursor } : {}),
        },
        false,
      );
      const value = {
        generation: state.generation(),
        threads: (x.data ?? []).map((t: any) => ({
          threadId: t.id,
          title: String(t.name ?? t.preview ?? "").slice(0, 256),
          updatedAt: new Date(Number(t.updatedAt) * 1000).toISOString(),
          active: t.status?.type === "active",
        })),
        nextCursor: x.nextCursor ?? null,
      };
      if (!validateDto("ThreadsResponse", value)) fail("UNSUPPORTED");
      return value;
    },
    /** Читает metadata без thread history hydration и связывает cwd с проектом. */
    async thread(r: ThreadReadRequest) {
      if (!validateDto("ThreadReadRequest", r)) fail("INVALID_ARGUMENT");
      const s = await openThread(r.projectId, r.threadId);
      const value = structuredClone(state.view(s));
      if (!validateDto("ThreadSnapshot", value)) fail("UNSUPPORTED");
      return value;
    },
    /** Читает только страничную историю. */
    async history(r: HistoryRequest) {
      const s = await openThread(r.projectId, r.threadId);
      return readHistory(options.codex, s, r);
    },
    /** Создаёт новый пустой thread; не запускает ход. */
    async threadCreate(r: ThreadCreateRequest) {
      if (!validateDto("ThreadCreateRequest", r)) fail("INVALID_ARGUMENT");
      return operation(r, async () => {
        const p = project(r.projectId);
        const ticket = await state.reserveThreadStart();
        try {
          const x: any = await call(
            "thread/start",
            {
              cwd: p.cwd,
              allowProviderModelFallback: false,
              ...(options.newThread?.approvalsReviewer === undefined ? {} : { approvalsReviewer: options.newThread.approvalsReviewer }),
            },
            true,
          );
          assertCurrentGeneration(r.generation, undefined, undefined, "unknown");
          const id = x?.thread?.id;
          if (typeof id !== "string") fail("UNSUPPORTED", "unknown");
          const s = await ticket.commit(r.projectId, id, p.cwd);
          state.setCanAcceptDirectInput(s, typeof x.thread?.canAcceptDirectInput === "boolean" ? x.thread.canAcceptDirectInput : null);
          state.setModel(s, typeof x.model === "string" ? x.model : null, true);
          options.onSubscription?.(s, r.generation);
          const result = {
            generation: r.generation,
            operationId: r.operationId,
            outcome: "accepted",
            threadId: id,
          };
          if (!validateDto("ThreadCreateResponse", result))
            fail("UNSUPPORTED", "unknown");
          return result;
        } catch (error) {
          await ticket.finish((error as { outcome?: unknown })?.outcome === "not-sent" ? "not-sent" : "unknown").catch(() => undefined);
          throw error;
        }
      });
    },
    /** Запускает ход после подтверждения существующего или нового thread metadata. */
    async turnStart(r: TurnStartRequest) {
      if (serializedBytes(r) > 65536) fail("REQUEST_TOO_LARGE");
      if (!validateDto("TurnStartRequest", r)) fail("INVALID_ARGUMENT");
      return operation(r, async () => {
        const lock = `${r.projectId}\0${r.threadId}`;
        if (openingThreads.has(lock)) fail("OPERATION_CONFLICT");
        openingThreads.add(lock);
        try {
          const p = project(r.projectId);
          let s = state.get(r.projectId, r.threadId);
          if (!s) {
            const x: any = await call(
              "thread/read",
              { threadId: r.threadId, includeTurns: false },
              false,
            );
            assertCurrentGeneration(r.generation);
            if (x?.thread?.id !== r.threadId || x.thread.cwd !== p.cwd)
              fail("INVALID_ARGUMENT");
            s = await state.admit(r.projectId, r.threadId, p.cwd);
            state.setOpening(s, false);
          }
          return await start(
            r.projectId,
            r.text,
            r.operationId,
            r.generation,
            s,
          );
        } finally {
          openingThreads.delete(lock);
        }
      });
    },
    /** Steer завершается конфликтом при несовпадении active turn. */
    async turnSteer(r: TurnSteerRequest) {
      if (serializedBytes(r) > 65536) fail("REQUEST_TOO_LARGE");
      if (!validateDto("TurnSteerRequest", r)) fail("INVALID_ARGUMENT");
      return operation(r, async () => {
        const s = session(r.projectId, r.threadId);
        if (!s.active || s.activeTurnId !== r.expectedTurnId)
          fail("OPERATION_CONFLICT");
        if (s.canAcceptDirectInput === false) fail("OPERATION_CONFLICT");
        const epoch = s.streamEpoch;
        assertCurrentGeneration(r.generation, s, epoch);
        let x: any;
        try {
          x = await call(
            "turn/steer",
            {
              threadId: s.threadId,
              expectedTurnId: r.expectedTurnId,
              input: [{ type: "text", text: r.text }],
            },
            true,
          );
        } catch (error) {
          assertCurrentGeneration(r.generation, s, epoch, "unknown");
          throw error;
        }
        assertCurrentGeneration(r.generation, s, epoch);
        const result = {
          generation: r.generation,
          operationId: r.operationId,
          outcome: "accepted",
          threadId: s.threadId,
          turnId: x?.turnId ?? s.activeTurnId,
        };
        if (!validateDto("TurnMutationResponse", result))
          fail("UNSUPPORTED", "unknown");
        return result;
      });
    },
    /** Запрашивает interrupt; активность меняется только по upstream observation. */
    async turnInterrupt(r: TurnInterruptRequest) {
      if (!validateDto("TurnInterruptRequest", r)) fail("INVALID_ARGUMENT");
      return operation(r, async () => {
        const s = session(r.projectId, r.threadId);
        if (s.activeTurnId !== r.turnId) fail("OPERATION_CONFLICT");
        const epoch = s.streamEpoch;
        assertCurrentGeneration(r.generation, s, epoch, "unknown");
        let x: any;
        try {
          x = await call(
            "turn/interrupt",
            { threadId: s.threadId, turnId: r.turnId },
            true,
          );
        } catch (error) {
          assertCurrentGeneration(r.generation, s, epoch, "unknown");
          throw error;
        }
        assertCurrentGeneration(r.generation, s, epoch, "unknown");
        if (!x) fail("UNSUPPORTED", "unknown");
        const result = {
          generation: r.generation,
          operationId: r.operationId,
          outcome: "accepted",
          threadId: s.threadId,
          turnId: r.turnId,
        };
        if (!validateDto("TurnMutationResponse", result))
          fail("UNSUPPORTED", "unknown");
        return result;
      });
    },
    /** Фиксирует локальное решение до RPC, сохраняя исходный тип ID. */
    async requestRespond(r: RequestRespondRequest) {
      if (!validateDto("RequestRespondRequest", r)) fail("INVALID_ARGUMENT");
      return operation(r, async () => {
        const s = session(r.projectId, r.threadId);
        const f = s.pending.get(r.requestId);
        if (!f || f.kind === "unsupported")
          throw Object.assign(new Error("Stale request"), {
            code: "STALE_REQUEST",
            outcome: "not-sent",
          });
        if (
          r.kind !== f.kind ||
          !validateUpstreamAnswer(r.kind as any, r.answer, f.params as any)
        )
          fail("INVALID_ARGUMENT");
        const claimed = state.claimPending(s, r.requestId);
        if (!claimed)
          throw Object.assign(new Error("Stale request"), {
            code: "STALE_REQUEST",
            outcome: "not-sent",
          });
        const epoch = s.streamEpoch;
        try {
          await options.codex.respond(claimed.rawId, r.answer);
        } catch (error) {
          assertCurrentGeneration(r.generation, s, epoch, "unknown");
          if ((error as any)?.outcome === "not-sent")
            state.releaseDecisionOnNotSent(s, r.requestId);
          throw error;
        }
        assertCurrentGeneration(r.generation, s, epoch, "unknown");
        const result = {
          generation: r.generation,
          operationId: r.operationId,
          outcome: "accepted",
          requestId: r.requestId,
        };
        if (!validateDto("RequestRespondResponse", result))
          fail("UNSUPPORTED", "unknown");
        return result;
      });
    },
    /** Отменяет подписку приложения; транспорт закрывает владелец сборки. */
    close() {
      observed();
    },
  };
}
