// ABOUTME: Управляет модельными процессами, конечной очередью, сроками, отменой и idle ресурсами.
// ABOUTME: Слот и временные артефакты освобождаются только после фактического завершения runtime-вызова или процесса.
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { LocalAiError } from '../errors.js';
import type { ArtifactPort, LocalAiStore, ModelIdleGuard, ModelSettingsChangedPort, RuntimeFactory, RuntimePort } from '../ports.js';
import type {
  EmbedInput, EmbedOutput, InstallationRecord, LocalAiHistoryMetadataEvent, ModelRecord, ModelSelector,
  ModelSettings, OperationContext, ResolvedModel, RuntimeState, ServiceErrorCode, TranscribeOutput,
} from '../types.js';

const MAX_TIMEOUT_MS = 2_147_483_647;

type CommonInvocation = { requestId: string; operationId: string; model: ModelSelector; ownerId: string; deadlineAt: string };
export type EmbedInvocation = CommonInvocation & { operation: 'embed'; texts: readonly string[]; purpose: 'query' | 'document' | 'symmetric' };
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
  resolve: (value: InvocationResult) => void; reject: (error: unknown) => void; state: 'queued' | 'active' | 'settled';
  acceptedAt: number; admission: LocalAiHistoryMetadataEvent; terminalEventId: string; inputBytes: number; record: ModelRecord;
  runtime?: RuntimePort; audioPath?: string; abortListener: () => void; deadlineTimer?: NodeJS.Timeout; failure?: LocalAiError;
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
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function selectorKey(selector: ModelSelector): string { return `${selector.modelId}\u0000${selector.revision}\u0000${selector.profileId}`; }
function validateContext(input: Invocation, context: OperationContext): void {
  if (input.ownerId !== context.ownerId || input.operationId !== context.operationId || input.deadlineAt !== context.deadlineAt) fail('INVALID_ARGUMENT');
  const deadline = Date.parse(input.deadlineAt);
  if (!Number.isFinite(deadline)) fail('INVALID_ARGUMENT');
  if (deadline <= Date.now()) fail('DEADLINE_EXCEEDED');
}
function event(input: Invocation, outcome: LocalAiHistoryMetadataEvent['data']['outcome'], options: {
  id: string; now: string; durationMs?: number; inputBytes?: number; resultBytes?: number; vectorDimensions?: number; errorCode?: ServiceErrorCode;
}): LocalAiHistoryMetadataEvent {
  return {
    id: options.id, type_id: 1201, occurred_at: options.now, actor_id: input.ownerId,
    scope_type: 'user', scope_id: input.ownerId, object_type: 'operation', object_id: input.operationId,
    data: {
      operation: 'invoke', modelId: input.model.modelId, outcome, revision: input.model.revision,
      profileId: input.model.profileId, operationId: input.operationId, requestId: input.requestId,
      phase: outcome === 'accepted' ? 'accepted' : 'execute',
      ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
      ...(options.inputBytes !== undefined ? { inputBytes: options.inputBytes } : {}),
      ...(options.resultBytes !== undefined ? { resultBytes: options.resultBytes } : {}),
      ...(options.vectorDimensions !== undefined ? { vectorDimensions: options.vectorDimensions } : {}),
      ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    },
  };
}
function managementEvent(selector: ModelSelector, operation: 'load' | 'unload', actorId: string, operationId: string, outcome: 'accepted' | 'succeeded' | 'failed' | 'cancelled' = 'accepted', errorCode?: ServiceErrorCode, id: string = randomUUID()): LocalAiHistoryMetadataEvent {
  return {
    id, type_id: operation === 'load' ? 203 : 204, occurred_at: new Date().toISOString(),
    actor_id: actorId, scope_type: 'system', scope_id: 'local_ai', object_type: 'model', object_id: selector.modelId,
    data: { operation, modelId: selector.modelId, outcome, revision: selector.revision, profileId: selector.profileId,
      operationId, phase: operation === 'load' ? 'load' : 'unload', ...(errorCode ? { errorCode } : {}) },
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
  async function reserveManagement(selector: ModelSelector, operation: 'load' | 'unload', actorId: string): Promise<{ operationId: string; accepted: LocalAiHistoryMetadataEvent; terminalId: string }> {
    const operationId = randomUUID();
    const accepted = managementEvent(selector, operation, actorId, operationId);
    const terminalId = randomUUID();
    await store.transaction(tx => tx.outbox.appendAdmission(accepted, { operationId, terminalEventId: terminalId }));
    return { operationId, accepted, terminalId };
  }
  async function finishManagement(reservation: { operationId: string; accepted: LocalAiHistoryMetadataEvent; terminalId: string }, outcome: 'succeeded' | 'failed' | 'cancelled', errorCode?: ServiceErrorCode): Promise<void> {
    const seed = reservation.accepted;
    const terminal = managementEvent(
      { modelId: seed.data.modelId, revision: seed.data.revision!, profileId: seed.data.profileId! },
      seed.data.operation as 'load' | 'unload', seed.actor_id!, reservation.operationId, outcome, errorCode, reservation.terminalId,
    );
    await store.transaction(tx => tx.outbox.appendCompletion(reservation.operationId, terminal));
  }
  for (const [name, value] of Object.entries(limits)) finiteLimit(value, name);
  const now = options.now ?? Date.now;
  const slots = new Map<string, Slot>();
  const operations = new Map<string, Job>();
  const lockedModels = new Set<string>();
  let accepting = true;
  let outstanding = 0;
  let allocationTail: Promise<void> = Promise.resolve();
  const admittingOperations = new Set<string>();
  const pendingAdmissions = new Map<string, number>();
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
  async function prepare(selector: ModelSelector, operation?: 'embed' | 'transcribe'): Promise<Prepared> {
    validateSelector(selector);
    return store.transaction(async tx => {
      const model = await tx.models.get(selector.modelId);
      if (!model) fail('MODEL_NOT_FOUND');
      if (!model.supported || model.profileId === null) fail('NOT_SUPPORTED');
      if (model.revision !== selector.revision || model.profileId !== selector.profileId) fail('REVISION_CONFLICT');
      if (operation && !model.operations.includes(operation)) fail('UNSUPPORTED_OPERATION');
      const installation = await tx.installations.get(model.modelId, model.revision);
      if (!installation) fail('MODEL_NOT_INSTALLED');
      if (installation.profileId !== model.profileId || installation.modelId !== model.modelId || installation.revision !== model.revision) fail('REVISION_CONFLICT');
      return { record: model, installation, settings: await tx.settings.get(model.modelId) ?? { idleUnloadSeconds: 600 } };
    });
  }
  function assertInput(input: Invocation, model: ModelRecord, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limits.maxInputBytes || model.limits.maxInputBytes !== null && bytes > model.limits.maxInputBytes) fail('INPUT_TOO_LARGE');
    if (input.operation === 'embed') {
      if (!Array.isArray(input.texts) || input.texts.length < 1 || input.texts.length > limits.maxEmbeddingItems
        || model.limits.maxItems !== null && input.texts.length > model.limits.maxItems
        || !input.texts.every(value => typeof value === 'string')) fail('INVALID_ARGUMENT');
      if (!['query', 'document', 'symmetric'].includes(input.purpose)) fail('INVALID_ARGUMENT');
      const dimensions = model.limits.vectorDimensions;
      if (dimensions !== null && input.texts.length * dimensions * 8 > limits.maxResultBytes) fail('RESULT_TOO_LARGE');
    }
  }
  function createJob(input: Invocation, context: OperationContext, admission: LocalAiHistoryMetadataEvent, inputBytes: number, record: ModelRecord, audioPath?: string): Job {
    let resolve!: (value: InvocationResult) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<InvocationResult>((yes, no) => { resolve = yes; reject = no; });
    const job: Job = { input, context, controller: new AbortController(), done, resolve, reject, state: 'queued', acceptedAt: now(), admission,
      terminalEventId: randomUUID(), inputBytes, record, audioPath, abortListener: () => undefined };
    job.abortListener = () => {
      if (!job.controller.signal.aborted) job.controller.abort();
      const slot = slots.get(input.model.modelId);
      if (slot?.activeJob === job && job.runtime) void stopForCancellation(slot, job);
      else if (slot?.opening && !slotHasWaiter(slot, job)) slot.loadController?.abort();
    };
    if (context.signal.aborted) job.abortListener();
    else context.signal.addEventListener('abort', job.abortListener, { once: true });
    operations.set(input.operationId, job);
    return job;
  }
  function operationContext(job: Job): OperationContext {
    return { ownerId: job.input.ownerId, operationId: job.input.operationId, deadlineAt: job.input.deadlineAt, signal: job.controller.signal };
  }
  function startDeadline(job: Job, slot: Slot): void {
    const tick = () => {
      const left = Date.parse(job.input.deadlineAt) - now();
      if (left <= 0) {
        job.failure = new LocalAiError('DEADLINE_EXCEEDED', 'DEADLINE_EXCEEDED');
        job.controller.abort();
        if (job.state === 'active' && job.runtime) void stopForCancellation(slot, job);
        else if (slot.opening && !slotHasWaiter(slot, job)) slot.loadController?.abort();
        return;
      }
      job.deadlineTimer = setTimeout(tick, Math.min(left, MAX_TIMEOUT_MS));
    };
    tick();
  }
  async function appendTerminal(job: Job, outcome: 'succeeded' | 'failed' | 'cancelled', result?: InvocationResult, error?: LocalAiError): Promise<void> {
    const elapsed = Math.max(0, Math.floor(now() - job.acceptedAt));
    const terminal = event(job.input, outcome, {
      id: job.terminalEventId, now: new Date(now()).toISOString(), durationMs: elapsed,
      inputBytes: job.inputBytes,
      ...(result?.operation === 'embed' ? { resultBytes: resultBytes(result.vectors), vectorDimensions: result.vectors[0]?.length } : {}),
      ...(result?.operation === 'transcribe' ? { resultBytes: resultBytes({ text: result.text, segments: result.segments }) } : {}),
      ...(error ? { errorCode: error.code } : {}),
    });
    await store.transaction(tx => tx.outbox.appendCompletion(job.input.operationId, terminal));
  }
  async function complete(job: Job, outcome: 'succeeded' | 'failed' | 'cancelled', result?: InvocationResult, error?: LocalAiError): Promise<void> {
    if (job.state === 'settled') return;
    job.state = 'settled';
    if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
    job.context.signal.removeEventListener('abort', job.abortListener);
    operations.delete(job.input.operationId);
    outstanding--;
    let terminalError = error;
    try { await appendTerminal(job, outcome, result, error); }
    catch (storeError) { terminalError = errorFrom(storeError); }
    if (terminalError) job.reject(terminalError);
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
    catch { /* slot remains occupied until runtime.exited resolves */ }
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
      job.runtime = runtime;
      const interrupted = contextOutcome(job);
      if (interrupted) throw interrupted;
      const callContext = operationContext(job);
      if (job.input.operation === 'embed') {
        const output: EmbedOutput = await runtime.embed({ model: job.input.model, texts: job.input.texts, purpose: job.input.purpose }, callContext);
        const dimensions = job.record.limits.vectorDimensions;
        if (!Array.isArray(output.vectors) || output.vectors.length !== job.input.texts.length
          || output.vectors.some(vector => !Array.isArray(vector) || dimensions !== null && vector.length !== dimensions
            || !vector.every(value => typeof value === 'number' && Number.isFinite(value))
            || Math.abs(Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) - 1) > 0.001)) fail('ENGINE_UNAVAILABLE');
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
      if (size > limits.maxResultBytes || result.operation === 'embed' && result.vectors.some(vector => vector.length * 8 > limits.maxResultBytes)) fail('RESULT_TOO_LARGE');
      const end = contextOutcome(job);
      if (end) throw end;
    } catch (error) {
      failure = contextOutcome(job) ?? errorFrom(error);
    } finally {
      if (job.controller.signal.aborted && job.runtime && slot.runtime === job.runtime) {
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
    startDeadline(job, slot);
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
  async function accept(input: Invocation, context: OperationContext, prepared: Prepared, inputBytes: number, audioPath?: string): Promise<Job> {
    const donePendingTask = beginPendingTask();
    try {
    validateContext(input, context);
    if (!accepting) fail('BUSY');
    if (lockedModels.has(input.model.modelId)) fail('MODEL_IN_USE');
    if (outstanding >= limits.maxQueuedOperations) fail('BUSY');
    if (operations.has(input.operationId) || admittingOperations.has(input.operationId)) fail('REVISION_CONFLICT');
    const slot = slotFor(input.model);
    if (slot.queue.length + Number(Boolean(slot.activeJob)) >= limits.maxQueuedOperations) fail('BUSY');
    outstanding++;
    admittingOperations.add(input.operationId);
    pendingAdmissions.set(input.model.modelId, (pendingAdmissions.get(input.model.modelId) ?? 0) + 1);
    const acceptedEvent = event(input, 'accepted', { id: randomUUID(), now: new Date(now()).toISOString(), inputBytes });
    const terminalEventId = randomUUID();
    try {
      await store.transaction(tx => tx.outbox.appendAdmission(acceptedEvent, { operationId: input.operationId, terminalEventId }));
    } catch (error) {
      outstanding--; admittingOperations.delete(input.operationId);
      const count = (pendingAdmissions.get(input.model.modelId) ?? 1) - 1;
      if (count) pendingAdmissions.set(input.model.modelId, count); else pendingAdmissions.delete(input.model.modelId);
      throw errorFrom(error);
    }
    if (!accepting) {
      const stopped = new LocalAiError('CANCELLED', 'CANCELLED');
      const terminal = event(input, 'cancelled', { id: terminalEventId, now: new Date(now()).toISOString(), inputBytes, errorCode: stopped.code });
      try { await store.transaction(tx => tx.outbox.appendCompletion(input.operationId, terminal)); }
      finally {
        outstanding--; admittingOperations.delete(input.operationId);
        const count = (pendingAdmissions.get(input.model.modelId) ?? 1) - 1;
        if (count) pendingAdmissions.set(input.model.modelId, count); else pendingAdmissions.delete(input.model.modelId);
      }
      throw stopped;
    }
    const job = createJob(input, context, acceptedEvent, inputBytes, prepared.record, audioPath);
    job.terminalEventId = terminalEventId;
    admittingOperations.delete(input.operationId);
    const count = (pendingAdmissions.get(input.model.modelId) ?? 1) - 1;
    if (count) pendingAdmissions.set(input.model.modelId, count); else pendingAdmissions.delete(input.model.modelId);
    slot.settings = prepared.settings;
    slot.queue.push(job);
    queued++;
    drain(slot);
    return job;
    } finally { donePendingTask(); }
  }
  function resultForCaller(job: Job, slot: Slot): Promise<InvocationResult> {
    const timerController = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const deadline = Date.parse(job.input.deadlineAt);
    const expired = new Promise<never>((_resolve, reject) => {
      const tick = () => {
        const left = deadline - now();
        if (left <= 0) {
          job.failure = new LocalAiError('DEADLINE_EXCEEDED', 'DEADLINE_EXCEEDED');
          if (job.state === 'queued') {
            const index = slot.queue.indexOf(job);
            if (index >= 0) { slot.queue.splice(index, 1); queued--; }
            void complete(job, 'cancelled', undefined, job.failure).then(() => { if (slot.queue.length) drain(slot); });
          } else { job.controller.abort(); }
          reject(job.failure);
          return;
        }
        timer = setTimeout(tick, Math.min(left, MAX_TIMEOUT_MS));
      };
      tick();
      abortListener = () => {
        const error = contextOutcome(job) ?? new LocalAiError('CANCELLED', 'CANCELLED');
        reject(error);
      };
      job.controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    return Promise.race([job.done, expired]).finally(() => {
      if (timer) clearTimeout(timer);
      if (abortListener) job.controller.signal.removeEventListener('abort', abortListener);
      timerController.abort();
    });
  }

  const manager: LifecycleManager = {
    async invoke(input, context) {
      validateContext(input, context);
      const prepared = await prepare(input.model, input.operation);
      let bytes: number;
      if (input.operation === 'embed') {
        if (!Array.isArray(input.texts) || !input.texts.every(text => typeof text === 'string')) fail('INVALID_ARGUMENT');
        bytes = Buffer.byteLength(JSON.stringify(input.texts), 'utf8');
      } else bytes = 0;
      assertInput(input, prepared.record, bytes);
      if (input.operation === 'embed') {
        const job = await accept(input, context, prepared, bytes);
        return resultForCaller(job, slots.get(input.model.modelId)!);
      }
      return artifacts.withReadyAudio({ artifactId: input.audioArtifactId, ownerId: input.ownerId, operationId: input.operationId }, context, async audio => {
        let audioBytes: number;
        try { audioBytes = (await stat(audio.localPath)).size; } catch { fail('ARTIFACT_NOT_AVAILABLE'); }
        assertInput(input, prepared.record, audioBytes!);
        const job = await accept(input, context, prepared, audioBytes!, audio.localPath);
        try { return await resultForCaller(job, slots.get(input.model.modelId)!); }
        finally { await job.done.then(() => undefined, () => undefined); }
      });
    },
    async cancel(ownerId, operationId) {
      const job = operations.get(operationId);
      if (!job || job.input.ownerId !== ownerId) return 'not_found';
      if (job.state === 'settled') return 'already_terminal';
      job.failure = new LocalAiError('CANCELLED', 'CANCELLED');
      job.controller.abort();
      const slot = slots.get(job.input.model.modelId)!;
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
      const donePendingTask = beginPendingTask();
      try {
      validateSelector(selector);
      if (!accepting) fail('BUSY');
      if (context.signal.aborted) fail('CANCELLED');
      if (Date.parse(context.deadlineAt) <= now()) fail('DEADLINE_EXCEEDED');
      const prepared = await prepare(selector);
      if (lockedModels.has(selector.modelId)) fail('MODEL_IN_USE');
      const slot = slotFor(selector);
      slot.settings = prepared.settings;
      slot.managementWaiters++;
      let reservation: Awaited<ReturnType<typeof reserveManagement>> | undefined;
      try {
        reservation = await reserveManagement(selector, 'load', context.ownerId);
        if (!accepting) fail('CANCELLED');
        const runtime = await Promise.race([ensureRuntime(slot), waitContext(context)]);
        if (slot.runtime !== runtime) fail('MODEL_LOAD_FAILED');
        slot.idleSince ??= now();
        armIdle(slot);
        await finishManagement(reservation, 'succeeded');
      } catch (error) {
        const local = errorFrom(error);
        if (reservation) await finishManagement(reservation, local.code === 'CANCELLED' ? 'cancelled' : 'failed', local.code).catch(() => undefined);
        throw local;
      } finally {
        slot.managementWaiters--;
        if (slot.opening && !slotHasWaiter(slot)) slot.loadController?.abort();
      }
      } finally { donePendingTask(); }
    },
    async unload(selector, context) {
      const donePendingTask = beginPendingTask();
      try {
      validateSelector(selector);
      if (!accepting) fail('BUSY');
      if (context.signal.aborted) fail('CANCELLED');
      if (Date.parse(context.deadlineAt) <= now()) fail('DEADLINE_EXCEEDED');
      const prepared = await prepare(selector);
      if (lockedModels.has(selector.modelId)) fail('MODEL_IN_USE');
      const slot = slotFor(selector);
      slot.settings = prepared.settings;
      if (slot && selectorKey(slot.selector) !== selectorKey(selector)) fail('REVISION_CONFLICT');
      if ((pendingAdmissions.get(selector.modelId) ?? 0) > 0 || slot.activeJob || slot.queue.length || slot.opening || slot.closing || slot.managementWaiters) fail('MODEL_IN_USE');
      lockedModels.add(selector.modelId);
      slot.managementWaiters++;
      let reservation: Awaited<ReturnType<typeof reserveManagement>> | undefined;
      try {
        reservation = await reserveManagement(selector, 'unload', context.ownerId);
        if (!accepting) fail('CANCELLED');
        if (slot.runtime) await closeSlot(slot);
        await finishManagement(reservation, 'succeeded');
      } catch (error) {
        const local = errorFrom(error);
        if (reservation) await finishManagement(reservation, local.code === 'CANCELLED' ? 'cancelled' : 'failed', local.code).catch(() => undefined);
        throw local;
      } finally { slot.managementWaiters--; lockedModels.delete(selector.modelId); }
      } finally { donePendingTask(); }
    },
    readRuntimeState(modelId, revision) {
      const slot = slots.get(modelId);
      return slot?.selector.revision === revision ? stateOf(slot) : null;
    },
    settingsChanged(modelId, settings) {
      const slot = slots.get(modelId);
      if (!slot) return;
      slot.settings = { idleUnloadSeconds: settings.idleUnloadSeconds };
      clearTimer(slot);
      armIdle(slot);
    },
    async withModelIdleLock(modelId, callback) {
      if (lockedModels.has(modelId)) fail('MODEL_IN_USE');
      const slot = slots.get(modelId);
      if ((pendingAdmissions.get(modelId) ?? 0) > 0) fail('MODEL_IN_USE');
      if (slot && (slot.activeJob || slot.queue.length || slot.opening || slot.closing || slot.managementWaiters)) fail('MODEL_IN_USE');
      lockedModels.add(modelId);
      try {
        if (slot?.runtime) await closeSlot(slot);
        return await callback();
      } finally { lockedModels.delete(modelId); }
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
        await Promise.all([...pendingLifecycleTasks]);
        // Admissions that committed just before shutdown are now visible in operations/queues.
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

  async function waitContext(context: OperationContext): Promise<never> {
    const remainingMs = Date.parse(context.deadlineAt) - now();
    if (remainingMs <= 0 || context.signal.aborted) fail(context.signal.aborted ? 'CANCELLED' : 'DEADLINE_EXCEEDED');
    return new Promise((_resolve, reject) => {
      let timer: NodeJS.Timeout;
      const abort = () => { clearTimeout(timer); context.signal.removeEventListener('abort', abort); reject(new LocalAiError('CANCELLED', 'CANCELLED')); };
      timer = setTimeout(() => { context.signal.removeEventListener('abort', abort); reject(new LocalAiError('DEADLINE_EXCEEDED', 'DEADLINE_EXCEEDED')); }, Math.min(remainingMs, MAX_TIMEOUT_MS));
      context.signal.addEventListener('abort', abort, { once: true });
    });
  }

  return manager;
}
