// ABOUTME: Ограничивает параллельную работу и очередь двух входных адаптеров.
// ABOUTME: Освобождает активный слот только после завершения ядра и очистки SQL.
import { HistoryFault, type OperationContext } from "./domain.js";
import { limits } from "./contracts.js";

/** Общий предел активных и ожидающих операций для входных адаптеров. */
export interface LoadGate {
  run<T>(work: (context: OperationContext) => Promise<T>, options?: { signal?: AbortSignal; responseBudgetBytes?: number; deadlineAt?: number }): Promise<T>;
  stopAccepting(): void;
  drain(): Promise<void>;
}

interface GateOptions {
  deadlineMs?: number;
  active?: number;
  queue?: number;
}

interface Entry {
  start(): void;
  expire(): void;
}

/** Создаёт FIFO gate для NATS и MCP; истёкший ответ сохраняет слот до завершения ядра. */
export function createLoadGate(options: GateOptions = {}): LoadGate {
  const deadlineMs = options.deadlineMs ?? limits.deadlineMs;
  const activeLimit = options.active ?? limits.active;
  const queueLimit = options.queue ?? limits.queue;
  if (![deadlineMs, activeLimit, queueLimit].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("INVALID_LOAD_GATE_LIMITS");
  }

  let accepting = true;
  let active = 0;
  const queue: Entry[] = [];
  const idleWaiters = new Set<() => void>();

  function signalIdle(): void {
    if (active !== 0 || queue.length !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function startAvailable(): void {
    while (active < activeLimit && queue.length > 0) {
      const entry = queue.shift()!;
      entry.start();
    }
    signalIdle();
  }

  function run<T>(work: (context: OperationContext) => Promise<T>, runOptions: { signal?: AbortSignal; responseBudgetBytes?: number; deadlineAt?: number } = {}): Promise<T> {
    if (!accepting) return Promise.reject(new HistoryFault("BUSY"));
    if (runOptions.deadlineAt !== undefined && !Number.isFinite(runOptions.deadlineAt)) return Promise.reject(new Error("INVALID_LOAD_GATE_DEADLINE"));

    return new Promise<T>((resolve, reject) => {
      const startedAt = performance.now();
      const deadlineAt = Math.min(startedAt + deadlineMs, runOptions.deadlineAt ?? Infinity);
      if (deadlineAt <= startedAt) {
        reject(new HistoryFault("DEADLINE_EXCEEDED"));
        return;
      }
      const controller = new AbortController();
      let started = false;
      let responseSettled = false;
      let released = false;
      let timer: NodeJS.Timeout;
      let externalAbort: (() => void) | undefined;

      const removeQueuedEntry = () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
      };
      const settleResponse = (error?: unknown, value?: T) => {
        if (responseSettled) return;
        responseSettled = true;
        if (error !== undefined) reject(error);
        else resolve(value as T);
      };
      const release = () => {
        if (released) return;
        released = true;
        clearTimeout(timer);
        if (runOptions.signal && externalAbort) runOptions.signal.removeEventListener("abort", externalAbort);
        active--;
        startAvailable();
      };
      const abortForDeadline = () => {
        controller.abort();
        if (!started) {
          removeQueuedEntry();
          clearTimeout(timer);
          if (runOptions.signal && externalAbort) runOptions.signal.removeEventListener("abort", externalAbort);
          settleResponse(new HistoryFault("DEADLINE_EXCEEDED"));
          signalIdle();
          return;
        }
        settleResponse(new HistoryFault("DEADLINE_EXCEEDED"));
      };
      const entry: Entry = {
        start() {
          if (started || responseSettled) return;
          started = true;
          active++;
          void Promise.resolve().then(() => {
            if (controller.signal.aborted || performance.now() >= deadlineAt) throw new HistoryFault("DEADLINE_EXCEEDED");
            return work({
            deadlineAt,
            signal: controller.signal,
            ...(runOptions.responseBudgetBytes === undefined ? {} : { responseBudgetBytes: runOptions.responseBudgetBytes }),
            });
          }).then(
            value => settleResponse(undefined, value),
            error => settleResponse(error),
          ).finally(release);
        },
        expire: abortForDeadline,
      };

      externalAbort = () => abortForDeadline();
      if (runOptions.signal?.aborted) {
        settleResponse(new HistoryFault("DEADLINE_EXCEEDED"));
        return;
      }
      runOptions.signal?.addEventListener("abort", externalAbort, { once: true });
      timer = setTimeout(entry.expire, Math.max(1, deadlineAt - performance.now()));
      if (active < activeLimit && queue.length === 0) {
        entry.start();
      } else if (queue.length < queueLimit) {
        queue.push(entry);
      } else {
        clearTimeout(timer);
        if (runOptions.signal && externalAbort) runOptions.signal.removeEventListener("abort", externalAbort);
        settleResponse(new HistoryFault("BUSY"));
      }
    });
  }

  return {
    run,
    stopAccepting() {
      accepting = false;
    },
    drain() {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise(resolve => idleWaiters.add(resolve));
    },
  };
}
