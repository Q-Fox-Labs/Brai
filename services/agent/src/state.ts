// ABOUTME: Хранит сеансы agent, поколения, активные ходы и операции.
// ABOUTME: Единственный владелец изменяемого состояния сценариев Codex.

import { createHash, randomUUID } from "node:crypto";
import type { CodexObservation, RawRequestId } from "./ports.js";

type SessionData = {
  projectId: string;
  threadId: string;
  cwd: string;
  generation: string;
  model: string | null;
  knownNew: boolean;
  messagePhases: Map<string, string>;
  streamEpoch: string;
  seq: number;
  revision: number;
  activeTurnId: string | null;
  turnStatus: "completed" | "interrupted" | "failed" | "inProgress" | null;
  opened: boolean;
  connectionLost: boolean;
  active: boolean;
  pending: Map<string, MutablePendingForm>;
  messages: unknown[];
  trace: unknown[];
  lastUsed: number;
  opening: Promise<void> | null;
};
/** Представление сеанса только для чтения в приложении и истории. */
export type Session = Readonly<
  Omit<SessionData, "pending" | "messages" | "trace" | "messagePhases"> & {
    pending: ReadonlyMap<string, PendingForm>;
    messages: readonly unknown[];
    trace: readonly unknown[];
    messagePhases: ReadonlyMap<string, string>;
  }
>;
type MutableSession = SessionData;
export type PendingForm = Readonly<{
  requestId: string;
  rawId: RawRequestId;
  method: string;
  kind: string;
  params: Readonly<Record<string, unknown>>;
  bytes: number;
  decision: boolean;
  reason?: "oversized" | "unknown-method";
}>;
type MutablePendingForm = Omit<PendingForm, "decision"> & { decision: boolean };
type LedgerEntry = {
  hash: string;
  result?: unknown;
  promise?: Promise<unknown>;
  error?: unknown;
};

/** Создаёт bounded-владелец сеансов и immutable operation ledger. */
export function createState(
  onResync: (session: Session) => void = () => undefined,
) {
  const sessions = new Map<string, MutableSession>();
  const ledger = new Map<string, LedgerEntry>();
  let pendingBytes = 0;
  let pendingCount = 0;
  let activeCount = 0;
  let generation: string | null = null;
  const key = (projectId: string, threadId: string) =>
    `${projectId}\0${threadId}`;
  const effectiveGeneration = () => generation ?? (generation = randomUUID());
  function owned(s: Session): MutableSession {
    const value = sessions.get(key(s.projectId, s.threadId));
    if (!value || value !== s || value.generation !== generation)
      throw Object.assign(new Error("Session expired"), {
        code: "NOT_FOUND",
        outcome: "not-sent",
      });
    return value;
  }
  function get(projectId: string, threadId: string): Session | undefined {
    const s = sessions.get(key(projectId, threadId));
    if (s) s.lastUsed = Date.now();
    return s;
  }
  function put(projectId: string, threadId: string, cwd: string): Session {
    const id = key(projectId, threadId);
    let s = sessions.get(id);
    if (s) {
      s.lastUsed = Date.now();
      return s;
    }
    if (sessions.size >= 16) {
      const victim = [...sessions.values()]
        .filter((x) => !x.active && !x.pending.size && !x.opening)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim)
        throw Object.assign(new Error("Session capacity exhausted"), {
          code: "CAPACITY_EXHAUSTED",
          outcome: "not-sent",
        });
      onResync(victim);
      sessions.delete(key(victim.projectId, victim.threadId));
    }
    s = {
      projectId,
      threadId,
      cwd,
      generation: effectiveGeneration(),
      model: null,
      knownNew: false,
      messagePhases: new Map(),
      streamEpoch: randomUUID(),
      seq: 0,
      revision: 0,
      activeTurnId: null,
      turnStatus: null,
      opened: false,
      connectionLost: false,
      active: false,
      pending: new Map(),
      messages: [],
      trace: [],
      lastUsed: Date.now(),
      opening: null,
    };
    sessions.set(id, s);
    return s;
  }
  function syncGeneration(next: string | null): void {
    if (!next || next === generation) return;
    generation = next;
    ledger.clear();
    pendingBytes = 0;
    pendingCount = 0;
    activeCount = 0;
    for (const [id, s] of sessions) {
      sessions.set(id, {
        ...s,
        generation: next,
        active: false,
        activeTurnId: null,
        pending: new Map(),
        opened: false,
        connectionLost: true,
        streamEpoch: randomUUID(),
        seq: 0,
        revision: 0,
      });
    }
  }
  function reserveTurn(session: Session): void {
    const s = owned(session);
    if (s.active)
      throw Object.assign(new Error("A turn is already active"), {
        code: "OPERATION_CONFLICT",
        outcome: "not-sent",
      });
    if (activeCount >= 4)
      throw Object.assign(new Error("Active turn capacity exhausted"), {
        code: "CAPACITY_EXHAUSTED",
        outcome: "not-sent",
      });
    s.active = true;
    activeCount++;
  }
  function finishTurn(
    session: Session,
    state: "completed" | "interrupted" | "failed",
  ): void {
    const s = owned(session);
    if (!s.active) return;
    s.active = false;
    activeCount = Math.max(0, activeCount - 1);
    if (state !== "completed") s.activeTurnId = null;
  }
  function runOperation<T>(
    gen: string,
    operationId: string,
    request: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    if (gen !== effectiveGeneration())
      return Promise.reject(
        Object.assign(new Error("Stale generation"), {
          code: "STALE_GENERATION",
          outcome: "not-sent",
        }),
      );
    const canonical = (v: any): any =>
      Array.isArray(v)
        ? v.map(canonical)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, canonical(v[k])]),
            )
          : v;
    const k = `${gen}\0${operationId}`,
      hash = createHash("sha256")
        .update(JSON.stringify(canonical(request)))
        .digest("hex");
    const old = ledger.get(k);
    if (old) {
      if (old.hash !== hash)
        return Promise.reject(
          Object.assign(
            new Error("Operation ID reused with different content"),
            { code: "OPERATION_CONFLICT", outcome: "not-sent" },
          ),
        );
      if (old.promise) return old.promise as Promise<T>;
      if (old.error) return Promise.reject(old.error);
      return Promise.resolve(old.result as T);
    }
    if (ledger.size >= 4096)
      return Promise.reject(
        Object.assign(new Error("Operation ledger full"), {
          code: "CAPACITY_EXHAUSTED",
          outcome: "not-sent",
        }),
      );
    const entry: LedgerEntry = { hash };
    ledger.set(k, entry);
    entry.promise = Promise.resolve()
      .then(run)
      .then(
        (value) => {
          entry.result = value;
          delete entry.promise;
          return value;
        },
        (error) => {
          entry.error = error;
          delete entry.promise;
          throw error;
        },
      );
    return entry.promise as Promise<T>;
  }
  function addPending(session: Session, form: PendingForm): boolean {
    const s = owned(session);
    const replay = [...s.pending.values()].find(
      (current) => current.rawId === form.rawId,
    );
    if (replay) return true;
    if (s.pending.has(form.requestId)) {
      const old = s.pending.get(form.requestId)!;
      if (old.rawId === form.rawId) return true;
      pendingBytes -= old.bytes;
    }
    if (
      form.bytes > 32768 ||
      pendingCount >= 64 ||
      pendingBytes + form.bytes > 131072
    )
      return false;
    s.pending.set(form.requestId, form);
    pendingBytes += form.bytes;
    pendingCount++;
    return true;
  }
  function removePending(session: Session, id: string): void {
    const s = owned(session);
    const p = s.pending.get(id);
    if (p) {
      pendingBytes -= p.bytes;
      pendingCount--;
      s.pending.delete(id);
    }
  }
  function claimPending(session: Session, id: string): PendingForm | undefined {
    const s = owned(session);
    const form = s.pending.get(id);
    if (!form || form.decision) return undefined;
    const claimed = { ...form, decision: true };
    s.pending.set(id, claimed);
    return claimed;
  }
  function releaseDecisionOnNotSent(session: Session, id: string): void {
    const s = owned(session);
    const form = s.pending.get(id);
    if (form) s.pending.set(id, { ...form, decision: false });
  }
  function setModel(
    session: Session,
    model: string | null,
    knownNew = false,
  ): void {
    const s = owned(session);
    s.model = model;
    s.knownNew = knownNew;
  }
  function setTurnId(session: Session, turnId: string | null): void {
    const s = owned(session);
    s.activeTurnId = turnId;
  }
  /** Добавляет проекционное сообщение и удаляет метаданные вытесненного ID. */
  function appendMessage(session: Session, message: unknown): void {
    const s = owned(session);
    const item =
      message && typeof message === "object"
        ? (message as { id?: unknown })
        : {};
    s.messages.push(message);
    if (s.messages.length > 256) {
      const removed = s.messages.splice(0, s.messages.length - 256);
      for (const old of removed) {
        if (
          old &&
          typeof old === "object" &&
          typeof (old as { id?: unknown }).id === "string"
        )
          s.messagePhases.delete((old as { id: string }).id);
      }
    }
    if (typeof item.id === "string") s.messagePhases.delete(item.id);
  }
  /** Устанавливает только документированную фазу сохранённого сообщения. */
  function setMessagePhase(
    session: Session,
    itemId: string,
    phase: "commentary" | "final_answer" | null,
  ): void {
    const s = owned(session);
    if (phase === null) s.messagePhases.delete(itemId);
    else s.messagePhases.set(itemId, phase);
  }
  /** Добавляет безопасную проекцию трассы в ограниченный хвост сеанса. */
  function appendTrace(session: Session, item: unknown): void {
    const s = owned(session);
    s.trace.push(item);
    if (s.trace.length > 200) s.trace.splice(0, s.trace.length - 200);
  }
  /** Увеличивает seq после атомарного применения проекционного изменения. */
  function nextSeq(session: Session): number {
    const s = owned(session);
    s.seq++;
    return s.seq;
  }
  function setOpened(
    session: Session,
    model: string | null,
    activeTurnId: string | null,
    status: Session["turnStatus"],
    revision: number,
  ): void {
    const s = owned(session);
    const liveChanged = s.revision !== revision;
    const wasActive = s.active;
    s.model = model;
    if (!liveChanged) {
      s.activeTurnId = activeTurnId;
      s.turnStatus = status;
      s.active = status === "inProgress";
    }
    s.opened = true;
    s.connectionLost = false;
    if (!wasActive && s.active && activeCount < 4) activeCount++;
  }
  /** Удерживает bootstrap-сеанс от LRU-вытеснения на время RPC. */
  function setOpening(session: Session, opening: boolean): void {
    if (!opening) {
      const current = sessions.get(key(session.projectId, session.threadId));
      if (current !== session) return;
    }
    owned(session).opening = opening ? Promise.resolve() : null;
  }
  function view(session: Session): Record<string, unknown> {
    const s = owned(session);
    const retained = new Set<string>(
      s.messages.flatMap((m: any) => (typeof m?.id === "string" ? [m.id] : [])),
    );
    const messagePhases = Object.fromEntries(
      [...s.messagePhases].filter(([id]) => retained.has(id)),
    );
    return {
      projectId: s.projectId,
      threadId: s.threadId,
      generation: s.generation,
      streamEpoch: s.streamEpoch,
      seq: s.seq,
      state: s.connectionLost
        ? "connection-lost"
        : s.active
          ? "working"
          : s.pending.size > 0
            ? "waiting"
          : s.turnStatus === "completed"
            ? "completed"
            : s.turnStatus === "interrupted"
              ? "interrupted"
              : s.turnStatus === "failed"
                ? "error"
                : "ready",
      messages: s.messages,
      messagePhases,
      pendingRequests: pendingView(s),
      truncation: { truncated: false, reason: "none" },
      activeTurnId: s.activeTurnId,
      turnStatus: s.turnStatus,
      traceItems: s.trace,
    };
  }
  function pendingView(session: Session): unknown[] {
    const s = owned(session);
    return [...s.pending.values()].map((f) =>
      f.kind === "unsupported"
        ? {
            requestId: f.requestId,
            kind: "unsupported",
            method: f.method,
            reason: f.reason ?? "unknown-method",
            code:
              f.reason === "oversized" ? "REQUEST_TOO_LARGE" : "UNSUPPORTED",
            threadId: s.threadId,
            turnId: s.activeTurnId,
            itemId: null,
            interruptAvailable: Boolean(s.activeTurnId),
          }
        : { requestId: f.requestId, kind: f.kind, params: f.params },
    );
  }
  function observe(e: CodexObservation): void {
    if (e.type === "connection") {
      syncGeneration(e.status.generation);
      if (e.status.connection === "connected")
        for (const s of sessions.values()) s.connectionLost = false;
      if (e.status.connection === "disconnected") {
        activeCount = 0;
        for (const s of sessions.values()) {
          for (const id of s.pending.keys()) removePending(s, id);
          s.active = false;
          s.activeTurnId = null;
          s.connectionLost = true;
          s.opened = false;
        }
      }
      return;
    }
    const p = e.params;
    const thread = typeof p.threadId === "string" ? p.threadId : null;
    if (!thread) return;
    const s = [...sessions.values()].find((x) => x.threadId === thread);
    if (!s) return;
    s.revision++;
    if (e.type === "notification") {
      const turn =
        p.turn && typeof p.turn === "object"
          ? (p.turn as Record<string, unknown>)
          : {};
      if (e.method === "turn/started" && typeof turn.id === "string") {
        if (!s.active && activeCount < 4) activeCount++;
        s.activeTurnId = turn.id;
        s.active = true;
        s.turnStatus = "inProgress";
      }
      if (e.method === "turn/completed") {
        const result =
          turn.status === "interrupted"
            ? "interrupted"
            : turn.status === "failed"
              ? "failed"
              : "completed";
        finishTurn(s, result);
        s.turnStatus = result;
        s.activeTurnId = null;
      }
      if (
        e.method === "serverRequest/resolved" &&
        (typeof p.requestId === "string" || typeof p.requestId === "number")
      ) {
        const f = [...s.pending.values()].find((x) => x.rawId === p.requestId);
        if (f) removePending(s, f.requestId);
      }
      if (
        (e.method === "item/started" || e.method === "item/completed") &&
        p.item &&
        typeof p.item === "object"
      ) {
        const item = p.item as Record<string, unknown>;
        if (
          item.type === "agentMessage" &&
          typeof item.id === "string" &&
          typeof item.phase === "string"
        )
          s.messagePhases.set(item.id, item.phase);
      }
      return;
    }
    const kind =
      e.method === "item/commandExecution/requestApproval"
        ? "command-approval"
        : e.method === "item/fileChange/requestApproval"
          ? "file-change-approval"
          : e.method === "item/permissions/requestApproval"
            ? "permissions"
            : e.method === "item/tool/requestUserInput"
              ? "question"
              : null;
    const bytes = Buffer.byteLength(JSON.stringify(e.params));
    const supported = e.supported && kind !== null && bytes <= 32768;
    addPending(
      s,
      supported
        ? {
            requestId: randomUUID(),
            rawId: e.id,
            method: e.method,
            kind,
            params: e.params,
            bytes,
            decision: false,
          }
        : {
            requestId: randomUUID(),
            rawId: e.id,
            method: e.method,
            kind: "unsupported",
            params: {},
            bytes: Math.min(bytes, 128),
            decision: false,
            reason: bytes > 32768 ? "oversized" : "unknown-method",
          },
    );
  }
  return {
    get,
    put,
    runOperation,
    reserveTurn,
    finishTurn,
    addPending,
    removePending,
    claimPending,
    releaseDecisionOnNotSent,
    setModel,
    setTurnId,
    appendMessage,
    setMessagePhase,
    appendTrace,
    nextSeq,
    setOpened,
    setOpening,
    view,
    pendingView,
    observe,
    syncGeneration,
    generation: effectiveGeneration,
    size: () => sessions.size,
    ledgerSize: () => ledger.size,
    activeCount: () => activeCount,
    pendingCount: () => pendingCount,
    pendingBytes: () => pendingBytes,
    findThread: (threadId: string) =>
      [...sessions.values()].find((s) => s.threadId === threadId),
  };
}
