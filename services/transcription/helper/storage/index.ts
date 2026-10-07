// ABOUTME: Выполняет атомарные metadata операции helper в собственном PostgreSQL.
// ABOUTME: Принимает только owner DTO; dispatch, текст и внешние вызовы здесь отсутствуют.
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { assertDto, methodMap } from '#transcription-contracts';
import { createAlertsStore } from './alerts.js';

// AIDEV-NOTE: Форматы wire не дублируются TypeScript интерфейсами; каждый вход/выход проверяет owner registry.
type Metadata = Record<string, any>;
/** Конечные пределы транзакционного outbox и двух независимых lease в миллисекундах. */
export interface StoreConfig { historyCapacity: number; alertsCapacity: number; requestLeaseMs: number; historyLeaseMs: number; transactionTimeoutMs: number; recoveryBatchSize: number; }
/** Безопасная прикладная ошибка без SQL, DTO, URL соединения или сырого exception. */
export class StorageFault extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'StorageFault'; }
}
const fail = (code: string): never => { throw new StorageFault(code); };

/** Канонический JSON: ключи объектов сортируются, порядок массивов сохраняется. */
export function canonicalHash(value: unknown): string {
  const canonical = (item: any): string => item && typeof item === 'object'
    ? Array.isArray(item) ? '[' + item.map(canonical).join(',') + ']' : '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + canonical(item[key])).join(',') + '}'
    : JSON.stringify(item);
  return createHash('sha256').update(canonical(value)).digest('hex');
}
/** Создаёт immutable локальный snapshot; sha256 исключён из собственного хеша. */
export function createPolicySnapshot(settings: Metadata): Metadata {
  const snapshot = { version: settings.policyVersion, defaultLocalModel: settings.defaultLocalModel, externalEnabled: false, allowReplacement: false };
  return { ...snapshot, sha256: canonicalHash(snapshot) };
}
function normalizedInput(input: Metadata): Metadata {
  return { ...input, clientIdempotencyKey: input.clientIdempotencyKey.toLowerCase(), audioArtifactId: input.audioArtifactId.toLowerCase() };
}
function inputHash(input: Metadata): string {
  return canonicalHash({ audioArtifactId: input.audioArtifactId, requestedModel: input.requestedModel, deadlineAt: input.deadlineAt });
}
function use(principal: Metadata, permission = 'transcription:use'): void {
  if (!principal.permissions.includes(permission)) fail('FORBIDDEN');
}
const timeSQL = (column: string) => `to_char((${column}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Создаёт владельца metadata; pool должен иметь конечные connect/query timeout и max connections. Не выполняет DDL. */
export function createPostgresStore(pool: Pool, config: StoreConfig) {
  for (const value of Object.values(config)) if (!Number.isSafeInteger(value) || value <= 0) fail('INVALID_ARGUMENT');
  if (!['historyCapacity', 'alertsCapacity', 'requestLeaseMs', 'historyLeaseMs', 'transactionTimeoutMs', 'recoveryBatchSize'].every(key => Object.hasOwn(config, key))) fail('INVALID_ARGUMENT');
  const transactionTimeoutMs = config.transactionTimeoutMs;
  const alerts = createAlertsStore(config.alertsCapacity, config.historyLeaseMs, fail);

  async function tx<T>(run: (client: PoolClient, now: string) => Promise<T>): Promise<T> {
    // AIDEV-NOTE: Внутри lock только короткие SQL metadata операции; никакого ожидания invoke/NATS.
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [String(transactionTimeoutMs)]);
      await client.query('SELECT pg_advisory_xact_lock(70482320)');
      const now = (await client.query(`SELECT ${timeSQL('clock_timestamp()')} AS now`)).rows[0].now;
      const result = await run(client, now);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof StorageFault) throw error;
      throw new StorageFault('STORAGE_UNAVAILABLE');
    } finally { client?.release(); }
  }
  async function capacity(client: PoolClient, extra: number): Promise<void> {
    const count = Number((await client.query("SELECT count(*) AS n FROM transcription.history_outbox WHERE state<>'acknowledged'")).rows[0].n);
    if (count + extra > config.historyCapacity) fail('OVERLOADED');
  }
  async function settings(client: PoolClient): Promise<Metadata> {
    const row = (await client.query('SELECT settings,revision FROM transcription.settings WHERE singleton FOR UPDATE')).rows[0];
    if (!row) fail('STORAGE_UNAVAILABLE');
    return { settings: row.settings, revision: Number(row.revision) };
  }
  async function row(client: PoolClient, requestId: string, principal?: Metadata): Promise<Metadata> {
    const args = [requestId];
    let access = '';
    if (principal) { use(principal); args.push(principal.scopeType, principal.scopeId, principal.ownerId); access = ' AND scope_type=$2 AND scope_id=$3 AND owner_id=$4'; }
    const result = (await client.query(`SELECT *,lease_expires_at>clock_timestamp() AS lease_live,${timeSQL('lease_expires_at')} AS lease_text FROM transcription.requests WHERE request_id=$1${access} FOR UPDATE`, args)).rows[0];
    if (!result) fail('NOT_FOUND');
    return result;
  }
  function checkRevision(record: Metadata, expectedRevision: number): void {
    if (record.revision !== expectedRevision) fail('STALE_REVISION');
  }
  function checkClaim(current: Metadata, params: Metadata): void {
    checkRevision(current.metadata, params.expectedRevision);
    if (!current.lease_live || current.claim_token !== params.claimToken.toLowerCase() || current.metadata.fenceGeneration !== params.fenceGeneration) fail('STALE_CLAIM');
    if (params.attemptId && current.metadata.currentAttemptId !== params.attemptId.toLowerCase()) fail('STATE_CONFLICT');
  }
  async function save(client: PoolClient, current: Metadata, record: Metadata, now: string, release = false): Promise<Metadata> {
    record = { ...record, revision: current.metadata.revision + 1, updatedAt: now };
    assertDto('RequestRecord', record);
    await client.query('UPDATE transcription.requests SET metadata=$2,revision=$3,task_state=$4,claim_token=$5,worker_id=$6,lease_expires_at=$7 WHERE request_id=$1',
      [record.requestId, record, record.revision, record.taskState, release ? null : current.claim_token, release ? null : current.worker_id, release ? null : current.lease_expires_at]);
    return record;
  }
  function event(record: Metadata, id: string, now: string, phase: string, outcome: string | null, type = 1201): Metadata {
    const result = { id, type_id: type, occurred_at: now, actor_id: record.ownerId, scope_type: record.scope.scopeType, scope_id: record.scope.scopeId,
      object_type: 'transcription_request', object_id: record.requestId,
      data: { requestId: record.requestId, attemptId: record.currentAttemptId, phase, outcome, route: record.requestedModel?.route ?? 'local', requestedModelId: record.requestedModel?.modelId ?? null, actualModelId: record.actualModel?.modelId ?? null, errorCode: record.errorCode } };
    return assertDto('HistoryAppendRequest', result);
  }
  async function terminalHistory(client: PoolClient, record: Metadata, now: string, type = 1201): Promise<void> {
    const slot = (await client.query('SELECT delivery_id FROM transcription.history_outbox WHERE request_id=$1 AND terminal_slot AND state=$2 FOR UPDATE', [record.requestId, 'reserved'])).rows[0];
    if (!slot) fail('STATE_CONFLICT');
    await client.query("UPDATE transcription.history_outbox SET state='pending',event=$2 WHERE delivery_id=$1", [slot.delivery_id, event(record, slot.delivery_id, now, type === 1202 ? 'cancel' : 'terminal', record.taskState, type)]);
  }
  async function attempt(client: PoolClient, id: string): Promise<Metadata> {
    const result = (await client.query('SELECT metadata FROM transcription.attempts WHERE attempt_id=$1 FOR UPDATE', [id])).rows[0];
    if (!result) fail('STATE_CONFLICT');
    return result.metadata;
  }
  async function saveAttempt(client: PoolClient, value: Metadata): Promise<void> {
    assertDto('AttemptRecord', value);
    await client.query('UPDATE transcription.attempts SET metadata=$2,cost_amount=$3,cost_currency=$4 WHERE attempt_id=$1', [value.attemptId, value, value.cost?.amount ?? null, value.cost?.currency ?? null]);
  }

  async function operation(client: PoolClient, now: string, method: string, params: Metadata): Promise<unknown> {
    if (method === 'alerts.observe') return alerts.observe(client, params, now);
    if (method.startsWith('alerts.')) return alerts.execute(client, method, params);
    if (method === 'settings.get') { use(params.principal); return settings(client); }
    if (method === 'settings.set') {
      use(params.principal, 'transcription:settings:write');
      const old = await settings(client);
      if (old.revision !== params.expectedRevision) fail('STALE_REVISION');
      if (params.settings.policyVersion !== old.settings.policyVersion + 1) fail('STATE_CONFLICT');
      await capacity(client, 1);
      const snapshot = createPolicySnapshot(params.settings);
      const id = randomUUID();
      const fact = assertDto('HistoryAppendRequest', { id, type_id: 1301, occurred_at: now, actor_id: params.principal.ownerId,
        scope_type: 'system', scope_id: 'transcription', object_type: 'transcription_settings', object_id: 'policy',
        data: { phase: 'settings', requestId: null, policyVersion: snapshot.version, policySha256: snapshot.sha256 } });
      await client.query('UPDATE transcription.settings SET settings=$1,revision=revision+1 WHERE singleton', [params.settings]);
      await client.query("INSERT INTO transcription.history_outbox(delivery_id,state,event) VALUES($1,'pending',$2)", [id, fact]);
      return { settings: params.settings, revision: old.revision + 1 };
    }
    if (method === 'request.lookup') {
      use(params.principal);
      const principal = params.principal;
      const existing = (await client.query('SELECT metadata,input_sha256 FROM transcription.requests WHERE scope_type=$1 AND scope_id=$2 AND owner_id=$3 AND client_key=$4 FOR UPDATE', [principal.scopeType, principal.scopeId, principal.ownerId, params.clientIdempotencyKey])).rows[0];
      if (!existing) return { request: null };
      if (existing.input_sha256 !== params.normalizedInputSha256) fail('IDEMPOTENCY_CONFLICT');
      return { request: existing.metadata };
    }
    if (method === 'request.accept') {
      use(params.principal);
      const input = normalizedInput(params.input);
      const hash = inputHash(input);
      const { principal } = params;
      // AIDEV-NOTE: Idempotency проверяется прежде свежего artifact/policy; прежний snapshot не переписывается.
      const existing = (await client.query('SELECT metadata,input_sha256 FROM transcription.requests WHERE scope_type=$1 AND scope_id=$2 AND owner_id=$3 AND client_key=$4 FOR UPDATE', [principal.scopeType, principal.scopeId, principal.ownerId, input.clientIdempotencyKey])).rows[0];
      if (existing) { if (existing.input_sha256 !== hash) fail('IDEMPOTENCY_CONFLICT'); return { created: false, request: existing.metadata }; }
      if (params.artifact.ownerId !== principal.ownerId || params.artifact.artifactId.toLowerCase() !== input.audioArtifactId) fail('ARTIFACT_OWNER_MISMATCH');
      const current = await settings(client);
      if (canonicalHash(params.policySnapshot) !== canonicalHash(createPolicySnapshot(current.settings))) fail('STALE_REVISION');
      if (input.requestedModel?.route === 'external') { if (params.selectedModel !== null) fail('MODEL_MISMATCH'); }
      else if (params.selectedModel !== null && ((input.requestedModel && params.selectedModel.modelId !== input.requestedModel.modelId) || (!input.requestedModel && canonicalHash(params.selectedModel) !== canonicalHash(current.settings.defaultLocalModel)))) fail('MODEL_MISMATCH');
      await capacity(client, 2);
      if (!await alerts.hasCapacity(client)) fail('OVERLOADED');
      const request: Metadata = { requestId: randomUUID(), scope: { scopeType: principal.scopeType, scopeId: principal.scopeId }, ownerId: principal.ownerId,
        audioArtifactId: input.audioArtifactId, clientIdempotencyKey: input.clientIdempotencyKey, normalizedInputSha256: hash,
        requestedModel: input.requestedModel, selectedModel: params.selectedModel, policySnapshot: params.policySnapshot,
        inputMetadata: { mimeType: params.artifact.mimeType, sizeBytes: params.artifact.sizeBytes, audioDurationSeconds: null },
        taskState: 'accepted', resultState: 'not_ready', revision: 1, currentAttemptId: null, fenceGeneration: 0, deadlineAt: input.deadlineAt,
        resultExpiresAt: null, bufferOwnerInstanceId: null, actualModel: null, usage: null, cost: null, errorCode: null, createdAt: now, updatedAt: now };
      assertDto('RequestRecord', request);
      await client.query('INSERT INTO transcription.requests(request_id,scope_type,scope_id,owner_id,client_key,input_sha256,revision,task_state,metadata) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8)', [request.requestId, principal.scopeType, principal.scopeId, principal.ownerId, input.clientIdempotencyKey, hash, 'accepted', request]);
      await alerts.reserve(client, request.requestId);
      const acceptedId = randomUUID();
      await client.query("INSERT INTO transcription.history_outbox(delivery_id,request_id,terminal_slot,state,event) VALUES($1,$2,false,'pending',$3),($4,$2,true,'reserved',NULL)", [acceptedId, request.requestId, event(request, acceptedId, now, 'accepted', null), randomUUID()]);
      return { created: true, request };
    }
    if (method === 'request.get') return { request: (await row(client, params.requestId, params.principal)).metadata };
    if (method === 'request.cancel') {
      const current = await row(client, params.requestId, params.principal);
      checkRevision(current.metadata, params.expectedRevision);
      if (current.metadata.taskState !== 'accepted') return { accepted: false, stopConfirmed: false, request: current.metadata };
      const request = await save(client, current, { ...current.metadata, taskState: 'cancelled', resultState: 'not_ready', errorCode: null }, now, true);
      await terminalHistory(client, request, now, 1202);
      await alerts.release(client, request.requestId);
      return { accepted: true, stopConfirmed: true, request };
    }
    if (method === 'request.claim') {
      const current = (await client.query("SELECT * FROM transcription.requests WHERE task_state='accepted' AND (claim_token IS NULL OR lease_expires_at<=clock_timestamp()) ORDER BY metadata->>'createdAt',request_id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
      if (!current) return null;
      const record = { ...current.metadata, fenceGeneration: current.metadata.fenceGeneration + 1 };
      const token = randomUUID();
      const expiry = (await client.query(`SELECT ${timeSQL("clock_timestamp()+($1::bigint * interval '1 millisecond')")} AS expiry`, [config.requestLeaseMs])).rows[0].expiry;
      current.claim_token = token; current.worker_id = params.workerId; current.lease_expires_at = expiry;
      const request = await save(client, current, record, now);
      return { claimToken: token, fenceGeneration: request.fenceGeneration, revision: request.revision, leaseExpiresAt: expiry, request };
    }
    if (method === 'request.renew') {
      const current = await row(client, params.requestId); checkClaim(current, params);
      if (!['accepted', 'dispatching', 'running'].includes(current.metadata.taskState)) fail('STATE_CONFLICT');
      const expiry = (await client.query(`SELECT ${timeSQL("clock_timestamp()+($1::bigint * interval '1 millisecond')")} AS expiry`, [config.requestLeaseMs])).rows[0].expiry;
      current.lease_expires_at = expiry;
      const request = await save(client, current, current.metadata, now);
      return { claimToken: current.claim_token, fenceGeneration: request.fenceGeneration, revision: request.revision, leaseExpiresAt: expiry, request };
    }
    if (method === 'attempt.start') {
      const current = await row(client, params.requestId);
      checkRevision(current.metadata, params.expectedRevision);
      if (!current.lease_live || current.claim_token !== params.claimToken.toLowerCase() || current.metadata.fenceGeneration !== params.fenceGeneration) fail('STALE_CLAIM');
      if (current.metadata.taskState !== 'accepted' || current.metadata.currentAttemptId !== null) fail('STATE_CONFLICT');
      if ((await client.query('SELECT 1 FROM transcription.attempts WHERE attempt_id=$1', [params.attemptId])).rowCount) fail('STATE_CONFLICT');
      const request = await save(client, current, { ...current.metadata, taskState: 'dispatching', currentAttemptId: params.attemptId.toLowerCase() }, now);
      const record = { requestId: request.requestId, attemptId: params.attemptId.toLowerCase(), fenceGeneration: request.fenceGeneration, state: 'dispatching',
        selectedModel: request.selectedModel, actualModel: null, usage: null, cost: null, errorCode: null, startedAt: now, finishedAt: null, durationMs: null };
      assertDto('AttemptRecord', record);
      await client.query('INSERT INTO transcription.attempts(attempt_id,request_id,metadata) VALUES($1,$2,$3)', [record.attemptId, request.requestId, record]);
      return { created: true, request, attempt: record };
    }
    if (method === 'attempt.markRunning' || method === 'attempt.finish') {
      const current = await row(client, params.requestId); checkClaim(current, params);
      if (!['dispatching', 'running'].includes(current.metadata.taskState)) fail('STATE_CONFLICT');
      let record = await attempt(client, params.attemptId);
      if (record.requestId !== current.metadata.requestId || record.fenceGeneration !== params.fenceGeneration) fail('STATE_CONFLICT');
      if (method === 'attempt.markRunning') {
        if (current.metadata.taskState !== 'dispatching') fail('STATE_CONFLICT');
        const request = await save(client, current, { ...current.metadata, taskState: 'running' }, now);
        record = { ...record, state: 'running' }; await saveAttempt(client, record); return { request, attempt: record };
      }
      if (params.outcome === 'cancelled') fail('STATE_CONFLICT'); // Нынешний in-flight порт не подтверждает остановку.
      const success = params.outcome === 'succeeded';
      if (success && (params.actualModel === null || canonicalHash(params.actualModel) !== canonicalHash(current.metadata.selectedModel) || params.errorCode !== null)) fail('MODEL_MISMATCH');
      if (success) {
        if (!['available', 'delivery_unknown'].includes(params.resultState)) fail('STATE_CONFLICT');
      } else if (params.resultState !== 'not_ready' || params.resultExpiresAt !== null || params.bufferOwnerInstanceId !== null) fail('STATE_CONFLICT');
      if (['available', 'delivery_unknown'].includes(params.resultState)) {
        if (!params.resultExpiresAt || !params.bufferOwnerInstanceId || (await client.query('SELECT $1::timestamptz<=clock_timestamp() AS expired', [params.resultExpiresAt])).rows[0].expired) fail('INVALID_ARGUMENT');
      } else if (params.resultExpiresAt !== null || params.bufferOwnerInstanceId !== null) fail('STATE_CONFLICT');
      const request = await save(client, current, { ...current.metadata, taskState: params.outcome, actualModel: params.actualModel,
        usage: params.usage, cost: params.cost, errorCode: params.errorCode, resultState: params.resultState, resultExpiresAt: params.resultExpiresAt, bufferOwnerInstanceId: params.bufferOwnerInstanceId }, now, true);
      record = { ...record, state: params.outcome, actualModel: params.actualModel, usage: params.usage, cost: params.cost, errorCode: params.errorCode, durationMs: params.durationMs, finishedAt: now };
      await saveAttempt(client, record); await terminalHistory(client, request, now);
      if (!success) await alerts.problem(client, request, now);
      return { request, attempt: record };
    }
    if (method === 'result.setState') {
      const current = await row(client, params.requestId); checkRevision(current.metadata, params.expectedRevision);
      if (current.metadata.taskState !== 'succeeded' || !['available', 'delivery_unknown'].includes(current.metadata.resultState) || !['delivery_unknown', 'lost', 'expired'].includes(params.state)) fail('STATE_CONFLICT');
      if (params.state === 'delivery_unknown') {
        if (params.bufferOwnerInstanceId !== current.metadata.bufferOwnerInstanceId || params.resultExpiresAt !== current.metadata.resultExpiresAt) fail('STATE_CONFLICT');
        if ((await client.query('SELECT $1::timestamptz<=clock_timestamp() AS expired', [params.resultExpiresAt])).rows[0].expired) fail('RESULT_UNAVAILABLE');
      } else if (params.resultExpiresAt !== null || params.bufferOwnerInstanceId !== null) fail('STATE_CONFLICT');
      const expired = current.metadata.resultExpiresAt && (await client.query('SELECT $1::timestamptz<=clock_timestamp() AS expired', [current.metadata.resultExpiresAt])).rows[0].expired;
      const state = params.state === 'lost' && expired ? 'expired' : params.state;
      const request = await save(client, current, { ...current.metadata, resultState: state, resultExpiresAt: params.resultExpiresAt, bufferOwnerInstanceId: params.bufferOwnerInstanceId }, now);
      if (state === 'lost') await alerts.problem(client, request, now);
      if (state === 'expired') await alerts.release(client, request.requestId);
      return { request };
    }
    if (method === 'recovery.run') {
      const result = { dispatchingExpired: 0, runningExpired: 0, succeededBufferLost: 0, resultsExpired: 0 };
      const requests = (await client.query("SELECT *,lease_expires_at<=clock_timestamp() AS lease_expired,(metadata->>'resultExpiresAt')::timestamptz<=clock_timestamp() AS result_expired FROM transcription.requests WHERE (task_state IN ('dispatching','running') AND lease_expires_at<=clock_timestamp()) OR (task_state='succeeded' AND metadata->>'resultState' IN ('available','delivery_unknown') AND ((metadata->>'resultExpiresAt')::timestamptz<=clock_timestamp() OR metadata->>'bufferOwnerInstanceId'<>$1)) ORDER BY request_id LIMIT $2 FOR UPDATE SKIP LOCKED", [params.coordinatorInstanceId, config.recoveryBatchSize])).rows;
      for (const current of requests) {
        if (['dispatching', 'running'].includes(current.metadata.taskState) && current.lease_expired) {
          if (current.metadata.taskState === 'dispatching') result.dispatchingExpired++; else result.runningExpired++;
          const request = await save(client, current, { ...current.metadata, taskState: 'outcome_unknown', errorCode: 'REQUEST_OUTCOME_UNKNOWN', resultState: 'not_ready' }, now, true);
          const record = await attempt(client, request.currentAttemptId);
          await saveAttempt(client, { ...record, state: 'outcome_unknown', errorCode: 'REQUEST_OUTCOME_UNKNOWN', finishedAt: now });
          await terminalHistory(client, request, now);
          await alerts.problem(client, request, now);
        } else if (current.metadata.taskState === 'succeeded' && ['available', 'delivery_unknown'].includes(current.metadata.resultState)) {
          const expired = current.result_expired;
          if (!expired && current.metadata.bufferOwnerInstanceId === params.coordinatorInstanceId) continue;
          if (expired) result.resultsExpired++; else result.succeededBufferLost++;
          const request = await save(client, current, { ...current.metadata, resultState: expired ? 'expired' : 'lost', resultExpiresAt: null, bufferOwnerInstanceId: null }, now);
          if (expired) await alerts.release(client, request.requestId); else await alerts.problem(client, request, now);
        }
      }
      return result;
    }
    if (method === 'history.claim') {
      const current = (await client.query("SELECT * FROM transcription.history_outbox WHERE state='pending' OR (state='claimed' AND lease_expires_at<=clock_timestamp()) ORDER BY delivery_id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
      if (!current) return null;
      const token = randomUUID();
      const expiry = (await client.query(`SELECT ${timeSQL("clock_timestamp()+($1::bigint * interval '1 millisecond')")} AS expiry`, [config.historyLeaseMs])).rows[0].expiry;
      await client.query("UPDATE transcription.history_outbox SET state='claimed',claim_token=$2,lease_expires_at=$3 WHERE delivery_id=$1", [current.delivery_id, token, expiry]);
      return { deliveryId: current.delivery_id, claimToken: token, leaseExpiresAt: expiry, requestId: current.request_id, source: 'transcription', event: current.event };
    }
    if (method === 'history.ack' || method === 'history.fail') {
      const current = (await client.query('SELECT *,lease_expires_at>clock_timestamp() AS live FROM transcription.history_outbox WHERE delivery_id=$1 FOR UPDATE', [params.deliveryId])).rows[0];
      if (!current || current.state !== 'claimed' || !current.live || current.claim_token !== params.claimToken.toLowerCase()) fail('STALE_CLAIM');
      const state = method === 'history.ack' ? 'acknowledged' : params.errorCode === 'HISTORY_REJECTED' ? 'failed' : 'pending';
      await client.query('UPDATE transcription.history_outbox SET state=$2,claim_token=NULL,lease_expires_at=NULL,error_code=$3 WHERE delivery_id=$1', [params.deliveryId, state, method === 'history.ack' ? null : params.errorCode]);
      return method === 'history.ack' ? { acknowledged: true } : { failed: true };
    }
    return fail('INVALID_ARGUMENT');
  }

  return {
    /** Выполняет одну owner helper операцию; ответ проходит ту же owner схему. */
    async execute(method: string, input: unknown): Promise<unknown> {
      const pair = methodMap.helper[method];
      if (!pair) fail('INVALID_ARGUMENT');
      let params: Metadata;
      try { params = assertDto(pair[0], input) as Metadata; } catch { return fail('INVALID_ARGUMENT'); }
      if (method === 'health') {
        try {
          await this.ready();
          const backlog = await tx(async client => (await client.query("SELECT count(*) FILTER(WHERE state<>'acknowledged')::integer AS used,count(*) FILTER(WHERE state='failed')::integer AS failed FROM transcription.history_outbox")).rows[0]);
          const capacityAvailable = backlog.used + 2 <= config.historyCapacity && await tx(client => alerts.hasCapacity(client));
          return { available: backlog.failed === 0 && capacityAvailable, storageAvailable: true, capacityAvailable, historyRejected: backlog.failed > 0 };
        }
        catch { return { available: false, storageAvailable: false, capacityAvailable: false, historyRejected: false }; }
      }
      return tx(async (client, now) => {
        const value = await operation(client, now, method, params);
        try { return assertDto(pair[1], value); } catch { return fail('INTERNAL'); }
      });
    },
    /** Проверяет наличие owner migration и работоспособность БД; не создаёт таблицы. */
    async ready(): Promise<void> {
      try {
        const result = await pool.query('SELECT version FROM transcription.migrations WHERE version=2');
        if (!result.rowCount) fail('STORAGE_UNAVAILABLE');
      } catch { fail('STORAGE_UNAVAILABLE'); }
    },
    /** Освобождает переданный pool; не удаляет метаданные. */
    async close(): Promise<void> { await pool.end(); },
  };
}
