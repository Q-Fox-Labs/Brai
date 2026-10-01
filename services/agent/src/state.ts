// ABOUTME: Хранит сеансы agent, поколения, активные ходы и операции.
// ABOUTME: Единственный владелец изменяемого состояния сценариев Codex.

import { createHash, randomUUID } from "node:crypto";
import type { CodexObservation, RawRequestId } from "./ports.js";

/** Сокращает UTF-8 строку по кодовым точкам, сохраняя явный маркер. */
function truncateUtf8(value: string, maxBytes: number): string {
  const suffix = "\n[содержимое сокращено]";
  let result = "";
  let bytes = 0;
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  for (const point of value) {
    const pointBytes = Buffer.byteLength(point, "utf8");
    if (bytes + pointBytes > budget) break;
    bytes += pointBytes;
    result += point;
  }
  return result + suffix;
}

function boundedUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  return Buffer.byteLength(value, "utf8") <= maxBytes
    ? { text: value, truncated: false }
    : { text: truncateUtf8(value, maxBytes), truncated: true };
}

type SessionData = {
  projectId: string;
  threadId: string;
  cwd: string;
  generation: string;
  model: string | null;
  knownNew: boolean;
  messagePhases: Map<string, string>;
  itemLifecycles: Map<string, "open" | "closed">;
  messageSourceBytes: Map<string, number>;
  messageTruncated: Set<string>;
  streamEpoch: string;
  seq: number;
  // AIDEV-NOTE: Меняется только при записи lifecycle; текст и формы не блокируют bootstrap.
  turnLifecycleRevision: number;
  activeTurnId: string | null;
  turnStatus: "completed" | "interrupted" | "failed" | "inProgress" | null;
  canAcceptDirectInput: boolean | null;
  truncated: boolean;
  truncationReason: "byte-budget" | "item-limit" | "upstream-limit" | "none";
  opened: boolean;
  connectionLost: boolean;
  requestStorageFailed: boolean;
  active: boolean;
  pending: Map<string, MutablePendingForm>;
  messages: unknown[];
  trace: unknown[];
  lastUsed: number;
  opening: Promise<void> | null;
};
/** Представление сеанса только для чтения в приложении и истории. */
export type Session = Readonly<
  Omit<SessionData, "pending" | "messages" | "trace" | "messagePhases" | "itemLifecycles" | "messageSourceBytes" | "messageTruncated"> & {
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
type EvictionResult = "released" | "unresolved";
type ThreadStartTicket = {
  readonly generation: string;
  commit(projectId: string, threadId: string, cwd: string): Promise<Session>;
  finish(outcome: "not-sent" | "unknown"): Promise<void>;
};

/** Изменения наблюдения, подтверждённые владельцем состояния. */
export type StateChange = Readonly<{
  session?: Session;
  closedRequestIds: readonly string[];
  openedRequestId?: string;
  generationChanged?: boolean;
}>;

/** Создаёт bounded-владелец сеансов и immutable operation ledger. */
export function createState(
  onResync: (session: Session, owner?: any) => void = () => undefined,
  onEvict: (session: Session, generation: string) => Promise<EvictionResult> = async () => "released",
) {
  const sessions = new Map<string, MutableSession>();
  const ledger = new Map<string, LedgerEntry>();
  let pendingBytes = 0;
  let pendingCount = 0;
  let activeCount = 0;
  let generation: string | null = null;
  const closingSessions = new Set<MutableSession>();
  const unresolvedSessions = new Set<MutableSession>();
  const reservations = new Map<symbol, { generation: string; outcome: "pending" | "unknown" }>();
  let admissionTail: Promise<void> = Promise.resolve();
  let admissionCount = 0;
  const ADMISSION_LIMIT = 64;
  const key = (projectId: string, threadId: string) =>
    `${projectId}\0${threadId}`;
  const effectiveGeneration = () => generation ?? (generation = randomUUID());
  async function withAdmission<T>(work: () => Promise<T> | T): Promise<T> {
    if (admissionCount >= ADMISSION_LIMIT)
      throw Object.assign(new Error("Admission capacity exhausted"), { code: "CAPACITY_EXHAUSTED", outcome: "not-sent" });
    admissionCount++;
    let unlock!: () => void;
    const previous = admissionTail;
    admissionTail = new Promise<void>((resolve) => { unlock = resolve; });
    await previous;
    try { return await work(); }
    finally { admissionCount--; unlock(); }
  }
  function newSession(projectId: string, threadId: string, cwd: string): MutableSession {
    return {
      projectId, threadId, cwd, generation: effectiveGeneration(), model: null, knownNew: false,
      messagePhases: new Map(), itemLifecycles: new Map(), messageSourceBytes: new Map(), messageTruncated: new Set(),
      streamEpoch: randomUUID(), seq: 0, turnLifecycleRevision: 0, activeTurnId: null, turnStatus: null, canAcceptDirectInput: null, truncated: false,
      truncationReason: "none", opened: false, connectionLost: false, requestStorageFailed: false, active: false,
      pending: new Map(), messages: [], trace: [], lastUsed: Date.now(), opening: null,
    };
  }
  async function ensureSlot(): Promise<void> {
    const startGeneration = effectiveGeneration();
    while (sessions.size + reservations.size >= 16) {
      const victim = [...sessions.values()]
        .filter((item) => !item.active && !item.pending.size && !item.opening && !closingSessions.has(item) && !unresolvedSessions.has(item))
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!victim)
        throw Object.assign(new Error("Session capacity exhausted"), { code: "CAPACITY_EXHAUSTED", outcome: "not-sent" });
      const victimGeneration = victim.generation;
      closingSessions.add(victim);
      try { onResync(victim, owner); } catch { /* Resync listeners cannot cancel owner cleanup. */ }
      let result: EvictionResult = "unresolved";
      try { result = await onEvict(victim, victimGeneration); } catch { result = "unresolved"; }
      if (generation !== startGeneration || victimGeneration !== startGeneration || sessions.get(key(victim.projectId, victim.threadId)) !== victim)
        throw Object.assign(new Error("Session generation changed during cleanup"), { code: "STALE_GENERATION", outcome: "not-sent" });
      if (result !== "released" || victim.active || victim.pending.size || victim.opening) {
        unresolvedSessions.add(victim);
        continue;
      }
      sessions.delete(key(victim.projectId, victim.threadId));
      closingSessions.delete(victim);
    }
  }
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
      onResync(victim, owner);
      sessions.delete(key(victim.projectId, victim.threadId));
    }
    if (sessions.size + reservations.size >= 16)
      throw Object.assign(new Error("Session capacity exhausted"), { code: "CAPACITY_EXHAUSTED", outcome: "not-sent" });
    s = newSession(projectId, threadId, cwd);
    sessions.set(id, s);
    return s;
  }
  async function admit(projectId: string, threadId: string, cwd: string): Promise<Session> {
    const requestedGeneration = effectiveGeneration();
    return withAdmission(async () => {
      if (generation !== requestedGeneration)
        throw Object.assign(new Error("Session generation changed while queued"), { code: "STALE_GENERATION", outcome: "not-sent" });
      const id = key(projectId, threadId);
      const existing = sessions.get(id);
      if (existing) {
        if (closingSessions.has(existing) || unresolvedSessions.has(existing))
          throw Object.assign(new Error("Session cleanup is unresolved"), { code: "CAPACITY_EXHAUSTED", outcome: "not-sent" });
        if (existing.opening)
          throw Object.assign(new Error("Session is opening"), { code: "OPERATION_CONFLICT", outcome: "not-sent" });
        if (existing.cwd !== cwd)
          throw Object.assign(new Error("Thread project mismatch"), { code: "INVALID_ARGUMENT", outcome: "not-sent" });
        existing.opening = Promise.resolve();
        existing.lastUsed = Date.now();
        return existing;
      }
      await ensureSlot();
      if (generation !== requestedGeneration)
        throw Object.assign(new Error("Session generation changed"), { code: "STALE_GENERATION", outcome: "not-sent" });
      const session = newSession(projectId, threadId, cwd);
      session.opening = Promise.resolve();
      sessions.set(id, session);
      return session;
    });
  }
  async function reserveThreadStart(): Promise<ThreadStartTicket> {
    const requestedGeneration = effectiveGeneration();
    return withAdmission(async () => {
      const capturedGeneration = requestedGeneration;
      if (generation !== capturedGeneration)
        throw Object.assign(new Error("Session generation changed while queued"), { code: "STALE_GENERATION", outcome: "not-sent" });
      await ensureSlot();
      if (generation !== capturedGeneration)
        throw Object.assign(new Error("Session generation changed"), { code: "STALE_GENERATION", outcome: "not-sent" });
      const token = Symbol("thread-start");
      reservations.set(token, { generation: capturedGeneration, outcome: "pending" });
      const ticket: ThreadStartTicket = Object.freeze({
        generation: capturedGeneration,
        async commit(projectId, threadId, cwd) {
          const entry = reservations.get(token);
          if (!entry || entry.generation !== generation || entry.outcome !== "pending")
            throw Object.assign(new Error("Thread start reservation expired"), { code: "STALE_GENERATION", outcome: "unknown" });
          const id = key(projectId, threadId);
          if (sessions.has(id))
            throw Object.assign(new Error("Created thread ID already has an owner"), { code: "OPERATION_CONFLICT", outcome: "unknown" });
          reservations.delete(token);
          const session = newSession(projectId, threadId, cwd);
          sessions.set(id, session);
          return session;
        },
        async finish(outcome) {
          const entry = reservations.get(token);
          if (!entry || entry.generation !== generation) return;
          if (outcome === "not-sent") reservations.delete(token);
          else entry.outcome = "unknown";
        },
      });
      return ticket;
    });
  }
  function syncGeneration(next: string | null): void {
    if (!next || next === generation) return;
    generation = next;
    ledger.clear();
    reservations.clear();
    closingSessions.clear();
    unresolvedSessions.clear();
    pendingBytes = 0;
    pendingCount = 0;
    activeCount = 0;
    for (const [id, s] of sessions) {
      sessions.set(id, {
        ...s,
        generation: next,
        messagePhases: new Map(),
        itemLifecycles: new Map(),
        messageSourceBytes: new Map(),
        messageTruncated: new Set(),
        active: false,
        activeTurnId: null,
        pending: new Map(),
        opened: false,
        connectionLost: true,
        requestStorageFailed: false,
        streamEpoch: randomUUID(),
        seq: 0,
        turnLifecycleRevision: 0,
        opening: null,
      });
    }
  }
  function reserveTurn(session: Session): void {
    const s = owned(session);
    if (closingSessions.has(s) || unresolvedSessions.has(s))
      throw Object.assign(new Error("Session cleanup is unresolved"), { code: "CAPACITY_EXHAUSTED", outcome: "not-sent" });
    if (s.opening)
      throw Object.assign(new Error("Session is opening"), { code: "OPERATION_CONFLICT", outcome: "not-sent" });
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
    s.turnLifecycleRevision++;
    activeCount++;
  }
  function finishTurn(
    session: Session,
    state: "completed" | "interrupted" | "failed",
  ): void {
    const s = owned(session);
    if (!s.active) return;
    s.active = false;
    s.turnLifecycleRevision++;
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
    if (s.requestStorageFailed) return undefined;
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
    s.turnLifecycleRevision++;
  }
  /** Добавляет проекционное сообщение и удаляет метаданные вытесненного ID. */
  function appendMessage(session: Session, message: unknown): void {
    const s = owned(session);
    const item =
      message && typeof message === "object"
        ? (message as { id?: unknown })
        : {};
    const clone = message && typeof message === "object" ? structuredClone(message) as any : message;
    const capStrings = (value: any): any => {
      if (typeof value === "string") {
        if (Buffer.byteLength(value, "utf8") <= 64 * 1024) return value;
        s.truncated = true;
        s.truncationReason = "byte-budget";
        const suffix = "\n[содержимое сокращено]";
        let text = "";
        let usedBytes = 0;
        const budget = 64 * 1024 - Buffer.byteLength(suffix, "utf8");
        for (const point of value) {
          const pointBytes = Buffer.byteLength(point, "utf8");
          if (usedBytes + pointBytes > budget) break;
          usedBytes += pointBytes;
          text += point;
        }
        return text + suffix;
      }
      if (Array.isArray(value)) return value.map(capStrings);
      if (value && typeof value === "object") for (const key of Object.keys(value)) value[key] = capStrings(value[key]);
      return value;
    };
    const safe = capStrings(clone);
    s.messages.push(safe);
    if (typeof item.id === "string" && message && typeof message === "object") {
      const sourceContent = (message as any).content;
      const sourceBytes = typeof sourceContent === "string" ? Buffer.byteLength(sourceContent, "utf8") : Buffer.byteLength(JSON.stringify(sourceContent ?? ""), "utf8");
      s.messageSourceBytes.set(item.id, sourceBytes);
      if (typeof sourceContent === "string" && typeof safe?.content === "string" && sourceContent !== safe.content) s.messageTruncated.add(item.id);
      else s.messageTruncated.delete(item.id);
    }
    if (s.messages.length > 256) {
      const removed = s.messages.splice(0, s.messages.length - 256);
      s.truncated = true;
      s.truncationReason = "item-limit";
      for (const old of removed) {
        if (
          old &&
          typeof old === "object" &&
          typeof (old as { id?: unknown }).id === "string"
        )
          s.messagePhases.delete((old as { id: string }).id);
        if (old && typeof old === "object" && typeof (old as { id?: unknown }).id === "string")
          s.itemLifecycles.delete((old as { id: string }).id);
        if (old && typeof old === "object" && typeof (old as { id?: unknown }).id === "string") {
          s.messageSourceBytes.delete((old as { id: string }).id);
          s.messageTruncated.delete((old as { id: string }).id);
        }
      }
    }
    while (s.messages.length > 1 && Buffer.byteLength(JSON.stringify(s.messages), "utf8") > 400 * 1024) {
      const [old] = s.messages.splice(0, 1);
      s.truncated = true;
      s.truncationReason = "byte-budget";
      if (typeof (old as any)?.id === "string") s.messagePhases.delete((old as any).id);
      if (typeof (old as any)?.id === "string") s.itemLifecycles.delete((old as any).id);
      if (typeof (old as any)?.id === "string") { s.messageSourceBytes.delete((old as any).id); s.messageTruncated.delete((old as any).id); }
    }
  }
  /** Устанавливает только документированную фазу сохранённого сообщения. */
  function setMessagePhase(
    session: Session,
    itemId: string,
    phase: "commentary" | "final_answer" | null,
  ): void {
    const s = owned(session);
    const retained = s.messages.some((message: any) => message?.id === itemId);
    if (phase === null || !retained) s.messagePhases.delete(itemId);
    else {
      s.messagePhases.delete(itemId);
      s.messagePhases.set(itemId, phase);
      while (s.messagePhases.size > 256) s.messagePhases.delete(s.messagePhases.keys().next().value!);
    }
  }
  /** Возвращает lifecycle сообщения только для ID, удерживаемых владельцем. */
  function messageLifecycle(session: Session, itemId: string): "unknown" | "open" | "closed" {
    const s = owned(session);
    if (!s.messages.some((message: any) => message?.id === itemId)) return "unknown";
    return s.itemLifecycles.get(itemId) ?? "unknown";
  }
  /** Фиксирует начало или завершение native item lifecycle в bounded owner state. */
  function setMessageLifecycle(session: Session, itemId: string, lifecycle: "open" | "closed"): void {
    const s = owned(session);
    if (!s.messages.some((message: any) => message?.id === itemId)) return;
    s.itemLifecycles.delete(itemId);
    s.itemLifecycles.set(itemId, lifecycle);
    while (s.itemLifecycles.size > 256) s.itemLifecycles.delete(s.itemLifecycles.keys().next().value!);
  }
  /** Отмечает сокращение ограниченной проекции для последующего snapshot. */
  function markTruncated(session: Session, reason: "byte-budget" | "item-limit" | "upstream-limit"): void {
    const s = owned(session);
    s.truncated = true;
    s.truncationReason = reason;
  }
  /** Добавляет безопасную проекцию трассы в ограниченный хвост сеанса. */
  function appendTrace(session: Session, item: unknown): void {
    const s = owned(session);
    const safe = item && typeof item === "object" ? structuredClone(item) as any : item;
    if (safe && Buffer.byteLength(JSON.stringify(safe), "utf8") > 4096 && typeof safe.content === "string") {
      safe.content = truncateUtf8(safe.content, 4096);
      safe.truncated = true;
      s.truncated = true;
      s.truncationReason = "byte-budget";
    }
    if (safe?.trace && typeof safe.trace.output === "string" && Buffer.byteLength(safe.trace.output, "utf8") > 64 * 1024) {
      safe.trace.output = truncateUtf8(safe.trace.output, 64 * 1024);
      safe.truncated = true;
      s.truncated = true;
      s.truncationReason = "byte-budget";
    }
    s.trace.push(safe);
    if (s.trace.length > 200) {
      s.trace.splice(0, s.trace.length - 200);
      s.truncated = true;
      s.truncationReason = "item-limit";
    }
    while (s.trace.length > 1 && Buffer.byteLength(JSON.stringify(s.trace), "utf8") > 128 * 1024) { s.trace.splice(0, 1); s.truncated = true; s.truncationReason = "byte-budget"; }
  }
  /** Увеличивает seq после атомарного применения проекционного изменения. */
  function nextSeq(session: Session): number {
    const s = owned(session);
    if (s.seq >= Number.MAX_SAFE_INTEGER) {
      s.streamEpoch = randomUUID();
      s.seq = 0;
      s.messagePhases.clear();
      s.itemLifecycles.clear();
    }
    s.seq++;
    return s.seq;
  }
  /** Применяет lifecycle снимка только если во время bootstrap не было более новой записи владельца. */
  function setOpened(
    session: Session,
    model: string | null,
    activeTurnId: string | null,
    status: Session["turnStatus"],
    turnLifecycleRevision: number,
    canAcceptDirectInput: boolean | null,
    confirmedActive: boolean,
  ): void {
    const s = owned(session);
    const liveChanged = s.turnLifecycleRevision !== turnLifecycleRevision;
    const wasActive = s.active;
    s.model = model;
    s.canAcceptDirectInput = canAcceptDirectInput;
    if (!liveChanged) {
      s.activeTurnId = activeTurnId;
      s.turnStatus = status;
      s.active = confirmedActive;
      s.turnLifecycleRevision++;
    }
    s.opened = true;
    s.connectionLost = false;
    if (!wasActive && s.active && activeCount < 4) activeCount++;
  }
  /** Сохраняет native direct-input capability; false запрещает новую мутацию. */
  function setCanAcceptDirectInput(session: Session, value: boolean | null): void {
    owned(session).canAcceptDirectInput = value;
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
        : s.requestStorageFailed
          ? "executor-unavailable"
        : s.opened && s.turnStatus === "inProgress" && !s.active
          ? "executor-unavailable"
        : s.pending.size > 0
          ? "waiting"
          : s.active
            ? "working"
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
      truncation: { truncated: s.truncated, reason: s.truncated ? s.truncationReason : "none" },
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
  function observe(e: CodexObservation): StateChange {
    const closedRequestIds: string[] = [];
    if (e.type === "connection") {
      const previousGeneration = generation;
      syncGeneration(e.status.generation);
      const generationChanged = Boolean(previousGeneration && e.status.generation && previousGeneration !== e.status.generation);
      if (e.status.connection === "connected" && !generationChanged)
        for (const s of sessions.values()) s.connectionLost = false;
      if (e.status.connection === "disconnected") {
        activeCount = 0;
        for (const s of sessions.values()) {
          for (const id of s.pending.keys()) removePending(s, id);
          s.active = false;
          s.activeTurnId = null;
          s.turnLifecycleRevision++;
          s.connectionLost = true;
          s.opened = false;
        }
      }
      return { closedRequestIds, generationChanged };
    }
    const p = e.params;
    const thread = typeof p.threadId === "string" ? p.threadId : null;
    if (!thread) return { closedRequestIds };
    const s = [...sessions.values()].find((x) => x.threadId === thread);
    if (!s) return { closedRequestIds };
    if (e.type === "notification") {
      const turn =
        p.turn && typeof p.turn === "object"
          ? (p.turn as Record<string, unknown>)
          : {};
      if (e.method === "turn/started" && typeof turn.id === "string") {
        s.turnLifecycleRevision++;
        if (!s.active && activeCount < 4) activeCount++;
        s.activeTurnId = turn.id;
        s.active = true;
        s.turnStatus = "inProgress";
      }
      if (e.method === "turn/completed") {
        if (!s.active) s.turnLifecycleRevision++;
        const result =
          turn.status === "interrupted"
            ? "interrupted"
            : turn.status === "failed"
              ? "failed"
              : "completed";
        finishTurn(s, result);
        s.turnStatus = result;
        s.activeTurnId = null;
        for (const id of s.pending.keys()) {
          closedRequestIds.push(id);
          removePending(s, id);
        }
      }
      if (
        e.method === "serverRequest/resolved" &&
        (typeof p.requestId === "string" || typeof p.requestId === "number")
      ) {
        const f = [...s.pending.values()].find((x) => x.rawId === p.requestId);
        if (f) {
          closedRequestIds.push(f.requestId);
          removePending(s, f.requestId);
        }
      }
      if (
        (e.method === "item/started" || e.method === "item/completed") &&
        p.item &&
        typeof p.item === "object"
      ) {
        const item = p.item as Record<string, unknown>;
      }
      return { session: s, closedRequestIds };
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
    const form: PendingForm = supported
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
        };
    const existing = [...s.pending.values()].find((item) => item.rawId === e.id);
    if (addPending(s, form)) return { session: s, closedRequestIds, openedRequestId: existing?.requestId ?? form.requestId };
    if (!existing) {
      // Keep the request visible even when bounded storage cannot retain its payload.
      s.requestStorageFailed = true;
    }
    return { session: s, closedRequestIds };
  }

  /** Проверяет immutable generation/epoch handle перед поздней записью. */
  function isCurrent(session: Session, epoch = session.streamEpoch): boolean {
    const current = sessions.get(key(session.projectId, session.threadId));
    return current === session && current.generation === generation && current.streamEpoch === epoch;
  }

  /** Добавляет или заменяет сообщение с исходным upstream item ID. */
  function upsertMessage(session: Session, message: unknown): void {
    const s = owned(session);
    const id = (message as { id?: unknown })?.id;
    const index = typeof id === "string" ? s.messages.findIndex((item: any) => item?.id === id) : -1;
    if (index < 0) appendMessage(session, message);
    else {
      const [old] = s.messages.splice(index, 1);
      appendMessage(session, message);
      const updated = s.messages.findIndex((item: any) => item?.id === id);
      if (updated >= 0 && updated !== index) {
        const [value] = s.messages.splice(updated, 1);
        s.messages.splice(Math.min(index, s.messages.length), 0, value);
      } else if (updated < 0 && typeof (old as any)?.id === "string") s.messagePhases.delete((old as any).id);
    }
  }

  /** Добавляет native agent delta в bounded сообщение и сохраняет размер исходника. */
  function appendMessageDelta(session: Session, itemId: string, delta: string): { message: unknown; delta: string; contentBytes: number; truncated: boolean; replacement: boolean } {
    const s = owned(session);
    const index = s.messages.findIndex((item: any) => item?.id === itemId);
    const previous = index >= 0 && typeof (s.messages[index] as any)?.content === "string" ? (s.messages[index] as any).content as string : "";
    const oldBytes = s.messageSourceBytes.get(itemId) ?? Buffer.byteLength(previous, "utf8");
    const contentBytes = oldBytes + Buffer.byteLength(delta, "utf8");
    let content = previous;
    let accepted = "";
    let replacement = false;
    const wasTruncated = s.messageTruncated.has(itemId);
    let truncated = wasTruncated;
    if (!truncated) {
      const bounded = boundedUtf8(previous + delta, 64 * 1024);
      content = bounded.text;
      truncated = bounded.truncated;
      replacement = bounded.truncated && !content.startsWith(previous);
      const marker = "\n[содержимое сокращено]";
      const appendable = bounded.truncated ? content.slice(0, -marker.length) : content;
      const room = Math.max(0, Buffer.byteLength(appendable, "utf8") - Buffer.byteLength(previous, "utf8"));
      let acceptedBytes = 0;
      for (const point of delta) {
        const pointBytes = Buffer.byteLength(point, "utf8");
        if (acceptedBytes + pointBytes > room) break;
        acceptedBytes += pointBytes;
        accepted += point;
      }
      if (bounded.truncated) accepted += marker;
    }
    upsertMessage(session, { id: itemId, role: "assistant", content });
    s.messageSourceBytes.set(itemId, contentBytes);
    if (truncated) { s.messageTruncated.add(itemId); s.truncated = true; s.truncationReason = "byte-budget"; }
    return { message: s.messages.find((item: any) => item?.id === itemId), delta: accepted, contentBytes, truncated, replacement };
  }

  /** Заменяет проекционную запись трассы по item ID. */
  function upsertTrace(session: Session, item: unknown): void {
    const s = owned(session);
    const id = (item as { itemId?: unknown })?.itemId;
    const index = typeof id === "string" ? s.trace.findIndex((current: any) => current?.itemId === id) : -1;
    if (index < 0) appendTrace(session, item);
    else {
      s.trace.splice(index, 1);
      appendTrace(session, item);
      const updated = s.trace.findIndex((entry: any) => entry?.itemId === id);
      if (updated >= 0 && updated !== index) {
        const [value] = s.trace.splice(updated, 1);
        s.trace.splice(Math.min(index, s.trace.length), 0, value);
      }
    }
  }
  const owner = {
    get,
    admit,
    reserveThreadStart,
    /** Rejects operations whose owner is currently being unsubscribed. */
    assertNotClosing(session: Session): void {
      const s = owned(session);
      if (closingSessions.has(s) || unresolvedSessions.has(s))
        throw Object.assign(new Error("Session cleanup is unresolved"), { code: "CAPACITY_EXHAUSTED", outcome: "not-sent" });
    },
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
    setCanAcceptDirectInput,
    setOpening,
    view,
    pendingView,
    values: () => [...sessions.values()] as readonly Session[],
    isCurrent,
    upsertMessage,
    appendMessageDelta,
    upsertTrace,
    messageLifecycle,
    setMessageLifecycle,
    markTruncated,
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
  return owner;
}
