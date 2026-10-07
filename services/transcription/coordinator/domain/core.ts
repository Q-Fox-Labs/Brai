// ABOUTME: Реализует прикладные правила запросов и fenced исполнения transcription.
// ABOUTME: Все внешние операции передаются портами; текст живёт только в ограниченной памяти процесса.
import { createHash, randomUUID } from 'node:crypto';
import { assertDto, methodMap } from '#transcription-contracts';

const publicMethods = methodMap.public;
const helperMethods = methodMap.helper;
const localMethods = methodMap.local;
const externalMethods = methodMap.external;

/** Возвращает безопасный код прикладной ошибки без исходных данных запроса. */
export class CoordinatorFault extends Error {
  /** Публичный безопасный код ошибки прикладного порта. */
  readonly errorCode: string;

  /** Создаёт исключение с закрытым кодом, пригодным для DTO ошибки. */
  constructor(errorCode: string) {
    super(errorCode);
    this.name = 'CoordinatorFault';
    this.errorCode = errorCode;
  }
}

/** Порты предметной логики; реализации адаптеров принадлежат сборке координатора. */
export type CoordinatorPorts = {
  helper: { call(method: string, params: unknown): Promise<unknown> };
  artifacts: { get(params: { artifactId: string }): Promise<unknown> };
  localCatalog: { list(): Promise<unknown> };
  local: { call(method: string, params: unknown): Promise<unknown> };
  external: { call(method: string, params: unknown): Promise<unknown> };
};

/** Обязательные пределы параллелизма и оперативного буфера для сборки runtime. */
export type CoordinatorConfig = {
  instanceId: string;
  workerId: string;
  maxExecuteConcurrency: number;
  leaseRenewIntervalMs: number;
  defaultExecutionTimeoutMs: number;
  resultTtlMs: number;
  maxResultCount: number;
  maxResultBytes: number;
  maxTotalResultBytes: number;
};

function validate(name: string, value: unknown): any {
  return assertDto(name, value);
}

function ownerCall<T>(port: { call(method: string, params: unknown): Promise<unknown> }, methods: Record<string, readonly [string, string]>, method: string, params: unknown): Promise<T> {
  const definition = methods[method];
  if (!definition) throw new CoordinatorFault('INTERNAL');
  validate(definition[0], params);
  return port.call(method, params).then((result) => validate(definition[1], result) as T);
}

function publicInput(method: string, params: unknown): any {
  const definition = publicMethods[method];
  if (!definition) throw new CoordinatorFault('INTERNAL');
  return validate(definition[0], params);
}

function publicOutput(method: string, result: unknown): any {
  const definition = publicMethods[method];
  if (!definition) throw new CoordinatorFault('INTERNAL');
  return validate(definition[1], result);
}

function requirePermission(principal: any, permission: string): void {
  validate('TrustedPrincipal', principal);
  if (!principal.permissions.includes(permission)) throw new CoordinatorFault('FORBIDDEN');
}

function publicView(request: any): any {
  return {
    requestId: request.requestId,
    requestedModel: request.requestedModel,
    actualModel: request.actualModel,
    taskState: request.taskState,
    resultState: request.resultState,
    revision: request.revision,
    errorCode: request.errorCode,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
  };
}

function sameSelector(left: any, right: any): boolean {
  return Boolean(left && right && left.modelId === right.modelId && left.revision === right.revision && left.profileId === right.profileId);
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

function normalizedInput(params: any): any {
  return {
    audioArtifactId: params.audioArtifactId.toLowerCase(),
    requestedModel: params.requestedModel,
    deadlineAt: params.deadlineAt,
  };
}

function utf8Size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function deleteResult(results: Map<string, { value: any; bytes: number; expiresAt: number; timer: ReturnType<typeof setTimeout> }>, requestId: string): void {
  const entry = results.get(requestId);
  if (entry) clearTimeout(entry.timer);
  results.delete(requestId);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { errorCode?: unknown }).errorCode;
  if (typeof code !== 'string') return null;
  try {
    validate('ErrorCode', code);
    return code;
  } catch {
    return null;
  }
}

/**
 * Создаёт прикладное ядро координатора.
 * Результат распознавания остаётся в памяти процесса и никогда не передаётся helper.
 */
export function createCoordinator(options: {
  ports: CoordinatorPorts;
  config: CoordinatorConfig;
  now?: () => number;
  uuid?: () => string;
}) {
  const { ports, config } = options;
  const now = options.now ?? Date.now;
  const uuid = options.uuid ?? randomUUID;
  const results = new Map<string, { value: any; bytes: number; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  let activeExecutions = 0;

  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) throw new TypeError(`Invalid coordinator config: ${key}`);
  }
  if (config.resultTtlMs > 2_147_483_647 || config.leaseRenewIntervalMs > 2_147_483_647) {
    throw new TypeError('Invalid coordinator timer config');
  }
  if (config.maxResultBytes > config.maxTotalResultBytes) throw new TypeError('Invalid coordinator config: maxResultBytes exceeds maxTotalResultBytes');

  function resultBytes(): number {
    let bytes = 0;
    for (const entry of results.values()) bytes += entry.bytes;
    return bytes;
  }

  async function settingsGet(principal: any) {
    requirePermission(principal, 'transcription:use');
    return ownerCall<any>(ports.helper, helperMethods, 'settings.get', { principal });
  }

  async function settingsSet(params: any, principal: any) {
    requirePermission(principal, 'transcription:settings:write');
    return ownerCall(ports.helper, helperMethods, 'settings.set', { principal, expectedRevision: params.expectedRevision, settings: params.settings });
  }

  async function localCatalog() {
    const listed = await ports.localCatalog.list();
    const items = Array.isArray(listed) ? listed : (listed as any)?.items;
    const state = Array.isArray(listed) ? 'available' : (listed as any)?.state ?? 'available';
    if (!Array.isArray(items) || !['available', 'unverified'].includes(state)) {
      const code = (listed as any)?.errorCode;
      throw new CoordinatorFault(code === 'DEPENDENCY_UNAVAILABLE' ? code : 'MODEL_CATALOG_UNAVAILABLE');
    }
    return { state, items: items.map((item) => validate('ModelSummary', item)) };
  }

  async function modelsList(principal: any) {
    requirePermission(principal, 'transcription:use');
    try {
      const catalog = await localCatalog();
      return publicOutput('models.list', {
        localCatalogState: catalog.state,
        localItems: catalog.items,
        externalAvailable: false,
        externalItems: [],
        catalogErrorCode: null,
      });
    } catch (error) {
      const code = errorCode(error);
      return publicOutput('models.list', {
        localCatalogState: 'unavailable', localItems: [], externalAvailable: false,
        externalItems: [], catalogErrorCode: code === 'DEPENDENCY_UNAVAILABLE' ? code : 'MODEL_CATALOG_UNAVAILABLE',
      });
    }
  }

  async function selectModel(input: any, settings: any): Promise<any> {
    if (input.requestedModel?.route === 'external') return null;
    const requestedId = input.requestedModel?.modelId ?? settings.defaultLocalModel?.modelId;
    if (!requestedId) return null;
    const { items } = await localCatalog();
    const candidates = items.filter((candidate: any) => candidate.selector.modelId === requestedId && candidate.supported && candidate.installed);
    if (input.requestedModel === null && settings.defaultLocalModel) {
      return candidates.find((candidate: any) => sameSelector(candidate.selector, settings.defaultLocalModel))?.selector ?? null;
    }
    return candidates.length === 1 ? candidates[0].selector : null;
  }

  async function submit(params: any, principal: any) {
    requirePermission(principal, 'transcription:use');
    const input = normalizedInput(params);
    const normalizedInputSha256 = sha256(input);
    const lookup = await ownerCall<any>(ports.helper, helperMethods, 'request.lookup', {
      principal,
      clientIdempotencyKey: params.clientIdempotencyKey,
      normalizedInputSha256,
    });
    if (lookup.request) return publicOutput('request.submit', { request: publicView(lookup.request) });

    const settingsResult = await settingsGet(principal);
    const settings = settingsResult.settings;
    const policyBody = {
      version: settings.policyVersion,
      defaultLocalModel: settings.defaultLocalModel,
      externalEnabled: false,
      allowReplacement: false,
    };
    const policySnapshot = { ...policyBody, sha256: sha256(policyBody) };
    const artifact = validate('ArtifactMetadata', await ports.artifacts.get({ artifactId: params.audioArtifactId }));
    if (artifact.artifactId.toLowerCase() !== params.audioArtifactId.toLowerCase()) throw new CoordinatorFault('ARTIFACT_NOT_READY');
    if (artifact.ownerId !== principal.ownerId) throw new CoordinatorFault('ARTIFACT_OWNER_MISMATCH');
    const selectedModel = await selectModel(params, settings);
    const accepted = await ownerCall<any>(ports.helper, helperMethods, 'request.accept', {
      principal,
      input: params,
      artifact,
      selectedModel,
      policySnapshot,
    });
    return publicOutput('request.submit', { request: publicView(accepted.request) });
  }

  async function requestGet(params: any, principal: any) {
    requirePermission(principal, 'transcription:use');
    const found = await ownerCall<any>(ports.helper, helperMethods, 'request.get', { principal, requestId: params.requestId });
    return publicOutput('request.get', { request: publicView(found.request) });
  }

  async function requestCancel(params: any, principal: any) {
    requirePermission(principal, 'transcription:use');
    const current = await ownerCall<any>(ports.helper, helperMethods, 'request.get', { principal, requestId: params.requestId });
    const canceled = await ownerCall<any>(ports.helper, helperMethods, 'request.cancel', { principal, requestId: params.requestId, expectedRevision: current.request.revision });
    return publicOutput('request.cancel', { accepted: canceled.accepted, stopConfirmed: canceled.stopConfirmed, request: publicView(canceled.request) });
  }

  async function resultGet(params: any, principal: any) {
    requirePermission(principal, 'transcription:use');
    const found = await ownerCall<any>(ports.helper, helperMethods, 'request.get', { principal, requestId: params.requestId });
    const request = found.request;
    const currentTime = now();
    const cacheKey = request.requestId;
    const cached = results.get(cacheKey);
    if (cached && cached.expiresAt <= currentTime) deleteResult(results, cacheKey);
    const live = results.get(cacheKey);
    if (live && ['available', 'delivery_unknown'].includes(request.resultState) && request.bufferOwnerInstanceId === config.instanceId) {
      let deliveryState = request;
      if (request.resultState === 'available') {
        try {
          const changed = await ownerCall<any>(ports.helper, helperMethods, 'result.setState', {
            requestId: request.requestId,
            expectedRevision: request.revision,
            state: 'delivery_unknown',
            resultExpiresAt: request.resultExpiresAt,
            bufferOwnerInstanceId: config.instanceId,
          });
          deliveryState = changed.request;
        } catch {
          const refreshed = await ownerCall<any>(ports.helper, helperMethods, 'request.get', { principal, requestId: request.requestId });
          deliveryState = refreshed.request;
        }
      }
      const stillHeld = results.get(cacheKey) === live && live.expiresAt > now();
      const deliveryConfirmed = deliveryState.resultState === 'delivery_unknown'
        && deliveryState.bufferOwnerInstanceId === config.instanceId
        && deliveryState.resultExpiresAt !== null
        && Date.parse(deliveryState.resultExpiresAt) > now();
      if (!stillHeld || !deliveryConfirmed) throw new CoordinatorFault('RESULT_UNAVAILABLE');
      return publicOutput('result.get', {
        state: 'available',
        result: { requestId: request.requestId, text: live.value.text, segments: live.value.segments, actualModel: live.value.actualModel },
      });
    }

    let state = request.resultState;
    if (state === 'available' || state === 'delivery_unknown') {
      state = request.resultExpiresAt && Date.parse(request.resultExpiresAt) <= currentTime ? 'expired' : 'lost';
      try {
        const changed = await ownerCall<any>(ports.helper, helperMethods, 'result.setState', {
          requestId: request.requestId,
          expectedRevision: request.revision,
          state,
          resultExpiresAt: null,
          bufferOwnerInstanceId: null,
        });
        state = changed.request.resultState;
      } catch {
        const refreshed = await ownerCall<any>(ports.helper, helperMethods, 'request.get', { principal, requestId: request.requestId });
        state = refreshed.request.resultState;
        if (state === 'available') throw new CoordinatorFault('RESULT_UNAVAILABLE');
      }
    }
    const code = state === 'not_ready' ? 'RESULT_UNAVAILABLE' : state === 'delivery_unknown' ? 'RESULT_UNAVAILABLE' : state === 'lost' || state === 'expired' ? 'RESULT_UNAVAILABLE' : 'REQUEST_OUTCOME_UNKNOWN';
    return publicOutput('result.get', { state, errorCode: code });
  }

  async function invoke(method: string, rawParams: unknown, principal: unknown) {
    const params = publicInput(method, rawParams);
    switch (method) {
      case 'settings.get': return settingsGet(principal);
      case 'settings.set': return settingsSet(params, principal);
      case 'models.list': return modelsList(principal);
      case 'request.submit': return submit(params, principal);
      case 'request.get': return requestGet(params, principal);
      case 'request.cancel': return requestCancel(params, principal);
      case 'result.get': return resultGet(params, principal);
      default: throw new CoordinatorFault('INTERNAL');
    }
  }

  async function attemptFinish(claim: any, attemptId: string, expectedRevision: number, fields: any) {
    return ownerCall(ports.helper, helperMethods, 'attempt.finish', {
      requestId: claim.request.requestId,
      attemptId,
      claimToken: claim.claimToken,
      fenceGeneration: claim.fenceGeneration,
      expectedRevision,
      outcome: fields.outcome,
      actualModel: fields.actualModel ?? null,
      usage: fields.usage ?? null,
      cost: fields.cost ?? null,
      errorCode: fields.errorCode ?? null,
      durationMs: fields.durationMs ?? null,
      resultState: fields.resultState,
      resultExpiresAt: fields.resultExpiresAt ?? null,
      bufferOwnerInstanceId: fields.bufferOwnerInstanceId ?? null,
    });
  }

  async function executeClaim(claim: any): Promise<boolean> {
    const request = claim.request;
    const attemptId = uuid();
    const start = await ownerCall<any>(ports.helper, helperMethods, 'attempt.start', {
      requestId: request.requestId,
      attemptId,
      claimToken: claim.claimToken,
      fenceGeneration: claim.fenceGeneration,
      expectedRevision: claim.revision,
    });
    if (start.created !== true) return false;
    if (request.deadlineAt && Date.parse(request.deadlineAt) <= now()) {
      await attemptFinish(claim, attemptId, start.request.revision, {
        outcome: 'failed', errorCode: 'DEADLINE_EXCEEDED', resultState: 'not_ready',
      });
      return true;
    }

    if (request.requestedModel?.route !== 'external' && request.selectedModel === null) {
      await attemptFinish(claim, attemptId, start.request.revision, {
        outcome: 'failed', errorCode: 'MODEL_UNAVAILABLE', resultState: 'not_ready',
      });
      return true;
    }

    const running = await ownerCall<any>(ports.helper, helperMethods, 'attempt.markRunning', {
      requestId: request.requestId,
      attemptId,
      claimToken: claim.claimToken,
      fenceGeneration: claim.fenceGeneration,
      expectedRevision: start.request.revision,
    });
    let currentRevision = running.request.revision;
    let finished = false;
    let leaseLost = false;
    let renewal: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renew = () => {
      timer = setTimeout(() => {
        if (finished || leaseLost) return;
        renewal = ownerCall<any>(ports.helper, helperMethods, 'request.renew', {
          requestId: request.requestId,
          claimToken: claim.claimToken,
          fenceGeneration: claim.fenceGeneration,
          expectedRevision: currentRevision,
        }).then((value) => {
          currentRevision = value.revision;
          renewal = null;
          if (!finished && !leaseLost) renew();
        }).catch(() => {
          leaseLost = true;
          renewal = null;
        });
      }, config.leaseRenewIntervalMs);
    };
    renew();

    let response: any;
    let outcome: 'succeeded' | 'failed' | 'outcome_unknown' = 'outcome_unknown';
    let actualModel: any = null;
    let usage: any = null;
    let cost: any = null;
    let durationMs: number | null = null;
    let failure: string | null = null;
    const effectiveDeadlineAt = request.deadlineAt ?? new Date(now() + config.defaultExecutionTimeoutMs).toISOString();
    try {
      if (request.requestedModel?.route === 'external') {
        response = await ownerCall<any>(ports.external, externalMethods, 'execute', {
          requestId: request.requestId,
          audioArtifactId: request.audioArtifactId,
          operationId: attemptId,
          ownerId: request.ownerId,
          model: null,
          deadlineAt: effectiveDeadlineAt,
        });
        outcome = 'failed';
        failure = response.errorCode;
      } else {
        // AIDEV-NOTE: Внутренний executor получает ID задачи и отдельный ID попытки; owner adapter сопоставляет оба ID local-ai с attemptId.
        response = await ownerCall<any>(ports.local, localMethods, 'execute', {
          requestId: request.requestId,
          audioArtifactId: request.audioArtifactId,
          operationId: attemptId,
          ownerId: request.ownerId,
          model: request.selectedModel,
          deadlineAt: effectiveDeadlineAt,
        });
        if (response.requestId !== request.requestId || response.operationId !== attemptId) {
          outcome = 'outcome_unknown';
          failure = 'REQUEST_OUTCOME_UNKNOWN';
        } else {
          actualModel = response.actualModel;
          if (!sameSelector(response.actualModel, request.selectedModel)) {
            outcome = 'failed';
            failure = 'MODEL_MISMATCH';
          } else {
            outcome = 'succeeded';
            usage = response.usage;
            cost = response.cost;
            durationMs = response.durationMs;
          }
        }
      }
    } catch (error) {
      const safeCode = errorCode(error);
      if (safeCode && (error as any)?.outcome === 'failed') {
        outcome = 'failed';
        failure = safeCode;
      } else if (safeCode) {
        // A closed error code is useful metadata, but does not prove whether dispatch completed.
        failure = safeCode;
      }
    } finally {
      finished = true;
      if (timer) clearTimeout(timer);
      if (renewal) await renewal;
    }

    if (leaseLost) return false;
    if (outcome !== 'succeeded') {
      await attemptFinish(claim, attemptId, currentRevision, {
        outcome, actualModel, usage, cost, durationMs,
        errorCode: failure ?? 'REQUEST_OUTCOME_UNKNOWN', resultState: 'not_ready',
      });
      return true;
    }

    const result = { requestId: request.requestId, text: response.text, segments: response.segments, actualModel };
    const bytes = utf8Size(result);
    for (const [id, entry] of results) if (entry.expiresAt <= now()) deleteResult(results, id);
    if (bytes > config.maxResultBytes || results.size >= config.maxResultCount || resultBytes() + bytes > config.maxTotalResultBytes) {
      await attemptFinish(claim, attemptId, currentRevision, {
        outcome: 'failed', actualModel, usage, cost, durationMs,
        errorCode: 'RESULT_TOO_LARGE', resultState: 'not_ready',
      });
      return true;
    }

    const expiresAt = now() + config.resultTtlMs;
    const entry = { value: result, bytes, expiresAt, timer: setTimeout(() => {
      if (results.get(request.requestId) === entry) results.delete(request.requestId);
    }, config.resultTtlMs) };
    entry.timer.unref?.();
    results.set(request.requestId, entry);
    try {
      await attemptFinish(claim, attemptId, currentRevision, {
        outcome: 'succeeded', actualModel, usage, cost, durationMs,
        resultState: 'available', resultExpiresAt: new Date(expiresAt).toISOString(),
        bufferOwnerInstanceId: config.instanceId,
      });
    } catch {
      const ownedPrincipal = {
        scopeType: request.scope.scopeType,
        scopeId: request.scope.scopeId,
        ownerId: request.ownerId,
        permissions: ['transcription:use'],
      };
      const current = await ownerCall<any>(ports.helper, helperMethods, 'request.get', { principal: ownedPrincipal, requestId: request.requestId }).catch(() => null);
      if (current?.request?.taskState !== 'succeeded' || current.request.currentAttemptId !== attemptId || current.request.bufferOwnerInstanceId !== config.instanceId) deleteResult(results, request.requestId);
      return false;
    }
    return true;
  }

  async function pumpOnce(): Promise<boolean> {
    for (const [id, entry] of results) if (entry.expiresAt <= now()) deleteResult(results, id);
    if (activeExecutions >= config.maxExecuteConcurrency) return false;
    if (results.size + activeExecutions >= config.maxResultCount) return false;
    if (resultBytes() + (activeExecutions + 1) * config.maxResultBytes > config.maxTotalResultBytes) return false;
    activeExecutions += 1;
    try {
      const claim = await ownerCall<any>(ports.helper, helperMethods, 'request.claim', { workerId: config.workerId });
      if (claim === null) return false;
      return await executeClaim(claim);
    } finally {
      activeExecutions -= 1;
    }
  }

  function clearVolatileResults(): void {
    for (const id of results.keys()) deleteResult(results, id);
  }

  return Object.freeze({ invoke, pumpOnce, clearVolatileResults });
}
