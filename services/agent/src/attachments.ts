// ABOUTME: Связывает native сообщения с устойчивыми references владельца artifacts.
// ABOUTME: Байты существуют только в ограниченном HTTP буфере перед native вызовом.
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import type { NatsConnection } from 'nats';
import { ServiceErrorHeader, ServiceErrorCodeHeader } from 'nats';
import { subjects, validateRequest, validateResponse } from '../../artifacts/contracts/index.mjs';
import type { Artifact, ArtifactReference, ReferenceScope, ReferenceAttachment } from '../../artifacts/contracts/index.mjs';
import type { Command, DisplayAttachment, DisplayItem } from '../contracts/index.mjs';
import { limits } from '../contracts/index.mjs';
import type { CodexPort } from './codex.js';
export type ArtifactsConfig = { baseUrl: string; timeoutMs?: number };
export type ArtifactsPort = { request(subject: string, value: unknown, options?: { timeoutMs: number }): Promise<any>; fetch: typeof fetch };
const prefix = 'brai:agent:v3:';
const fail = (code: string, outcome = 'not-sent'): never => { throw Object.assign(new Error(code), { code, outcome }); };
/** Проверяет единственный контракт владельца и стандартные заголовки NATS Services. */
export function createArtifactsPort(nc: NatsConnection, timeoutMs = 10000): ArtifactsPort {
  return { fetch: globalThis.fetch, async request(subject, value, options) {
    if (!validateRequest(subject, value)) fail('INVALID_ARGUMENT');
    const reply = await nc.request(subject, Buffer.from(JSON.stringify(value)), { timeout: Math.min(timeoutMs, options?.timeoutMs ?? timeoutMs) });
    if (reply.data.length > limits.state) fail('UPSTREAM_UNAVAILABLE', 'query');
    const error = reply.headers?.get(ServiceErrorHeader), status = reply.headers?.get(ServiceErrorCodeHeader);
    if (Boolean(error) !== Boolean(status) || status && !/^[45][0-9]{2}$/.test(status)) fail('UPSTREAM_UNAVAILABLE', 'query');
    if (error) fail(reply.headers?.get(ServiceErrorCodeHeader) === '404' ? 'NOT_FOUND' : reply.headers?.get(ServiceErrorCodeHeader) === '409' ? 'OPERATION_CONFLICT' : 'UPSTREAM_UNAVAILABLE', 'query');
    let result: any;
    try { result = JSON.parse(Buffer.from(reply.data).toString()); } catch { fail('UPSTREAM_UNAVAILABLE', 'query'); }
    if (!validateResponse(subject, result)) fail('UPSTREAM_UNAVAILABLE', 'query');
    return result;
  } };
}
/** SHA-256 канонического native payload; не сохраняет исходные image inputs. */
export function nativeHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex');
}
/** Ограниченная корреляция использует только точный persisted native clientId и scope. */
export function createAttachments(codex: CodexPort, config: ArtifactsConfig | undefined, port?: ArtifactsPort) {
  const base = config ? new URL(config.baseUrl) : undefined;
  if (base && (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) || config?.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 10000)) throw new Error('INVALID_AGENT_CONFIG');
  const budget = config?.timeoutMs ?? 10000;
  function remaining(deadline: number, generation: string): number {
    if (generation !== codex.status().generation) fail('STALE_GENERATION', 'query');
    const left = Math.ceil(deadline - performance.now());
    if (left <= 0) fail('TIMEOUT', 'query');
    return left;
  }
  async function query(subject: string, value: unknown, deadline = performance.now() + budget, generation = codex.status().generation) {
    const result = await ready().request(subject, value, { timeoutMs: remaining(deadline, generation) });
    remaining(deadline, generation);
    return result;
  }
  const unresolved = new Set<string>();
  const itemKey = (r: Command, itemId: string) => JSON.stringify([r.ownerId, r.projectId, r.threadId, itemId]);
  function ready(): ArtifactsPort { if (!port || !config) fail('UPSTREAM_UNAVAILABLE'); return port!; }
  const scope = (r: Command): ReferenceScope => ({ ownerId: r.ownerId!, projectId: r.projectId!, threadId: r.threadId!, operationId: r.operationId! });
  const clientId = (r: Command) => prefix + r.operationId;
  async function get(r: Command, deadline = performance.now() + budget, generation = codex.status().generation): Promise<ArtifactReference | null> {
    try { return (await query(subjects.referenceGet, { scope: scope(r) }, deadline, generation)).reference; }
    catch (error: any) { if (error.code === 'NOT_FOUND') return null; throw error; }
  }
  async function state(reference: ArtifactReference, value: 'unknown' | 'not-sent', deadline = performance.now() + budget) {
    return (await query(subjects.referenceUpdateState, { scope: reference.scope, state: value }, deadline)).reference as ArtifactReference;
  }
  function matching(reference: ArtifactReference, r: Command) {
    if (Object.entries(scope(r)).some(([key, value]) => reference.scope[key as keyof ReferenceScope] !== value) || reference.clientUserMessageId !== clientId(r) || reference.attachments.length !== r.attachments?.length || reference.attachments.some((pair, i) => pair.originalArtifactId !== r.attachments![i].originalArtifactId || pair.modelArtifactId !== r.attachments![i].modelArtifactId)) fail('OPERATION_CONFLICT');
  }
  function scoped(artifact: Artifact, r: Command) {
    if (artifact.ownerId !== r.ownerId || artifact.source !== 'agent' || artifact.details?.projectId !== r.projectId || artifact.details?.threadId !== r.threadId) fail('INVALID_ARGUMENT');
  }
  async function modelInput(r: Command, deadline = performance.now() + budget): Promise<{ type: string; url: string }[]> {
    const api = ready(), generation = codex.status().generation, output = []; let aggregate = 0;
    for (const pair of r.attachments ?? []) {
      const original: Artifact = await query(subjects.get, { artifactId: pair.originalArtifactId }, deadline, generation);
      const model: Artifact = pair.modelArtifactId === pair.originalArtifactId ? original : await query(subjects.get, { artifactId: pair.modelArtifactId }, deadline, generation);
      scoped(original, r); scoped(model, r);
      if (original.artifactId !== pair.originalArtifactId || model.artifactId !== pair.modelArtifactId) fail('INVALID_ARGUMENT');
      if (original.kind !== 'original' || pair.modelArtifactId !== pair.originalArtifactId && model.kind !== 'copy') fail('INVALID_ARGUMENT');
      if (original.status !== 'ready' || model.status !== 'ready') fail('NOT_FOUND');
      if (pair.modelArtifactId !== pair.originalArtifactId) {
        const relations = await query(subjects.relationList, { artifactId: pair.modelArtifactId }, deadline, generation);
        if (!relations.items.some((relation: ReferenceAttachment) => relation.modelArtifactId === pair.modelArtifactId && relation.originalArtifactId === pair.originalArtifactId)) fail('INVALID_ARGUMENT');
      }
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(model.mimeType) || !Number.isSafeInteger(model.sizeBytes) || model.sizeBytes! < 1 || aggregate + model.sizeBytes! > limits.imageBytes) fail('INVALID_ARGUMENT');
      const url = new URL(model.internalUrl!);
      // AIDEV-NOTE: Metadata не может перенаправить model read к произвольному серверу.
      if (url.origin !== base!.origin || url.username || url.password || url.search || url.hash || url.pathname !== base!.pathname.replace(/\/$/, '') + '/files/' + model.artifactId) fail('INVALID_ARGUMENT');
      const response = await api.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(remaining(deadline, generation)) });
      try { remaining(deadline, generation); } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
      if (!response.ok || !response.body || !['application/octet-stream', model.mimeType].includes(response.headers.get('content-type')?.split(';')[0] ?? '')) { void response.body?.cancel().catch(() => {}); fail('NOT_FOUND'); }
      const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); remaining(deadline, generation); if (part.done) break; size += part.value.length; if (aggregate + size > limits.imageBytes || size > model.sizeBytes!) fail('INVALID_ARGUMENT'); chunks.push(part.value); } }
      catch (error) { void reader.cancel().catch(() => {}); throw error; }
      const data = Buffer.concat(chunks);
      if (size !== model.sizeBytes || createHash('sha256').update(data).digest('hex') !== model.sha256 || !signature(data, model.mimeType)) fail('INVALID_ARGUMENT');
      aggregate += size; output.push({ type: 'image', url: `data:${model.mimeType};base64,${data.toString('base64')}` });
    }
    remaining(deadline, generation);
    return output;
  }
  async function recover(reference: ArtifactReference, deadline = performance.now() + 8000, acknowledgedTurnId?: string): Promise<ArtifactReference> {
    if (reference.state === 'confirmed' || reference.state === 'not-sent') return reference;
    const generation = codex.status().generation, matches = new Map<string, { turnId: string; itemId: string }>();
    let cursor: string | undefined, complete = false;
    for (let page = 0; page < 1000; page++) {
      if (performance.now() >= deadline) break;
      // AIDEV-NOTE: ACK задаёт точный turn; старые ходы не расходуют бюджет подтверждения нового ввода.
      const result = await codex.call('thread/items/list', { threadId: reference.scope.threadId, ...(acknowledgedTurnId ? { turnId: acknowledgedTurnId } : {}), limit: 10, sortDirection: 'desc', ...(cursor ? { cursor } : {}) }, { timeoutMs: Math.max(1, deadline - performance.now()) });
      if (generation !== codex.status().generation) return state(reference, 'unknown', deadline);
      for (const entry of result.data) if ((!acknowledgedTurnId || entry.turnId === acknowledgedTurnId) && entry.item.type === 'userMessage' && entry.item.clientId === reference.clientUserMessageId) matches.set(`${entry.turnId}\0${entry.item.id}`, { turnId: entry.turnId, itemId: entry.item.id });
      if (!result.nextCursor) { complete = true; break; }
      if (!result.data.length || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }
    if (!complete || matches.size !== 1) {
      if (performance.now() >= deadline) return { ...reference, state: 'unknown' };
      return state(reference, 'unknown', deadline);
    }
    const match = [...matches.values()][0];
    return (await query(subjects.referenceConfirm, { scope: reference.scope, clientUserMessageId: reference.clientUserMessageId, ...match }, deadline, generation)).reference;
  }
  async function result(reference: ArtifactReference, r: Command, acknowledgedTurnId?: string) {
    let recovered: ArtifactReference;
    try { recovered = await recover(reference, performance.now() + 8000, acknowledgedTurnId); } catch { fail('UPSTREAM_UNAVAILABLE', 'unknown'); }
    if (recovered!.state === 'confirmed') return { generation: codex.status().generation, operationId: r.operationId, outcome: 'accepted', threadId: r.threadId, turnId: recovered!.turnId };
    fail('UPSTREAM_UNAVAILABLE', recovered!.state === 'not-sent' ? 'not-sent' : 'unknown');
  }
  /** Existing reserve не разрешает повтор. При удалении object повтор также остаётся unknown. */
  async function existing(r: Command, build: (images: { type: string; url: string }[]) => unknown) {
    let reference: ArtifactReference | null;
    try { reference = await get(r); } catch { fail('UPSTREAM_UNAVAILABLE', 'unknown'); }
    if (!reference!) return null;
    matching(reference, r);
    try { if (nativeHash(build(await modelInput(r))) !== reference.commandHash) fail('OPERATION_CONFLICT'); }
    catch (error: any) { if (error.code === 'OPERATION_CONFLICT') throw error; fail('UPSTREAM_UNAVAILABLE', 'unknown'); }
    return result(reference, r);
  }
  /** Reserve атомарно выбирает единственного отправителя; потеря ответа не разрешает send. */
  async function reserve(r: Command, payload: any) {
    const deadline = performance.now() + budget;
    try {
      const value = await query(subjects.referenceReserve, { scope: scope(r), clientUserMessageId: clientId(r), commandHash: nativeHash(payload), attachments: r.attachments }, deadline);
      matching(value.reference, r);
      if (value.reference.commandHash !== nativeHash(payload)) fail('OPERATION_CONFLICT');
      if (!value.created) return { reference: value.reference as ArtifactReference, created: false };
      return { reference: value.reference as ArtifactReference, created: true };
    } catch (error: any) {
      if (error.code === 'OPERATION_CONFLICT') throw error;
      // AIDEV-NOTE: Даже если get не находит reserve, ответ мог быть потерян до фиксации.
      try { const found = await get(r, deadline); if (found) { matching(found, r); await state(found, 'unknown', deadline); } } catch { /* Исход reserve остаётся unknown. */ }
      fail('UPSTREAM_UNAVAILABLE', 'unknown');
    }
  }
  /** Decorates только RPC ответ текущего owner; shared session и события остаются без metadata. */
  async function decorate(r: Command, items: DisplayItem[]): Promise<DisplayItem[]> {
    const generation = codex.status().generation, deadline = performance.now() + budget;
    let unavailable = false;
    const copy = structuredClone(items); if (!r.ownerId || !items.length) return copy;
    try {
      ready();
      const references: ArtifactReference[] = (await query(subjects.referenceList, { scope: { ownerId: r.ownerId, projectId: r.projectId, threadId: r.threadId }, nativeItemIds: items.map(item => item.id) }, deadline, generation)).items;
      for (const item of copy) {
        const reference = references.find(ref => ref.state === 'confirmed' && ref.scope.ownerId === r.ownerId && ref.scope.projectId === r.projectId && ref.scope.threadId === r.threadId && ref.itemId === item.id && ref.turnId === item.turnId);
        if (!reference) { if (unresolved.has(itemKey(r, item.id))) item.attachmentsState = 'unavailable'; continue; }
        item.operationId = reference.scope.operationId;
        item.attachmentsState = 'ready'; item.attachments = [];
        for (const pair of reference.attachments) {
          const attachment: DisplayAttachment = { ...pair, status: 'unavailable' };
          if (unavailable) { item.attachmentsState = 'unavailable'; item.attachments.push(attachment); continue; }
          try {
            const model: Artifact = await query(subjects.get, { artifactId: pair.modelArtifactId }, deadline, generation);
            const original: Artifact = pair.originalArtifactId === pair.modelArtifactId ? model : await query(subjects.get, { artifactId: pair.originalArtifactId }, deadline, generation);
            // AIDEV-NOTE: Сохранённый binding переживает редактирование source/details; authority — scope reference и неизменный owner/ID.
            if (model.ownerId !== r.ownerId || original.ownerId !== r.ownerId || model.artifactId !== pair.modelArtifactId || original.artifactId !== pair.originalArtifactId) fail('INVALID_ARGUMENT');
            attachment.mimeType = model.mimeType; attachment.filename = original.filename;
            attachment.status = [model.status, original.status].some(status => status === 'deleted' || status === 'deleting') ? 'deleted' : model.status === 'ready' && original.status === 'ready' ? 'ready' : 'unavailable';
            if (attachment.status === 'ready') attachment.url = `/api/agent/attachments/${pair.modelArtifactId}?` + new URLSearchParams({ projectId: r.projectId!, threadId: r.threadId!, expectedUserId: r.ownerId, itemId: item.id, turnId: item.turnId }).toString();
          } catch { unavailable = true; item.attachmentsState = 'unavailable'; }
          item.attachments.push(attachment);
        }
      }
    } catch { for (const item of copy) if (item.type === 'userMessage' && item.imageCount) item.attachmentsState = 'unavailable'; }
    if (generation !== codex.status().generation) fail('STALE_GENERATION', 'query');
    return copy;
  }
  /** Page native clientId восстанавливает только собственный scope; чужие IDs не подтверждаются. */
  async function recoverItems(r: Command, entries: any[]) {
    if (!r.ownerId || !port || !config) return;
    for (const entry of entries) if (entry.item.type === 'userMessage' && typeof entry.item.clientId === 'string' && entry.item.clientId.startsWith(prefix)) unresolved.add(itemKey(r, entry.item.id));
    while (unresolved.size > limits.operations) unresolved.delete(unresolved.values().next().value!);
    const seen = new Set<string>(), deadline = performance.now() + 8000, generation = codex.status().generation;
    for (const entry of entries) {
      const id = entry.item.clientId;
      if (entry.item.type !== 'userMessage' || typeof id !== 'string' || !id.startsWith(prefix) || !id.slice(prefix.length) || seen.has(id)) continue;
      seen.add(id);
      if (performance.now() >= deadline || generation !== codex.status().generation) break;
      try {
        const reference = await get({ ...r, operationId: id.slice(prefix.length) }, deadline, generation);
        if (reference && reference.clientUserMessageId === id) {
          const key = itemKey(r, entry.item.id);
          unresolved.add(key);
          while (unresolved.size > limits.operations) unresolved.delete(unresolved.values().next().value!);
          if ((await recover(reference, deadline)).state === 'confirmed') unresolved.delete(key);
        } else unresolved.delete(itemKey(r, entry.item.id));
      } catch { /* После сбоя metadata не запускаем последовательные ожидания для остальных ID. */ break; }
    }
  }
  return { modelInput, reserve, existing, recover, result, state, decorate, recoverItems, clientId };
}
function signature(data: Buffer, mime: string): boolean {
  if (mime === 'image/png') return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255;
  return mime === 'image/webp' && data.length >= 12 && data.subarray(0, 4).equals(Buffer.from('RIFF')) && data.subarray(8, 12).equals(Buffer.from('WEBP'));
}
