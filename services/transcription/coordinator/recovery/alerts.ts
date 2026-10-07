// ABOUTME: Доставляет устойчивую очередь и объединяет общие сбои в эпизоды.
// ABOUTME: Отказ helper имеет ограниченный fallback в памяти; compute и история не повторяются.
import { randomUUID } from 'node:crypto';
import { assertDto } from '#transcription-contracts';
import { incidentEvent, incidentKeys, type IncidentKey } from '../../notifications.js';
type State = { available: boolean; event: any | null; recorded: boolean; sent: boolean; dirty: boolean; version: number };
type Options = {
  helper: { call(method: string, params: unknown): Promise<unknown> };
  publish: (event: unknown) => Promise<void>;
  workerId: string; pollIntervalMs: number;
};

/** Последовательная доставка с конечными port timeouts; ошибки не выходят в compute. */
export function createAlertsController(options: Options) {
  if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0 || options.pollIntervalMs > 2147483647) throw new Error('INVALID_ALERTS_CONFIG');
  const states = new Map<IncidentKey, State>();
  let stopping = false;
  let loop: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let retries = 0;
  let deliveryAvailable = true;
  let fallbackNextAttemptAt = 0;
  let fallbackRetries = 0;
  let cycle: Promise<void> | undefined;
  function observe(key: IncidentKey, available: boolean): void {
    if (stopping) return;
    const old = states.get(key);
    if (old?.available === available) return;
    const event = available ? old?.event ?? null : old?.event ?? incidentEvent(key, randomUUID(), new Date().toISOString());
    if (old) { old.available = available; old.event = event; old.dirty = true; old.version += 1; }
    else states.set(key, { available, event, recorded: false, sent: false, dirty: true, version: 1 });
  }
  async function call(method: string, params: unknown): Promise<any> {
    const result = await options.helper.call(method, params);
    if (method !== 'alerts.observe') observe('storage', true);
    return result;
  }
  async function flushIncidents(): Promise<void> {
    for (const key of incidentKeys) {
      const state = states.get(key);
      if (!state?.dirty) continue;
      try {
        if (state.event && !state.recorded) {
          const result = assertDto('AlertObserveResult', await call('alerts.observe', {
            key, available: false, eventId: state.event.id, occurredAt: state.event.occurred_at,
          })) as any;
          if (!result.event) throw new Error('INVALID_ALERT_OBSERVATION');
          state.event = result.event; state.recorded = true;
        }
        if (state.available) {
          const version = state.version;
          await call('alerts.observe', { key, available: true });
          if (state.version === version) {
            state.event = null; state.recorded = false; state.sent = false; state.dirty = false;
          } else {
            state.event = incidentEvent(key, randomUUID(), new Date().toISOString());
            state.recorded = false; state.sent = false; state.dirty = true;
          }
        } else if (states.get(key) === state) state.dirty = false;
      } catch {
        observe('storage', false);
        // AIDEV-NOTE: Только при отказе helper допускается memory fallback с последующим сохранением того же ID.
        if (state.event && !state.recorded && !state.sent && Date.now() >= fallbackNextAttemptAt) {
          try {
            await options.publish(state.event); state.sent = true;
            fallbackNextAttemptAt = 0; fallbackRetries = 0; deliveryAvailable = true; observe('delivery', true);
          } catch {
            fallbackNextAttemptAt = Date.now() + Math.min(1000 * 2 ** Math.min(fallbackRetries++, 5), 30000);
            deliveryAvailable = false; observe('delivery', false);
          }
        }
      }
    }
  }
  async function tickOnce(): Promise<void> {
    await flushIncidents();
    let claim: any;
    try { claim = assertDto('AlertClaimResult', await call('alerts.claim', { workerId: options.workerId })); }
    catch { observe('storage', false); return; }
    if (!claim) return;
    try {
      await options.publish(claim.event);
      deliveryAvailable = true; observe('delivery', true); retries = 0;
    } catch {
      deliveryAvailable = false; observe('delivery', false);
      const retryDelayMs = Math.min(1000 * 2 ** Math.min(retries++, 5), 30000);
      try { await call('alerts.fail', { deliveryId: claim.deliveryId, claimToken: claim.claimToken, retryDelayMs }); }
      catch { observe('storage', false); }
      return;
    }
    try { assertDto('AlertAckResult', await call('alerts.ack', { deliveryId: claim.deliveryId, claimToken: claim.claimToken })); }
    catch {
      // Потерянный ack оставляет тот же event для lease replay, не запускает compute.
      observe('storage', false);
    }
  }
  function tick(): Promise<void> {
    if (stopping) return Promise.resolve();
    if (!cycle) cycle = tickOnce().finally(() => { cycle = undefined; });
    return cycle;
  }
  function pause(): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { wake = undefined; resolve(); }, options.pollIntervalMs);
      wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
    });
  }
  function start(): void {
    if (loop || stopping) return;
    loop = (async () => {
      while (!stopping) {
        await tick().catch(() => { deliveryAvailable = false; });
        if (!stopping) await pause();
      }
    })();
  }
  async function close(): Promise<void> {
    stopping = true; wake?.(); await loop; await cycle;
    await flushIncidents();
  }
  return { observe, tick, start, close, status: () => ({ alertsAvailable: deliveryAvailable }) };
}
