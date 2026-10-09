// ABOUTME: Управляет модельными процессами, конечной очередью, сроками, отменой и idle ресурсами.
// ABOUTME: Слот и временные артефакты освобождаются только после фактического завершения runtime-вызова или процесса.
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { LocalAiError } from '../errors.js';
import type { ArtifactPort, HistoryFactPort, LocalAiStore, ModelIdleGuard, ModelSettingsChangedPort, RuntimeFactory, RuntimePort } from '../ports.js';
import type {
  EmbeddingItem, RuntimeEmbeddingItem, EmbedOutput, InstallationRecord, LocalAiHistoryMetadataEvent, ModelRecord, ModelSelector,
  ModelSettings, OperationContext, RuntimeState, ServiceErrorCode, TranscribeOutput,
} from '../types.js';

const MAX_TIMEOUT_MS = 2_147_483_647;

type CommonInvocation = { requestId: string; operationId: string; model: ModelSelector; ownerId: string; deadlineAt: string };
export type EmbedInvocation = CommonInvocation & { operation: 'embed'; texts?: readonly string[]; inputs?: readonly EmbeddingItem[]; purpose: 'query' | 'document' | 'symmetric' };
export type TranscribeInvocation = CommonInvocation & { operation: 'transcribe'; audioArtifactId: string };
export type Invocation = EmbedInvocation | TranscribeInvocation;
export type InvocationResult =
  | { operation: 'embed'; model: ModelSelector; vectors: readonly (readonly number[])[]; durationMs: number }
  | { operation: 'transcribe'; model: ModelSelector; text: string; segments: TranscribeOutput['segments'] | null; durationMs: number };
export type LifecycleLimits = {
  maxLoadedModels: number;
  maxQueuedOperations: number;
  maxInputBytes: number;
  maxEmbeddingItems: number;
  maxResultBytes: number;
  loadDeadlineMs: number;
};
export type LifecycleManagerOptions = {
  store: LocalAiStore;
  history?: HistoryFactPort;
  runtimeFactory: RuntimeFactory;
  artifacts: ArtifactPort;
  limits: LifecycleLimits;
  now?: () => number;
};
export type LifecycleStatus = {
  accepting: boolean; loaded: number; loading: number; ready: number; unloading: number;
  active: number; queued: number; models: Readonly<Record<string, RuntimeState>>;
};
export type LifecycleManager = ModelIdleGuard & ModelSettingsChangedPort & {
  /** Удерживает модель без новых invoke/load/remove до явного освобождения после установки. */
  acquireModelIdleLock(modelId: string): Promise<() => void>;
  refreshModel(modelId: string): Promise<void>;
  invoke(input: Invocation, context: OperationContext): Promise<InvocationResult>;
  cancel(ownerId: string, operationId: string): Promise<'cancellation_requested' | 'already_terminal' | 'not_found'>;
  load(selector: ModelSelector, context: OperationContext): Promise<void>;
  unload(selector: ModelSelector, context: OperationContext): Promise<void>;
  readRuntimeState(modelId: string, revision: string): RuntimeState | null;
  status(): LifecycleStatus;
  close(): Promise<void>;
};

type Job = {
  input: Invocation; context: OperationContext; controller: AbortController; done: Promise<InvocationResult>;
  resolve: (value: InvocationResult) => void; reject: (error: unknown) => void; state: 'preparing' | 'queued' | 'active' | 'settled';
  acceptedAt: number; inputBytes: number; record?: ModelRecord;
  runtime?: RuntimePort; audioPath?: string; embeddingInputs?: RuntimeEmbeddingItem[]; abortListener: () => void; deadlineTimer?: NodeJS.Timeout; failure?: LocalAiError;
};
type Slot = {
  selector: ModelSelector; state: RuntimeState; runtime?: RuntimePort; generation: number; opening?: Promise<RuntimePort>;
  loadController?: AbortController; closing?: Promise<void>; closingExpected: boolean; activeJob?: Job; queue: Job[];
  idleSince?: number; idleTimer?: NodeJS.Timeout; settings: ModelSettings; lastError?: RuntimeState; managementWaiters: number;
};

type Prepared = { record: ModelRecord; installation: InstallationRecord; settings: ModelSettings };

function fail(code: ServiceErrorCode, message: string = code): never {
  throw new LocalAiError(code, message, code === 'BUSY' || code === 'DEPENDENCY_UNAVAILABLE' || code === 'ENGINE_UNAVAILABLE');
}
function selectorKey(selector: ModelSelector): string { return `${selector.modelId}\u0000${selector.revision}\u0000${selector.profileId}`; }
function validateContext(input: Invocation, context: OperationContext): void {
  if (input.ownerId !== context.ownerId || input.operationId !== context.operationId || input.deadlineAt !== context.deadlineAt) fail('INVALID_ARGUMENT');
  const deadline = Date.parse(input.deadlineAt);
  if (!Number.isFinite(deadline)) fail('INVALID_ARGUMENT');
  if (deadline <= Date.now()) fail('DEADLINE_EXCEEDED');
}
function event(input: Invocation, outcome: LocalAiHistoryMetadataEvent['data']['outcome'], options: {
  id: string; now: string; durationMs?: number; errorCode?: ServiceErrorCode;
}): LocalAiHistoryMetadataEvent {
  return {
    id: options.id, type_id: 1201, occurred_at: options.now, actor_id: input.ownerId,
    scope_type: 'user', scope_id: input.ownerId, object_type: 'operation', object_id: input.operationId,
    data: {
      operation: 'invoke', modelId: input.model.modelId, outcome, revision: input.model.revision,
      profileId: input.model.profileId, operationId: input.operationId, requestId: input.requestId,
      ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
      ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    },
  };
}
function managementEvent(selector: ModelSelector, operation: 'load' | 'unload', actorId: string, operationId: string, outcome: 'succeeded' | 'failed' | 'cancelled', errorCode?: ServiceErrorCode, id: string = randomUUID()): LocalAiHistoryMetadataEvent {
  return {
    id, type_id: operation === 'load' ? 203 : 204, occurred_at: new Date().toISOString(),
    actor_id: actorId, scope_type: 'system', scope_id: 'local_ai', object_type: 'model', object_id: selector.modelId,
    data: { operation, modelId: selector.modelId, outcome, revision: selector.revision, profileId: selector.profileId,
      operationId, ...(errorCode ? { errorCode } : {}) },
  };
}
function errorFrom(error: unknown): LocalAiError {
  if (error instanceof LocalAiError) return error;
  return new LocalAiError('ENGINE_UNAVAILABLE', 'ENGINE_UNAVAILABLE', true);
}
function resultBytes(value: unknown): number {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { fail('ENGINE_UNAVAILABLE'); }
  return Buffer.byteLength(serialized!, 'utf8');
}
function finiteLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_ARGUMENT', `INVALID_${name.toUpperCase()}`);
}

/** Создаёт lifecycle manager с явными конечными пределами и зависимостями к хранилищу/исполнителям. */
export function createLifecycleManager(options: LifecycleManagerOptions): LifecycleManager {
  const { store, runtimeFactory, artifacts, limits } = options;
  function publish(fact: LocalAiHistoryMetadataEvent): void {
    try { options.history?.publish(fact); } catch { /* История не меняет итог операции. */ }
  }
  function finishManagement(selector: ModelSelector, operation: 'load' | 'unload', context: OperationContext, outcome: 'succeeded' | 'failed' | 'cancelled', startedAt: number, errorCode?: ServiceErrorCode): void {
    const fact = managementEvent(selector, operation, context.ownerId, context.operationId, outcome, errorCode);
    fact.data.durationMs = Math.max(0, Math.floor(now() - startedAt));
    publish(fact);
  }
  for (const [name, value] of Object.entries(limits)) finiteLimit(value, name);
  const now = options.now ?? Date.now;
  const slots = new Map<string, Slot>();
  const operations = new Map<string, Job>();
  const lockedModels = new Set<string>();
  let accepting = true;
  let outstanding = 0;
  let allocationTail: Promise<void> = Promise.resolve();
  const pendingAdmissions = new Map<string, number>();
  const metadata = new Map<string, Prepared>();
  const configuredSettings = new Map<string, ModelSettings>();
  const refreshing = new Map<string, Promise<void>>();
  const pendingLifecycleTasks = new Set<Promise<void>>();
  let active = 0;
  let queued = 0;
  let closePromise: Promise<void> | undefined;

  function beginPendingTask(): () => void {
    let resolve!: () => void;
    const task = new Promise<void>(done => { resolve = done; });
    pendingLifecycleTasks.add(task);
    return () => { pendingLifecycleTasks.delete(task); resolve(); };
  }

  function stateOf(slot: Slot): RuntimeState {
    if (slot.state === 'error') return 'error';
    if (slot.closing) return slot.lastError === 'error' ? 'error' : 'unloading';
    if (slot.runtime) return 'ready';
    return slot.state;
  }
  function clearTimer(slot: Slot): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
  }
  async function allocationLock<T>(run: () => Promise<T>): Promise<T> {
    const previous = allocationTail;
    let release!: () => void;
    allocationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await run(); } finally { release(); }
  }
  function validateSelector(selector: ModelSelector): void {
    if (!selector || typeof selector.modelId !== 'string' || !selector.modelId || typeof selector.revision !== 'string' || !selector.revision
      || typeof selector.profileId !== 'string' || !selector.profileId) fail('INVALID_ARGUMENT');
  }
  function slotFor(selector: ModelSelector): Slot {
    const key = selector.modelId;
    const existing = slots.get(key);
    if (existing) {
      if (selectorKey(existing.selector) !== selectorKey(selector)) fail('MODEL_IN_USE');
      return existing;
    }
    const slot: Slot = { selector: { ...selector }, state: 'unloaded', generation: 0, closingExpected: false, queue: [], settings: { idleUnloadSeconds: 600 }, managementWaiters: 0 };
    slots.set(key, slot);
    return slot;
  }
  async function refreshModel(modelId: string): Promise<void> {
    // AIDEV-NOTE: Сначала сбрасываем snapshot: ошибка обновления не должна выдавать старую установку.
    metadata.delete(modelId);
    const update = store.transaction(async tx => {
      const record = await tx.models.get(modelId);
      if (!record) return undefined;
      const installation = await tx.installations.get(record.modelId, record.revision);
      if (!installation) return undefined;
      return { record, installation, settings: await tx.settings.get(modelId) ?? { idleUnloadSeconds: 600 } };
    }).then(value => { if (refreshing.get(modelId) === update && value) {
      const snapshot = structuredClone(value);
      snapshot.settings = configuredSettings.get(modelId) ?? snapshot.settings;
      metadata.set(modelId, snapshot);
    } });
    refreshing.set(modelId, update);
    try { await update; } finally { if (refreshing.get(modelId) === update) refreshing.delete(modelId); }
  }
  async function prepare(selector: ModelSelector, operation?: 'embed' | 'transcribe'): Promise<Prepared> {
    validateSelector(selector);
    if (refreshing.has(selector.modelId)) await refreshing.get(selector.modelId);
    if (!metadata.has(selector.modelId)) {
      const existing = refreshing.get(selector.modelId);
      if (existing) await existing; else await refreshModel(selector.modelId);
    }
    const prepared = metadata.get(selector.modelId);
    if (!prepared) {
      // AIDEV-NOTE: Отсутствие snapshot относится к подготовке модели; прогретый путь сюда не попадает.
      const model = await store.transaction(tx => tx.models.get(selector.modelId));
      if (!model) fail('MODEL_NOT_FOUND');
      if (!model.supported || !model.profileId) fail('NOT_SUPPORTED');
      if (model.revision !== selector.revision || model.profileId !== selector.profileId) fail('REVISION_CONFLICT');
      fail('MODEL_NOT_INSTALLED');
    }
    const { record: model, installation } = prepared;
    if (!model.supported || model.profileId === null) fail('NOT_SUPPORTED');
    if (model.revision !== selector.revision || model.profileId !== selector.profileId) fail('REVISION_CONFLICT');
    if (operation && !model.operations.includes(operation)) fail('UNSUPPORTED_OPERATION');
    if (installation.profileId !== model.profileId || installation.modelId !== model.modelId || installation.revision !== model.revision) fail('REVISION_CONFLICT');
    return prepared;
  }
  function assertInput(input: Invocation, model: ModelRecord, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limits.maxInputBytes || model.limits.maxInputBytes !== null && bytes > model.limits.maxInputBytes) fail('INPUT_TOO_LARGE');
    if (input.operation === 'embed') {
      if ((input.texts === undefined) === (input.inputs === undefined)) fail('INVALID_ARGUMENT');
      const items = input.inputs ?? input.texts?.map(text => ({ type: 'text' as const, text })) ?? [];
      if (!Array.isArray(items) || items.length < 1 || items.length > limits.maxEmbeddingItems
        || model.limits.maxItems !== null && items.length > model.limits.maxItems) fail('INVALID_ARGUMENT');
      for (const item of items) {
        if (!item || !model.inputKinds.includes(item.type)) fail('UNSUPPORTED_OPERATION');
        if (item.type === 'text' ? typeof item.text !== 'string' : typeof item.artifactId !== 'string') fail('INVALID_ARGUMENT');
      }
      if (!['query', 'document', 'symmetric'].includes(input.purpose)) fail('INVALID_ARGUMENT');
      const dimensions = model.limits.vectorDimensions;
      if (dimensions !== null && (input.inputs?.length ?? input.texts!.length) * dimensions * 8 > limits.maxResultBytes) fail('RESULT_TOO_LARGE');
    }
  }
  function createJob(input: Invocation, context: OperationContext): Job {
    let resolve!: (value: InvocationResult) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<InvocationResult>((yes, no) => { resolve = yes; reject = no; });
    const job: Job = { input, context, controller: new AbortController(), done, resolve, reject, state: 'preparing', acceptedAt: now(), inputBytes: 0, abortListener: () => undefined };
    job.abortListener = () => {
      if (!job.controller.signal.aborted) job.controller.abort(context.signal.reason);
      const slot = slots.get(input.model.modelId);
      if (job.state === 'queued' && slot) {
        const index = slot.queue.indexOf(job);
        if (index >= 0) { slot.queue.splice(index, 1); queued--; }
        void complete(job, 'cancelled', undefined, contextOutcome(job) ?? new LocalAiError('CANCELLED', 'CANCELLED'));
      }
      if (slot?.activeJob === job && job.runtime) void stopForCancellation(slot, job);
      else if (slot?.opening && !slotHasWaiter(slot, job)) slot.loadController?.abort();
    };
    operations.set(input.operationId, job);
    if (context.signal.aborted) job.abortListener();
    else context.signal.addEventListener('abort', job.abortListener, { once: true });
    return job;
  }
  function operationContext(job: Job): OperationContext {
    return { ownerId: job.input.ownerId, operationId: job.input.operationId, deadlineAt: job.input.deadlineAt, signal: job.controller.signal };
  }
  function startDeadline(job: Job): void {
    const tick = () => {
      const left = Date.parse(job.input.deadlineAt) - now();
      if (left <= 0) {
        job.failure = new LocalAiError('DEADLINE_EXCEEDED', 'DEADLINE_EXCEEDED');
        job.abortListener();
        return;
      }
      job.deadlineTimer = setTimeout(tick, Math.min(left, MAX_TIMEOUT_MS));
    };
    tick();
  }
  async function complete(job: Job, outcome: 'succeeded' | 'failed' | 'cancelled', result?: InvocationResult, error?: LocalAiError): Promise<void> {
    if (job.state === 'settled') return;
    job.state = 'settled';
    if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
    job.context.signal.removeEventListener('abort', job.abortListener);
    operations.delete(job.input.operationId);
    outstanding--;
    publish(event(job.input, outcome, { id: randomUUID(), now: new Date(now()).toISOString(),
      durationMs: Math.max(0, Math.floor(now() - job.acceptedAt)), ...(error ? { errorCode: error.code } : {}) }));
    if (error) job.reject(error);
    else job.resolve(result!);
  }
  function contextOutcome(job: Job): LocalAiError | undefined {
    if (job.failure) return job.failure;
    if (Date.parse(job.input.deadlineAt) <= now()) return new LocalAiError('DEADLINE_EXCEEDED', 'DEADLINE_EXCEEDED');
    if (job.controller.signal.aborted) return new LocalAiError('CANCELLED', 'CANCELLED');
    return undefined;
  }
  async function stopForCancellation(slot: Slot, job: Job): Promise<void> {
    const runtime = job.runtime;
    if (!runtime) return;
    try { await closeSlot(slot, runtime); }
    catch { /* Ошибка stop не подтверждает физический выход. */ }
    await runtime.exited;
  }
  async function closeSlot(slot: Slot, runtime = slot.runtime): Promise<void> {
    if (!runtime) return;
    if (slot.closing) return slot.closing;
    const generation = slot.generation;
    slot.closingExpected = true;
    clearTimer(slot);
    slot.state = 'unloading';
    slot.closing = (async () => {
      try {
        await runtime.close();
        await runtime.exited;
      } catch (error) {
        slot.lastError = 'error';
        slot.state = 'error';
        // Keep the slot unavailable; release it only if the process group later proves fully gone.
        void runtime.exited.then(() => {
          if (slot.generation !== generation || slot.runtime !== runtime) return;
          slot.runtime = undefined;
          slot.closing = undefined;
          slot.closingExpected = false;
          slot.state = 'unloaded';
          slot.idleSince = undefined;
        });
        throw error;
      }
      if (slot.runtime === runtime) slot.runtime = undefined;
      slot.closing = undefined;
      slot.closingExpected = false;
      slot.state = 'unloaded';
      slot.idleSince = undefined;
    })();
    return slot.closing;
  }
  function actualIdle(slot: Slot): boolean {
    return slot.activeJob === undefined && slot.queue.length === 0 && slot.managementWaiters === 0 && !slot.opening && !slot.closing && Boolean(slot.runtime);
  }
  function armIdle(slot: Slot): void {
    clearTimer(slot);
    if (!actualIdle(slot) || slot.settings.idleUnloadSeconds === null || slot.idleSince === undefined) return;
    const target = slot.idleSince + slot.settings.idleUnloadSeconds * 1000;
    const tick = () => {
      if (!actualIdle(slot) || slot.settings.idleUnloadSeconds === null || slot.idleSince === undefined) return;
      const left = target - now();
      if (left > 0) { slot.idleTimer = setTimeout(tick, Math.min(left, MAX_TIMEOUT_MS)); return; }
      void closeSlot(slot).catch(() => undefined);
    };
    tick();
  }
  function wakeIdle(slot: Slot): void {
    clearTimer(slot);
    slot.idleSince = undefined;
  }
  function slotHasWaiter(slot: Slot, except?: Job): boolean {
    return slot.queue.some(job => job !== except) || Boolean(slot.activeJob && slot.activeJob !== except) || slot.managementWaiters > 0;
  }
  async function makeRoom(forSlot: Slot): Promise<void> {
    const loaded = [...slots.values()].filter(slot => slot !== forSlot && (slot.runtime || slot.state === 'loading')).length;
    if (loaded < limits.maxLoadedModels) return;
    const idle = [...slots.values()].filter(slot => actualIdle(slot) && !lockedModels.has(slot.selector.modelId)).sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0))[0];
    if (idle) { await closeSlot(idle); return; }
    fail('BUSY');
  }
  async function ensureRuntime(slot: Slot): Promise<RuntimePort> {
    if (slot.closing) await slot.closing;
    if (slot.runtime) return slot.runtime;
    if (slot.opening) return slot.opening;
    const generation = ++slot.generation;
    const controller = new AbortController();
    slot.loadController = controller;
    const loadContext: OperationContext = {
      ownerId: 'local_ai', operationId: randomUUID(), deadlineAt: new Date(now() + limits.loadDeadlineMs).toISOString(), signal: controller.signal,
    };
    const opening = allocationLock(async () => {
      slot.state = 'loading';
      await makeRoom(slot);
      if (controller.signal.aborted || generation !== slot.generation) throw new LocalAiError('MODEL_LOAD_FAILED', 'LOAD_GENERATION_SUPERSEDED');
      const prepared = await prepare(slot.selector);
      const runtime = await runtimeFactory.open({ model: slot.selector, installation: prepared.installation }, loadContext);
      if (generation !== slot.generation || controller.signal.aborted) {
        try { await runtime.close(); } catch { /* wait for the real exit before releasing the generation */ }
        await runtime.exited;
        throw new LocalAiError('MODEL_LOAD_FAILED', 'LOAD_GENERATION_SUPERSEDED');
      }
      slot.runtime = runtime;
      slot.state = 'ready';
      void runtime.exited.then(() => {
        if (slot.generation !== generation || slot.runtime !== runtime || slot.closingExpected) return;
        slot.runtime = undefined;
        slot.state = 'error';
        slot.lastError = 'error';
        const job = slot.activeJob;
        if (job) {
          job.failure = new LocalAiError('ENGINE_UNAVAILABLE', 'ENGINE_UNAVAILABLE', true);
          job.controller.abort();
        }
      });
      return runtime;
    });
    slot.opening = opening;
    void opening.then(() => {
      if (slot.generation === generation) { slot.opening = undefined; slot.loadController = undefined; }
    }, () => {
      if (slot.generation === generation) {
        slot.opening = undefined;
        slot.loadController = undefined;
        slot.state = 'error';
        slot.lastError = 'error';
      }
    });
    return opening;
  }
  async function runJob(slot: Slot, job: Job): Promise<void> {
    let result: InvocationResult | undefined;
    let failure: LocalAiError | undefined;
    try {
      const beforeLoad = contextOutcome(job);
      if (beforeLoad) throw beforeLoad;
      const runtime = await ensureRuntime(slot);
      const interrupted = contextOutcome(job);
      if (interrupted) throw interrupted;
      // AIDEV-NOTE: Отменённый waiter не владеет общей загрузкой и не останавливает чужой runtime.
      job.runtime = runtime;
      const callContext = operationContext(job);
      if (job.input.operation === 'embed') {
        const output: EmbedOutput = await runtime.embed({ model: job.input.model, ...(job.input.inputs ? { inputs: job.embeddingInputs! } : { texts: job.input.texts! }), purpose: job.input.purpose }, callContext);
        const dimensions = job.record!.limits.vectorDimensions;
        if (!Array.isArray(output.vectors) || output.vectors.length !== (job.input.inputs?.length ?? job.input.texts!.length)
          || output.vectors.some(vector => !Array.isArray(vector) || dimensions !== null && vector.length !== dimensions
            || !vector.every(value => typeof value === 'number' && Number.isFinite(value)))) fail('ENGINE_UNAVAILABLE');
        result = { operation: 'embed', model: job.input.model, vectors: output.vectors, durationMs: Math.max(0, Math.floor(now() - job.acceptedAt)) };
      } else {
        const audioPath = job.audioPath;
        if (!audioPath) fail('ARTIFACT_NOT_AVAILABLE');
        let output: TranscribeOutput;
        try { output = await runtime.transcribe({ model: job.input.model, audioPath }, callContext); }
        catch (error) {
          if (job.controller.signal.aborted && slot.runtime === runtime) await closeSlot(slot, runtime);
          throw error;
        }
        result = { operation: 'transcribe', model: job.input.model, text: output.text, segments: output.segments ?? null, durationMs: Math.max(0, Math.floor(now() - job.acceptedAt)) };
      }
      const payload = result.operation === 'embed' ? result.vectors : { text: result.text, segments: result.segments };
      const size = resultBytes(payload);
      if (size > limits.maxResultBytes || job.record!.limits.maxResultBytes != null && size > job.record!.limits.maxResultBytes || result.operation === 'embed' && result.vectors.some(vector => vector.length * 8 > limits.maxResultBytes)) fail('RESULT_TOO_LARGE');
      const end = contextOutcome(job);
      if (end) throw end;
    } catch (error) {
      failure = contextOutcome(job) ?? errorFrom(error);
    } finally {
      if (job.runtime && slot.runtime === job.runtime && (job.controller.signal.aborted || failure?.code === 'ENGINE_UNAVAILABLE')) {
        // Aborting a client request does not prove inference stopped; terminate and await the real child exit.
        await stopForCancellation(slot, job);
      }
      job.runtime = undefined;
    }
    if (failure) await complete(job, failure.code === 'CANCELLED' || failure.code === 'DEADLINE_EXCEEDED' ? 'cancelled' : 'failed', undefined, failure);
    else await complete(job, 'succeeded', result);
  }
  function drain(slot: Slot): void {
    if (slot.activeJob || lockedModels.has(slot.selector.modelId) || !accepting && slot.queue.length === 0) return;
    const job = slot.queue.shift();
    if (!job) return;
    queued--;
    active++;
    job.state = 'active';
    slot.activeJob = job;
    wakeIdle(slot);
    void runJob(slot, job).finally(() => {
      if (slot.activeJob === job) slot.activeJob = undefined;
      active--;
      if (slot.queue.length) drain(slot);
      else {
        slot.idleSince = now();
        armIdle(slot);
      }
    });
  }
  function failQueue(slot: Slot): void {
    const pending = slot.queue.splice(0);
    queued -= pending.length;
    for (const job of pending) {
      job.failure = contextOutcome(job) ?? new LocalAiError('CANCELLED', 'CANCELLED');
      void complete(job, job.failure.code === 'CANCELLED' || job.failure.code === 'DEADLINE_EXCEEDED' ? 'cancelled' : 'failed', undefined, job.failure);
    }
  }
  function accept(input: Invocation, context: OperationContext): Job {
    validateContext(input, context);
    if (!accepting) fail('BUSY');
    if (lockedModels.has(input.model.modelId)) fail('MODEL_IN_USE');
    if (outstanding >= limits.maxQueuedOperations) fail('BUSY');
    if (operations.has(input.operationId)) fail('REVISION_CONFLICT');
    validateSelector(input.model);
    outstanding++;
    pendingAdmissions.set(input.model.modelId, (pendingAdmissions.get(input.model.modelId) ?? 0) + 1);
    const job = createJob(input, context);
    if (!context.deadlineManaged) startDeadline(job);
    return job;
  }
  function resultForCaller(job: Job): Promise<InvocationResult> {
    if (job.controller.signal.aborted) return Promise.reject(contextOutcome(job));
    let abort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(contextOutcome(job) ?? new LocalAiError('CANCELLED', 'CANCELLED'));
      job.controller.signal.addEventListener('abort', abort, { once: true });
    });
    return Promise.race([job.done, interrupted]).finally(() => job.controller.signal.removeEventListener('abort', abort));
  }

  const manager: LifecycleManager = {
    refreshModel,
    async invoke(input, context) {
      const job = accept(input, context);
      const caller = resultForCaller(job);
      void job.done.catch(() => undefined);
      const task = (async () => {
        let queuedJob = false;
        try {
          const prepared = await prepare(input.model, input.operation);
          job.record = prepared.record;
          job.inputBytes = input.operation === 'embed' ? Buffer.byteLength(JSON.stringify(input.inputs ?? input.texts), 'utf8') : 0;
          assertInput(input, prepared.record, job.inputBytes);
          const enqueue = async (audioPath?: string) => {
            const interrupted = contextOutcome(job);
            if (interrupted) throw interrupted;
            if (!accepting) fail('CANCELLED');
            const slot = slotFor(input.model);
            job.audioPath = audioPath;
            slot.settings = prepared.settings;
            job.state = 'queued';
            queuedJob = true;
            slot.queue.push(job);
            queued++;
            drain(slot);
            return job.done;
          };
          if (input.operation === 'embed') {
            const items = input.inputs ?? [];
            job.embeddingInputs = [];
            // AIDEV-NOTE: Вложенные callbacks удерживают все файлы до job.done и физического выхода runtime.
            const prepareItems = async (index: number): Promise<InvocationResult> => {
              if (index === items.length) return enqueue();
              const item = items[index]!;
              if (item.type === 'text') {
                job.embeddingInputs!.push(item);
                return prepareItems(index + 1);
              }
              if (!artifacts.withReadyMedia) fail('ARTIFACT_NOT_AVAILABLE');
              return artifacts.withReadyMedia({ artifactId: item.artifactId, ownerId: input.ownerId, operationId: input.operationId, kind: item.type }, operationContext(job), async media => {
                job.inputBytes += (await stat(media.localPath)).size;
                assertInput(input, prepared.record, job.inputBytes);
                job.embeddingInputs!.push({ type: item.type, localPath: media.localPath, mimeType: media.mimeType });
                return prepareItems(index + 1);
              });
            };
            await prepareItems(0);
          }
          else await artifacts.withReadyAudio({ artifactId: input.audioArtifactId, ownerId: input.ownerId, operationId: input.operationId }, operationContext(job), async audio => {
            try { job.inputBytes = (await stat(audio.localPath)).size; } catch { fail('ARTIFACT_NOT_AVAILABLE'); }
            assertInput(input, prepared.record, job.inputBytes);
            return enqueue(audio.localPath);
          });
        } catch (error) {
          if (!queuedJob) {
            const failure = contextOutcome(job) ?? errorFrom(error);
            await complete(job, failure.code === 'CANCELLED' || failure.code === 'DEADLINE_EXCEEDED' ? 'cancelled' : 'failed', undefined, failure);
          }
        } finally {
          const count = (pendingAdmissions.get(input.model.modelId) ?? 1) - 1;
          if (count) pendingAdmissions.set(input.model.modelId, count); else pendingAdmissions.delete(input.model.modelId);
        }
      })();
      pendingLifecycleTasks.add(task);
      void task.finally(() => pendingLifecycleTasks.delete(task));
      return caller;
    },
    async cancel(ownerId, operationId) {
      const job = operations.get(operationId);
      if (!job || job.input.ownerId !== ownerId) return 'not_found';
      if (job.state === 'settled') return 'already_terminal';
      job.failure = new LocalAiError('CANCELLED', 'CANCELLED');
      job.abortListener();
      const slot = slots.get(job.input.model.modelId);
      if (!slot) return 'cancellation_requested';
      if (job.state === 'queued') {
        const index = slot.queue.indexOf(job);
        if (index >= 0) { slot.queue.splice(index, 1); queued--; }
        await complete(job, 'cancelled', undefined, job.failure);
        if (slot.queue.length) drain(slot);
      } else if (slot.runtime) void stopForCancellation(slot, job);
      else if (slot.opening && !slotHasWaiter(slot, job)) slot.loadController?.abort();
      return 'cancellation_requested';
    },
    async load(selector, context) {
      const startedAt = now();
      const donePendingTask = beginPendingTask();
      try {
      validateSelector(selector);
      if (!accepting) fail('BUSY');
      if (context.signal.aborted) fail('CANCELLED');
      if (Date.parse(context.deadlineAt) <= now()) fail('DEADLINE_EXCEEDED');
      if (lockedModels.has(selector.modelId)) fail('MODEL_IN_USE');
      const prepared = await prepare(selector);
      if (lockedModels.has(selector.modelId)) fail('MODEL_IN_USE');
      const slot = slotFor(selector);
      slot.settings = prepared.settings;
      slot.managementWaiters++;
      try {
        if (!accepting) fail('CANCELLED');
        const runtime = await waitWithContext(ensureRuntime(slot), context);
        if (slot.runtime !== runtime) fail('MODEL_LOAD_FAILED');
        slot.idleSince = now();
        finishManagement(selector, 'load', context, 'succeeded', startedAt);
      } catch (error) {
        const local = errorFrom(error);
        finishManagement(selector, 'load', context, local.code === 'CANCELLED' ? 'cancelled' : 'failed', startedAt, local.code);
        throw local;
      } finally {
        slot.managementWaiters--;
        if (slot.opening && !slotHasWaiter(slot)) slot.loadController?.abort();
        armIdle(slot);
      }
      } finally { donePendingTask(); }
    },
    async unload(selector, context) {
      const startedAt = now();
      const donePendingTask = beginPendingTask();
      try {
      validateSelector(selector);
      if (!accepting) fail('BUSY');
      if (context.signal.aborted) fail('CANCELLED');
      if (Date.parse(context.deadlineAt) <= now()) fail('DEADLINE_EXCEEDED');
      if (lockedModels.has(selector.modelId)) fail('MODEL_IN_USE');
      const prepared = await prepare(selector);
      if (lockedModels.has(selector.modelId)) fail('MODEL_IN_USE');
      const slot = slotFor(selector);
      slot.settings = prepared.settings;
      if (slot && selectorKey(slot.selector) !== selectorKey(selector)) fail('REVISION_CONFLICT');
      if ((pendingAdmissions.get(selector.modelId) ?? 0) > 0 || slot.activeJob || slot.queue.length || slot.opening || slot.closing || slot.managementWaiters) fail('MODEL_IN_USE');
      lockedModels.add(selector.modelId);
      slot.managementWaiters++;
      try {
        if (!accepting) fail('CANCELLED');
        if (slot.runtime) await closeSlot(slot);
        finishManagement(selector, 'unload', context, 'succeeded', startedAt);
      } catch (error) {
        const local = errorFrom(error);
        finishManagement(selector, 'unload', context, local.code === 'CANCELLED' ? 'cancelled' : 'failed', startedAt, local.code);
        throw local;
      } finally { slot.managementWaiters--; lockedModels.delete(selector.modelId); }
      } finally { donePendingTask(); }
    },
    readRuntimeState(modelId, revision) {
      const slot = slots.get(modelId);
      return slot?.selector.revision === revision ? stateOf(slot) : null;
    },
    settingsChanged(modelId, settings) {
      configuredSettings.set(modelId, { ...settings });
      const prepared = metadata.get(modelId);
      if (prepared) prepared.settings = { ...settings };
      const slot = slots.get(modelId);
      if (!slot) return;
      slot.settings = { idleUnloadSeconds: settings.idleUnloadSeconds };
      clearTimer(slot);
      armIdle(slot);
    },
    async acquireModelIdleLock(modelId) {
      if (lockedModels.has(modelId)) fail('MODEL_IN_USE');
      const slot = slots.get(modelId);
      if ((pendingAdmissions.get(modelId) ?? 0) > 0) fail('MODEL_IN_USE');
      if (slot && (slot.activeJob || slot.queue.length || slot.opening || slot.closing || slot.managementWaiters)) fail('MODEL_IN_USE');
      lockedModels.add(modelId);
      try {
        if (slot?.runtime) await closeSlot(slot);
        return () => { lockedModels.delete(modelId); };
      } catch (error) { lockedModels.delete(modelId); throw error; }
    },
    async withModelIdleLock(modelId, callback) {
      const release = await manager.acquireModelIdleLock(modelId);
      try { return await callback(); } finally { release(); }
    },
    status() {
      const models: Record<string, RuntimeState> = {};
      for (const [modelId, slot] of slots) models[modelId] = stateOf(slot);
      return { accepting, loaded: [...slots.values()].filter(slot => slot.runtime).length,
        loading: [...slots.values()].filter(slot => slot.state === 'loading').length,
        ready: [...slots.values()].filter(slot => stateOf(slot) === 'ready' && slot.runtime).length,
        unloading: [...slots.values()].filter(slot => Boolean(slot.closing)).length,
        active, queued, models };
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        accepting = false;
        for (const slot of slots.values()) {
          failQueue(slot);
          if (slot.opening) slot.loadController?.abort();
          if (slot.activeJob) {
            slot.activeJob.failure = new LocalAiError('CANCELLED', 'CANCELLED');
            slot.activeJob.controller.abort();
            if (slot.runtime) void stopForCancellation(slot, slot.activeJob);
            else if (slot.opening) slot.loadController?.abort();
          }
        }
        for (const job of operations.values()) { job.failure = new LocalAiError('CANCELLED', 'CANCELLED'); job.abortListener(); }
        await Promise.all([...pendingLifecycleTasks]);
        // AIDEV-NOTE: После подготовки все зарегистрированные операции видны очередям и остановке.
        for (const slot of slots.values()) {
          failQueue(slot);
          if (slot.opening) slot.loadController?.abort();
          if (slot.activeJob) {
            slot.activeJob.failure = new LocalAiError('CANCELLED', 'CANCELLED');
            slot.activeJob.controller.abort();
            if (slot.runtime) void stopForCancellation(slot, slot.activeJob);
          }
        }
        const activeJobs = [...operations.values()].map(job => job.done.then(() => undefined, () => undefined));
        const openings = [...slots.values()].map(slot => slot.opening?.then(() => undefined, () => undefined));
        await Promise.all([...activeJobs, ...openings]);
        await Promise.all([...slots.values()].map(slot => closeSlot(slot)));
      })();
      return closePromise;
    },
  };

  async function waitWithContext<T>(work: Promise<T>, context: OperationContext): Promise<T> {
    const remainingMs = Date.parse(context.deadlineAt) - now();
    if (remainingMs <= 0 || context.signal.aborted) fail(context.signal.aborted ? 'CANCELLED' : 'DEADLINE_EXCEEDED');
    let timer: NodeJS.Timeout | undefined;
    let abort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new LocalAiError(Date.parse(context.deadlineAt) <= now() ? 'DEADLINE_EXCEEDED' : 'CANCELLED', Date.parse(context.deadlineAt) <= now() ? 'DEADLINE_EXCEEDED' : 'CANCELLED'));
      if (!context.deadlineManaged) timer = setTimeout(() => reject(new LocalAiError('DEADLINE_EXCEEDED', 'DEADLINE_EXCEEDED')), Math.min(remainingMs, MAX_TIMEOUT_MS));
      context.signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([work, interrupted]); }
    finally { if (timer) clearTimeout(timer); context.signal.removeEventListener('abort', abort); }
  }

  return manager;
}
