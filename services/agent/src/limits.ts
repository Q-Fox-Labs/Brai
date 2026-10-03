// ABOUTME: Получает и безопасно проецирует только окна лимита Codex.
// ABOUTME: Ограничивает опросы, отбрасывает ответы старого аккаунта и поколения.
import type { AgentLimits } from '../contracts/index.mjs';
import type { CodexPort, Observation } from './codex.js';

const POLL_MS = 60_000;
const MIN_READ_INTERVAL_MS = 5_000;
const FRESH_MS = 90_000;
type Timer = ReturnType<typeof setTimeout>;
type Runtime = { now?: () => number; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval };

/** Управляет одним bounded read-потоком, не влияя на готовность чата. */
export function createLimitsMonitor(codex: CodexPort, runtime: Runtime = globalThis) {
  const { now = Date.now, setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout, setInterval: repeat = setInterval, clearInterval: stopRepeat = clearInterval } = runtime;
  let value: AgentLimits = { state: 'unavailable', revision: 0, observedAt: null, windows: [] }, closed = false, generation = codex.status().generation, accountEpoch = 0;
  let inFlight = false, queued = false, lastStartedAt = Number.NEGATIVE_INFINITY;
  let retryTimer: Timer | undefined, pollTimer: ReturnType<typeof setInterval> | undefined;

  function update(state: AgentLimits['state'], observedAt = value.observedAt, windows = value.windows, force = false) {
    if (!force && state === value.state && observedAt === value.observedAt && windows === value.windows) return;
    value = { state, revision: value.revision + 1, observedAt, windows };
  }

  function snapshot(): AgentLimits {
    if (value.state === 'ready' && value.observedAt !== null && now() - value.observedAt >= FRESH_MS) update('stale');
    return structuredClone(value);
  }

  function clearRetry() {
    if (retryTimer !== undefined) cancel(retryTimer);
    retryTimer = undefined;
  }

  function queueRead() {
    if (closed || codex.status().connection !== 'connected' || codex.status().authorization !== 'ready') return;
    queued = true;
    pump();
  }

  function pump() {
    if (closed || inFlight || !queued || codex.status().connection !== 'connected' || codex.status().authorization !== 'ready') return;
    const delay = MIN_READ_INTERVAL_MS - (now() - lastStartedAt);
    if (delay > 0) {
      if (retryTimer === undefined) retryTimer = schedule(() => { retryTimer = undefined; pump(); }, delay);
      retryTimer?.unref?.();
      return;
    }
    clearRetry();
    queued = false;
    inFlight = true;
    lastStartedAt = now();
    const requestGeneration = generation, requestAccountEpoch = accountEpoch;
    void codex.call('account/rateLimits/read', { excludeResetCreditDetails: true }).then(result => {
      if (!matches(requestGeneration, requestAccountEpoch)) return;
      const windows = projectWindows(result);
      update(windows.length ? 'ready' : 'unavailable', now(), windows, true);
    }).catch(() => {
      if (!matches(requestGeneration, requestAccountEpoch)) return;
      update(value.windows.length ? 'stale' : 'unavailable');
    }).finally(() => {
      inFlight = false;
      if (queued) pump();
    });
  }

  function matches(requestGeneration: string, requestAccountEpoch: number) {
    const status = codex.status();
    return !closed && requestGeneration === generation && requestGeneration === status.generation && requestAccountEpoch === accountEpoch && status.connection === 'connected' && status.authorization === 'ready';
  }

  function resetConnection(status: ReturnType<CodexPort['status']>) {
    generation = status.generation;
    accountEpoch++;
    queued = false;
    clearRetry();
    if (pollTimer !== undefined) stopRepeat(pollTimer);
    pollTimer = undefined;
    if (status.connection === 'connected' && status.authorization === 'ready') {
      update('loading', null, [], true);
      pollTimer = repeat(queueRead, POLL_MS);
      pollTimer?.unref?.();
      queueRead();
    } else update('unavailable', null, [], true);
  }

  function observe(event: Observation) {
    if (closed) return;
    if (event.type === 'connection' && event.status) resetConnection(event.status);
    else if (event.type === 'notification' && event.method === 'account/updated') resetConnection(codex.status());
    else if (event.type === 'notification' && event.method === 'account/rateLimits/updated') queueRead();
  }

  const status = codex.status();
  if (status.connection === 'connected') resetConnection(status);
  return {
    /** Возвращает копию безопасной проекции и синхронно помечает истёкшую свежесть. */
    snapshot,
    /** Принимает событие из единственной подписки владельца CodexPort. */
    observe,
    close() {
      if (closed) return;
      closed = true;
      queued = false;
      clearRetry();
      if (pollTimer !== undefined) stopRepeat(pollTimer);
      pollTimer = undefined;
      update('unavailable', null, [], true);
    },
  };
}

function projectWindows(value: any): AgentLimits['windows'] {
  const buckets = value?.rateLimitsByLimitId, fallback = value?.rateLimits;
  const bucket = buckets == null ? fallback && (fallback.limitId == null || fallback.limitId === 'codex') ? fallback : undefined : buckets.codex;
  if (!bucket) return [];
  const windows: AgentLimits['windows'] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const window = bucket[slot];
    if (window === undefined || window === null) continue;
    windows.push({
      slot,
      remainingPercent: Math.max(0, Math.min(100, 100 - window.usedPercent)),
      windowDurationMins: Number.isSafeInteger(window.windowDurationMins) && window.windowDurationMins >= 0 ? window.windowDurationMins : null,
      resetsAt: Number.isSafeInteger(window.resetsAt) && window.resetsAt >= 0 ? window.resetsAt : null,
    });
  }
  return windows;
}
