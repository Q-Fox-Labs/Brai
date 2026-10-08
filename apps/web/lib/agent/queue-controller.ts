// ABOUTME: Координирует сохраняемую очередь сообщений между вкладками одного аккаунта.
// ABOUTME: Удерживает lock до исхода отправки; неизвестный исход не повторяет автоматически.
import type { ComposerDraft } from "./images";
import {
  queueScopeKey, releaseQueueEntries,
  type QueueAttempt, type QueueEntry, type QueueScope, type QueueSettings, type QueueSnapshot, type QueueStore,
} from "./queue.ts";

/** Только адрес и версия очереди либо сигнал паузы; содержание сообщения не транслируется. */
export type QueueCoordinationMessage = { type: "changed"; scope: QueueScope; revision: number } | { type: "pause"; scope: QueueScope };

/** Межвкладочная координация; lock аккаунта охватывает также uploads и внешнюю мутацию. */
export type QueueCoordination = {
  available: boolean;
  runExclusive<T>(userId: string, job: () => Promise<T>, signal: AbortSignal): Promise<T>;
  notify(message: QueueCoordinationMessage): void;
  subscribe(listener: (message: QueueCoordinationMessage) => void): () => void;
  close(): void;
};

/** Актуальное действие и настройки, проверенные экраном для выбранного треда. */
export type QueueDispatch = { action: "start" | "steer"; generation: string; expectedTurnId?: string; settings: QueueSettings };
/** not-sent гарантирует отсутствие мутации; ошибка или потерянный ответ означают unknown. */
export type QueueOutcome = "accepted" | "not-sent" | "unknown";
/** Снимок выбранной очереди. Preview URL принадлежат контроллеру до следующего обновления. */
export type QueueViewState = {
  scope: QueueScope | null; revision: number; entries: QueueEntry[];
  paused: boolean; available: boolean; loading: boolean; error: string | null;
};
/** Порты экрана проверяют выбор и signal также после uploads, непосредственно перед мутацией. */
export type QueueControllerDeps = {
  store: QueueStore;
  coordination?: QueueCoordination;
  /** Проверяет существование и доступность треда под account lock; false сохраняет composer. */
  canEnqueue?(entry: QueueEntry, signal: AbortSignal): Promise<boolean>;
  canDispatch(entry: QueueEntry, immediate: boolean, signal: AbortSignal): Promise<QueueDispatch | null>;
  send(entry: QueueEntry, attempt: QueueAttempt, signal: AbortSignal): Promise<QueueOutcome>;
  check(entry: QueueEntry, signal: AbortSignal): Promise<boolean>;
};
/** Команды сохраняют данные до успеха; ошибки сообщаются через state.error без выбрасывания. */
export type QueueController = {
  state(): QueueViewState;
  subscribe(listener: () => void): () => void;
  open(scope: QueueScope): Promise<boolean>;
  enqueue(draft: ComposerDraft, settings: QueueSettings, generation: string): Promise<boolean>;
  edit(id: string, draft: ComposerDraft, settings: QueueSettings): Promise<boolean>;
  move(id: string, direction: -1 | 1): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  pause(): void;
  resume(): Promise<boolean>;
  dispatch(id?: string, immediate?: boolean): Promise<boolean>;
  reconcile(id: string): Promise<boolean>;
  dispose(): void;
};

const unavailable = "Очередь недоступна: нужны IndexedDB, Web Locks и BroadcastChannel. Откройте приложение в поддерживаемом браузере.";
const uncertain = "Исход отправки неизвестен. Проверьте сообщение или удалите запись, затем продолжите очередь.";
const editable = (entry: QueueEntry) => entry.state === "waiting" || entry.state === "failed";
const reason = (error: unknown) => error instanceof Error ? error.message : "Не удалось обновить очередь.";

function validMessage(value: unknown): value is QueueCoordinationMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<QueueCoordinationMessage>;
  if (!message.scope) return false;
  if (message.type !== "pause" && (message.type !== "changed" || !Number.isSafeInteger(message.revision))) return false;
  return [message.scope.userId, message.scope.projectId, message.scope.threadId].every(value => typeof value === "string");
}

/** Создаёт штатные Web Locks/BroadcastChannel; отсутствие IndexedDB также выключает очередь. */
export function createBrowserQueueCoordination(): QueueCoordination {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  let channel: BroadcastChannel | undefined;
  if (locks && typeof BroadcastChannel !== "undefined" && typeof indexedDB !== "undefined") {
    try { channel = new BroadcastChannel("brai-agent-queue-v1"); } catch { /* Недоступность API видна через available. */ }
  }
  const listeners = new Set<(message: QueueCoordinationMessage) => void>();
  if (channel) channel.onmessage = event => {
    if (validMessage(event.data)) for (const listener of listeners) listener(event.data);
  };
  return {
    available: !!locks && !!channel,
    async runExclusive(userId, job, signal) {
      if (!locks || !channel) throw new Error(unavailable);
      return locks.request(`brai-agent-queue:${userId}`, { mode: "exclusive", signal }, job);
    },
    notify(message) { channel?.postMessage(message); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { channel?.close(); channel = undefined; listeners.clear(); },
  };
}

function cloneEntries(entries: QueueEntry[]): QueueEntry[] {
  const owned: QueueEntry[] = [];
  try {
    for (const entry of entries) {
      const copy: QueueEntry = { ...entry, scope: { ...entry.scope }, settings: { ...entry.settings }, attempt: entry.attempt ? { ...entry.attempt } : undefined, draft: { ...entry.draft, images: [] } };
      owned.push(copy);
      for (const image of entry.draft.images) copy.draft.images.push({
        ...image, previewUrl: URL.createObjectURL(image.model), previewObjectUrl: true,
      });
    }
    return owned;
  } catch (error) { releaseQueueEntries(owned); throw error; }
}

/**
 * Создаёт очередь одного аккаунта. open восстанавливает sending под lock; восстановленная очередь на паузе.
 * Компонент владеет store/coordination и своими preview URL; dispose отменяет внешние операции.
 * canDispatch=null оставляет запись ждать; throw делает её failed. send обязан проверять signal до мутации.
 */
export function createQueueController(userId: string, deps: QueueControllerDeps): QueueController {
  const coordination = deps.coordination ?? createBrowserQueueCoordination();
  let view: QueueViewState = { scope: null, revision: 0, entries: [], paused: true, available: coordination.available, loading: false, error: coordination.available ? null : unavailable };
  const listeners = new Set<() => void>();
  let disposed = false, epoch = 0;
  let selection = new AbortController();
  let dispatchAbort: AbortController | null = null;
  let dispatchPending = false;
  const scopePauses = new Map<string, boolean>();
  const pauseRevisions = new Map<string, number>();
  const ambiguousAttempts = new Map<string, string>();
  const knownUnknown = (entry: QueueEntry): QueueEntry => entry.state === "sending" && entry.attempt && ambiguousAttempts.get(entry.id) === entry.attempt.operationId ? { ...entry, state: "unknown", error: uncertain } : entry;
  const emit = () => { for (const listener of listeners) listener(); };
  const active = (token: number) => !disposed && token === epoch;
  const error = (token: number, message: string) => { if (active(token)) { view = { ...view, error: message }; emit(); } };
  const notify = (message: QueueCoordinationMessage) => {
    try { coordination.notify(message); } catch (failure) {
      if (view.scope && queueScopeKey(view.scope) === queueScopeKey(message.scope)) error(epoch, reason(failure));
    }
  };
  const pauseScope = (scope: QueueScope, broadcast: boolean) => {
    const key = queueScopeKey(scope);
    scopePauses.set(key, true);
    pauseRevisions.set(key, (pauseRevisions.get(key) ?? 0) + 1);
    if (!disposed && view.scope && queueScopeKey(view.scope) === queueScopeKey(scope)) {
      view = { ...view, paused: true };
      dispatchAbort?.abort();
      emit();
    }
    if (broadcast && !disposed) notify({ type: "pause", scope });
  };
  const publish = (snapshot: QueueSnapshot, token: number) => {
    if (!active(token)) return;
    const entries = cloneEntries(snapshot.entries.map(knownUnknown));
    releaseQueueEntries(view.entries);
    const unknown = entries.some(entry => entry.state === "unknown");
    if (unknown) scopePauses.set(queueScopeKey(snapshot.scope), true);
    view = { ...view, revision: snapshot.revision, entries, paused: view.paused || unknown, error: unknown ? uncertain : null };
    emit();
  };
  const selected = () => !disposed && view.available && view.scope?.userId === userId && !view.loading;

  // AIDEV-NOTE: Каждый job владеет hydrated-снимком отдельно от view. Смена треда освобождает
  // view немедленно, но не отзывает URL/Blob у ещё завершающейся отправки старого треда.
  async function locked(
    scope: QueueScope, token: number, signal: AbortSignal,
    job: (snapshot: QueueSnapshot, save: (entries: QueueEntry[]) => Promise<QueueSnapshot>) => Promise<boolean>,
    onFailure?: () => void,
  ): Promise<boolean> {
    try {
      return await coordination.runExclusive(userId, async () => {
        if (!active(token) || signal.aborted) return false;
        let snapshot = await deps.store.load(scope);
        try {
          if (!active(token) || signal.aborted) return false;
          const save = async (entries: QueueEntry[]) => {
            const next = await deps.store.save(scope, snapshot.revision, entries);
            for (const entry of snapshot.entries) {
              if (!next.entries.some(value => value.id === entry.id && value.state === "sending")) ambiguousAttempts.delete(entry.id);
            }
            releaseQueueEntries(snapshot.entries);
            snapshot = next;
            publish(snapshot, token);
            notify({ type: "changed", scope, revision: next.revision });
            return next;
          };
          return await job(snapshot, save);
        } finally { releaseQueueEntries(snapshot.entries); }
      }, signal);
    } catch (failure) {
      if (!signal.aborted) { onFailure?.(); error(token, reason(failure)); }
      return false;
    }
  }

  const unsubscribe = coordination.subscribe(message => {
    if (disposed) return;
    if (message.type === "pause") {
      if (message.scope.userId === userId) pauseScope(message.scope, false);
      return;
    }
    const scope = view.scope;
    if (!scope || queueScopeKey(scope) !== queueScopeKey(message.scope) || message.revision <= view.revision) return;
    const token = epoch, signal = selection.signal;
    // Снимок sending из живой вкладки здесь не восстанавливается: это делает только open под lock.
    void locked(scope, token, signal, async snapshot => { publish(snapshot, token); return true; });
  });

  async function modify(change: (entries: QueueEntry[]) => QueueEntry[] | null): Promise<boolean> {
    if (!selected()) return false;
    const scope = view.scope!, token = epoch;
    return locked(scope, token, selection.signal, async (snapshot, save) => {
      const entries = change(snapshot.entries.map(knownUnknown));
      if (!entries) { publish(snapshot, token); return false; }
      await save(entries);
      return active(token);
    });
  }

  return {
    state: () => view,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async open(scope) {
      if (disposed) return false;
      selection.abort(); dispatchAbort?.abort(); selection = new AbortController();
      const token = ++epoch;
      releaseQueueEntries(view.entries);
      view = { ...view, scope: { ...scope }, revision: 0, entries: [], paused: scopePauses.get(queueScopeKey(scope)) ?? true, loading: view.available && scope.userId === userId, error: view.available ? null : unavailable };
      emit();
      if (!view.available) return false;
      if (scope.userId !== userId) { error(token, "Очередь принадлежит другому аккаунту."); return false; }
      const result = await locked(scope, token, selection.signal, async (snapshot, save) => {
        const key = queueScopeKey(scope);
        if (!scopePauses.has(key)) scopePauses.set(key, snapshot.entries.length > 0);
        view = { ...view, paused: scopePauses.get(key)! };
        if (snapshot.entries.some(entry => entry.state === "sending")) {
          await save(snapshot.entries.map(entry => entry.state === "sending" ? { ...entry, state: "unknown", error: uncertain } : entry));
        } else publish(snapshot, token);
        return active(token);
      });
      if (active(token)) { view = { ...view, loading: false }; emit(); }
      return result;
    },
    async enqueue(draft, settings, generation) {
      if (!selected()) return false;
      const scope = { ...view.scope! };
      // Фиксируем пользовательский ввод до ожидания lock, но не присваиваем его URL.
      const entry: QueueEntry = { id: crypto.randomUUID(), scope, generation, draft: { ...draft, images: draft.images.map(image => ({ ...image })) }, settings: { ...settings }, state: "waiting" };
      const token = epoch, signal = selection.signal;
      return locked(scope, token, signal, async (snapshot, save) => {
        if (deps.canEnqueue && !await deps.canEnqueue(entry, signal)) return false;
        if (!active(token) || signal.aborted) return false;
        await save([...snapshot.entries, entry]);
        return active(token);
      });
    },
    async edit(id, draft, settings) {
      const copy = { ...draft, images: draft.images.map(image => ({ ...image })) };
      return modify(entries => {
        const index = entries.findIndex(entry => entry.id === id);
        if (index < 0 || !editable(entries[index])) return null;
        return entries.map((entry, i) => i === index ? { ...entry, draft: copy, settings: { ...settings }, state: "waiting", attempt: undefined, error: undefined } : entry);
      });
    },
    async move(id, direction) {
      if (direction !== -1 && direction !== 1) return false;
      return modify(entries => {
        const index = entries.findIndex(entry => entry.id === id), next = index + direction;
        if (index < 0 || next < 0 || next >= entries.length || !editable(entries[index]) || !editable(entries[next])) return null;
        const reordered = [...entries];
        [reordered[index], reordered[next]] = [reordered[next], reordered[index]];
        return reordered;
      });
    },
    async remove(id) {
      return modify(entries => {
        const entry = entries.find(entry => entry.id === id);
        if (!entry || entry.state === "sending") return null;
        if (entry.state === "unknown") pauseScope(entry.scope, true);
        return entries.filter(entry => entry.id !== id);
      });
    },
    pause() { if (view.scope) pauseScope(view.scope, true); },
    async resume() {
      if (!selected()) return false;
      const scope = view.scope!, token = epoch, key = queueScopeKey(scope);
      const pauseRevision = pauseRevisions.get(key) ?? 0;
      return locked(scope, token, selection.signal, async snapshot => {
        publish(snapshot, token);
        if (!active(token) || pauseRevision !== (pauseRevisions.get(key) ?? 0)) return false;
        if (snapshot.entries.some(entry => entry.state === "unknown" || entry.state === "sending")) { error(token, uncertain); return false; }
        scopePauses.set(queueScopeKey(scope), false);
        view = { ...view, paused: false, error: null }; emit();
        return true;
      });
    },
    async dispatch(id, immediate = false) {
      if (!selected() || dispatchPending || (view.paused && !immediate)) return false;
      // Захваченный ID не позволяет двум вкладкам после первого accepted отправить следующую запись.
      const target = id ?? view.entries[0]?.id;
      if (!target) return false;
      const scope = view.scope!, token = epoch, selectionSignal = selection.signal;
      dispatchPending = true;
      try { return await locked(scope, token, selectionSignal, async (snapshot, save) => {
        publish(snapshot, token);
        if (!active(token) || (view.paused && !immediate) || snapshot.entries.some(entry => entry.state === "unknown" || entry.state === "sending")) return false;
        const index = snapshot.entries.findIndex(entry => entry.id === target);
        if (index < 0 || !editable(snapshot.entries[index]) || (!immediate && index !== 0) || (!id && snapshot.entries[index].state === "failed")) return false;
        const localAbort = new AbortController();
        dispatchAbort = localAbort;
        const signal = AbortSignal.any([selectionSignal, localAbort.signal]);
        let entry = snapshot.entries[index], current = snapshot;
        let submitted = false, persisted = false, writingAttempt = false;
        let outcome: QueueOutcome | null = null;
        try {
          const first = await deps.canDispatch(entry, immediate, signal);
          if (!first || signal.aborted || !active(token)) return false;
          const ready = await deps.canDispatch(entry, immediate, signal);
          if (!ready || signal.aborted || !active(token)) return false;
          const attempt: QueueAttempt = { operationId: crypto.randomUUID(), action: ready.action, generation: ready.generation, expectedTurnId: ready.expectedTurnId };
          const sending: QueueEntry = { ...entry, generation: ready.generation, state: "sending", attempt, error: undefined };
          writingAttempt = true;
          const saved = await save(snapshot.entries.map((value, i) => i === index ? sending : value));
          current = saved;
          writingAttempt = false; persisted = true;
          entry = saved.entries[index];
          if (signal.aborted || !active(token)) outcome = "not-sent";
          else {
            submitted = true;
            outcome = await deps.send({ ...entry, settings: { ...ready.settings } }, attempt, signal);
          }
          if (outcome === "unknown") pauseScope(scope, true);
          await save(saved.entries.flatMap(value => value.id !== target ? [value] : outcome === "accepted" ? [] : [{ ...value, state: outcome === "not-sent" ? "failed" : "unknown", error: outcome === "not-sent" ? "Сообщение не отправлено. Исправьте запись или повторите отправку." : uncertain }]));
          return outcome === "accepted" && active(token);
        } catch (failure) {
          // До send ошибка означает failed; явному not-sent доверяем даже при отмене uploads.
          const ambiguous = submitted && outcome !== "not-sent";
          if (ambiguous || writingAttempt || persisted) pauseScope(scope, true);
          const state = ambiguous ? "unknown" : "failed";
          const message = ambiguous ? `${uncertain} ${reason(failure)}` : reason(failure);
          const failed = current.entries.map(value => value.id === target ? { ...value, state, error: message } as QueueEntry : value);
          if (persisted || !signal.aborted) {
            try { await save(failed); }
            catch (saveFailure) {
              pauseScope(scope, true);
              if (ambiguous) {
                if (entry.attempt) ambiguousAttempts.set(entry.id, entry.attempt.operationId);
                publish({ ...current, entries: failed }, token);
              }
              error(token, `${message} Не удалось сохранить исход: ${reason(saveFailure)}`);
              return false;
            }
          }
          error(token, message);
          return false;
        } finally { if (dispatchAbort === localAbort) dispatchAbort = null; }
      }, () => pauseScope(scope, true)); } finally { dispatchPending = false; }
    },
    async reconcile(id) {
      if (!selected()) return false;
      const scope = view.scope!, token = epoch, signal = selection.signal;
      return locked(scope, token, signal, async (snapshot, save) => {
        const found = snapshot.entries.find(entry => entry.id === id);
        const entry = found ? knownUnknown(found) : undefined;
        if (!entry || entry.state !== "unknown" || !entry.attempt) return false;
        pauseScope(scope, true);
        const confirmed = await deps.check(entry, signal);
        if (!confirmed || signal.aborted || !active(token)) { publish(snapshot, token); return false; }
        await save(snapshot.entries.filter(value => value.id !== id));
        return active(token);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true; epoch++; selection.abort(); dispatchAbort?.abort(); unsubscribe();
      releaseQueueEntries(view.entries);
      view = { ...view, scope: null, entries: [], paused: true, available: false, loading: false };
      listeners.clear(); deps.store.close(); coordination.close();
    },
  };
}
