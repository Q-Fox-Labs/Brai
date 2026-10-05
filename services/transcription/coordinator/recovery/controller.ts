// ABOUTME: Восстанавливает metadata и доставляет резерв истории перед/во время работы coordinator.
// ABOUTME: Не вызывает executors; стабильные history events повторяются без изменения.
import { assertDto, methodMap } from '#transcription-contracts';

type HelperMethod = keyof typeof methodMap.helper;
type RecoveryConfig = {
  instanceId: string;
  workerId: string;
  recoveryMaxBatches: number;
  recoveryCycleTimeoutMs: number;
  recoveryPollIntervalMs: number;
  historyMaxDeliveries: number;
  historyPollIntervalMs: number;
  pumpPollIntervalMs: number;
};
type HelperPort = { call(method: string, params: unknown): Promise<unknown> };
type HistoryPort = { append(event: unknown): Promise<unknown> };
type RecoveryStatus = { ready: boolean; recoveryAvailable: boolean; historyAvailable: boolean };
type ControllerOptions = {
  helper: HelperPort;
  history: HistoryPort;
  clearVolatileResults: () => void;
  config: RecoveryConfig;
};
type RecoveryCounts = { dispatchingExpired: number; runningExpired: number; succeededBufferLost: number; resultsExpired: number };
type HistoryClaim = { deliveryId: string; claimToken: string; event: unknown };

const timerLimit = 2_147_483_647;
const zeroCounts = (): RecoveryCounts => ({ dispatchingExpired: 0, runningExpired: 0, succeededBufferLost: 0, resultsExpired: 0 });
const hasChanges = (counts: RecoveryCounts): boolean => Object.values(counts).some(value => value !== 0);

function safeError(code: string): Error {
  return new Error(code);
}

function deliveryErrorCode(error: unknown): 'HISTORY_REJECTED' | 'HISTORY_DELIVERY_FAILED' {
  if (!error || typeof error !== 'object') return 'HISTORY_DELIVERY_FAILED';
  const candidate = 'errorCode' in error ? error.errorCode : 'code' in error ? error.code : undefined;
  return ['HISTORY_REJECTED', 'INVALID_ARGUMENT', 'EVENT_ID_CONFLICT', 'REQUEST_TOO_LARGE'].includes(String(candidate))
    ? 'HISTORY_REJECTED' : 'HISTORY_DELIVERY_FAILED';
}

function validateConfig(config: RecoveryConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (key === 'instanceId' || key === 'workerId') continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > timerLimit) throw safeError('INVALID_RECOVERY_CONFIG');
  }
  assertDto('BoundedId', config.instanceId);
  assertDto('BoundedId', config.workerId);
}

/**
 * Создаёт lifecycle recovery, pump и history delivery; порты должны иметь конечные control timeouts.
 * Восстановление сбрасывает буферы только безопасно при одном активном coordinator instance.
 */
export function createRecoveryController(options: ControllerOptions) {
  const { helper, history, clearVolatileResults, config } = options;
  validateConfig(config);
  let initialized = false;
  let stopping = false;
  let started = false;
  let recoveryAvailable = false;
  let historyAvailable = true;
  let historyRejected = false;
  let initialization: Promise<void> | null = null;
  let pumpLoop: Promise<void> | null = null;
  let recoveryLoop: Promise<void> | null = null;
  let historyLoop: Promise<void> | null = null;
  const delays = new Map<ReturnType<typeof setTimeout>, () => void>();

  function pause(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { delays.delete(timer); resolve(); }, ms);
      delays.set(timer, resolve);
    });
  }

  function wakeDelays(): void {
    for (const [timer, resolve] of delays) {
      clearTimeout(timer);
      delays.delete(timer);
      resolve();
    }
  }

  async function callHelper<T>(method: HelperMethod, params: unknown): Promise<T> {
    const pair = methodMap.helper[method];
    if (!pair) throw safeError('HELPER_METHOD_UNAVAILABLE');
    try { assertDto(pair[0], params); } catch { throw safeError('INVALID_HELPER_PARAMS'); }
    const raw = await helper.call(method, params);
    try { return assertDto(pair[1], raw) as T; } catch { throw safeError('INVALID_HELPER_RESULT'); }
  }

  async function runRecoveryCycle(): Promise<void> {
    const deadline = performance.now() + config.recoveryCycleTimeoutMs;
    let counts = zeroCounts();
    for (let batch = 0; batch < config.recoveryMaxBatches; batch += 1) {
      if (stopping) throw safeError('RECOVERY_INTERRUPTED');
      const result = await callHelper<RecoveryCounts>('recovery.run', { coordinatorInstanceId: config.instanceId });
      counts = result;
      if (!hasChanges(counts)) {
        recoveryAvailable = true;
        return;
      }
      if (batch + 1 >= config.recoveryMaxBatches || performance.now() >= deadline) break;
      await pause(0); // Yield between bounded SQL batches; no competing recovery call starts.
    }
    recoveryAvailable = false;
    throw safeError(hasChanges(counts) ? 'RECOVERY_INCOMPLETE' : 'RECOVERY_UNAVAILABLE');
  }

  async function initializeOnce(): Promise<void> {
    if (initialized) return;
    if (stopping) throw safeError('RECOVERY_INTERRUPTED');
    try {
      clearVolatileResults();
      await runRecoveryCycle();
      if (stopping) throw safeError('RECOVERY_INTERRUPTED');
      initialized = true;
    } catch {
      recoveryAvailable = false;
      initialized = false;
      throw safeError('RECOVERY_UNAVAILABLE');
    }
  }

  /** Запускает volatile cleanup и helper recovery до нулевого batch; при ошибке coordinator не готов. */
  function initialize(): Promise<void> {
    if (!initialization) initialization = initializeOnce();
    return initialization;
  }

  async function recoverLoop(): Promise<void> {
    while (!stopping) {
      await pause(config.recoveryPollIntervalMs);
      if (stopping) break;
      try { await runRecoveryCycle(); } catch { recoveryAvailable = false; }
    }
  }

  async function drainHistoryCycle(): Promise<number> {
    let delivered = 0;
    for (let index = 0; index < config.historyMaxDeliveries && !stopping; index += 1) {
      const claim = await callHelper<HistoryClaim | null>('history.claim', { workerId: config.workerId });
      if (claim === null) {
        historyAvailable = !historyRejected;
        return delivered;
      }
      try {
        // Повторяет тот же владелец envelope с исходными id/data; адаптер задаёт trusted append subject.
        await history.append(claim.event);
      } catch (error) {
        historyAvailable = false;
        const errorCode = deliveryErrorCode(error);
        if (errorCode === 'HISTORY_REJECTED') historyRejected = true;
        try {
          const failed = await callHelper<{ failed: boolean }>('history.fail', { deliveryId: claim.deliveryId, claimToken: claim.claimToken, errorCode });
          if (!failed.failed) historyAvailable = false;
        } catch {
          // Lease истечёт; новый claim повторит стабильное событие, не вычисление.
        }
        return delivered;
      }
      try {
        const ack = await callHelper<{ acknowledged: boolean }>('history.ack', { deliveryId: claim.deliveryId, claimToken: claim.claimToken });
        if (!ack.acknowledged) {
          historyAvailable = false;
          return delivered;
        }
        delivered += 1;
      } catch {
        // Потерянный/stale ack оставляет event для lease replay; не подменяем его новым DTO.
        historyAvailable = false;
        return delivered;
      }
    }
    return delivered;
  }

  async function historyDeliveryLoop(): Promise<void> {
    while (!stopping) {
      try { await drainHistoryCycle(); } catch { historyAvailable = false; }
      if (!stopping) await pause(config.historyPollIntervalMs);
    }
  }

  async function dispatchLoopFor(pumpOnce: () => Promise<unknown>): Promise<void> {
    while (!stopping) {
      try { await pumpOnce(); } catch { /* Следующий bounded tick повторяет только claim flow; intent защищает compute. */ }
      if (!stopping) await pause(config.pumpPollIntervalMs);
    }
  }

  /** Запускает независимые serial loops только после полного начального recovery. */
  function start(pumpOnce: () => Promise<unknown>): void {
    if (!initialized || stopping || started) throw safeError('RECOVERY_NOT_READY');
    started = true;
    pumpLoop = dispatchLoopFor(pumpOnce);
    recoveryLoop = recoverLoop();
    historyLoop = historyDeliveryLoop();
  }

  /** Останавливает новые claims/ticks и ждёт завершения уже начатых port calls. */
  async function close(): Promise<void> {
    stopping = true;
    wakeDelays();
    await initialization?.catch(() => undefined);
    await Promise.all([pumpLoop, recoveryLoop, historyLoop].filter((loop): loop is Promise<void> => loop !== null));
  }

  function status(): RecoveryStatus {
    const ready = initialized && !stopping && recoveryAvailable && historyAvailable;
    return { ready, recoveryAvailable: recoveryAvailable && !stopping, historyAvailable: historyAvailable && !stopping };
  }

  return Object.freeze({
    initialize,
    start,
    close,
    status,
    get ready() { return status().ready; },
  });
}
