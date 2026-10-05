// ABOUTME: Связывает owner NATS contracts artifacts/local-ai/history с узкими портами координатора.
// ABOUTME: Проверяет byte limits до JSON decoding, нормализует metadata и не повторяет ambiguous запросы.
import type { NatsConnection } from 'nats';
import AjvImport from 'ajv';
import formatsImport from 'ajv-formats';
import { validateDto } from '#transcription-contracts';
import { encodeBoundedJson } from '../../runtime/stdio-rpc.js';
import type { CoordinatorRuntimeConfig } from '../config.js';

type Bounds = Pick<CoordinatorRuntimeConfig, 'dependencyTimeoutMs' | 'natsRequestBytes' | 'natsResponseBytes' | 'maxCatalogItems' | 'catalogPageSize'>;

async function request(nc: NatsConnection, subject: string, input: unknown, bounds: Bounds, errorCode: string,
  historyError?: (value: unknown) => boolean, artifact = false): Promise<unknown> {
  let bytes: Buffer;
  try { bytes = encodeBoundedJson(input, bounds.natsRequestBytes); }
  catch { throw { errorCode: historyError ? 'HISTORY_REJECTED' : errorCode, outcome: 'not_started' }; }
  let permanentRejection = false;
  let notFound = false;
  try {
    const response = await nc.request(subject, bytes, { timeout: bounds.dependencyTimeoutMs });
    if (response.data.byteLength > bounds.natsResponseBytes) throw new Error('Dependency unavailable');
    const code = response.headers?.get('Nats-Service-Error');
    const status = response.headers?.get('Nats-Service-Error-Code');
    if (code || status) {
      // Artifacts owner использует только Service error headers без error-body.
      notFound = artifact && code === 'NOT_FOUND' && status === '404';
      if (historyError) {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.data));
        const permanent = { INVALID_ARGUMENT: '400', EVENT_ID_CONFLICT: '409', REQUEST_TOO_LARGE: '413' };
        permanentRejection = Boolean(historyError(value) && (value as any).code === code &&
          (value as any).retryable === false && Object.hasOwn(permanent, code!) && permanent[code as keyof typeof permanent] === status);
      }
      throw new Error('Dependency unavailable');
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.data));
  } catch { throw { errorCode: permanentRejection ? 'HISTORY_REJECTED' : notFound ? 'NOT_FOUND' : errorCode,
    outcome: permanentRejection ? 'failed' : 'unknown' }; }
}

/** Загружает только опубликованные owner schemas; local-ai отсутствие означает typed outage, а не пустой каталог. */
export async function createDependencyPorts(nc: NatsConnection, localAi: NatsConnection | undefined, bounds: Bounds) {
  const anchor = import.meta.resolve('#transcription-contracts');
  const artifacts = await import(new URL('../../artifacts/contracts/index.mjs', anchor).href);
  const local = await import(new URL('../../local-ai/contracts/index.mjs', anchor).href);
  const common = (await import(new URL('../../history/schemas/common.schema.json', anchor).href, { with: { type: 'json' } })).default;
  const messages = (await import(new URL('../../history/schemas/messages.schema.json', anchor).href, { with: { type: 'json' } })).default;
  const Ajv = AjvImport as unknown as typeof AjvImport.default;
  const addFormats = formatsImport as unknown as typeof formatsImport.default;
  const ajv = new Ajv({ strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
  addFormats(ajv); ajv.addSchema(common); ajv.addSchema(messages);
  const historyResponse = ajv.getSchema(`${messages.$id}#/definitions/appendResponse`)!;
  const historyError = ajv.getSchema(`${messages.$id}#/definitions/serviceError`)!;
  return {
    artifacts: {
      async get(input: { artifactId: string }): Promise<unknown> {
        if (!artifacts.validateRequest(artifacts.subjects.get, input)) throw { errorCode: 'INVALID_ARGUMENT' };
        const result = await request(nc, artifacts.subjects.get, input, bounds, 'DEPENDENCY_UNAVAILABLE', undefined, true) as any;
        if (!artifacts.validateResponse(artifacts.subjects.get, result)) throw { errorCode: 'DEPENDENCY_UNAVAILABLE' };
        if (result.status !== 'ready') throw { errorCode: 'ARTIFACT_NOT_READY' };
        const normalized = { artifactId: result.artifactId, ownerId: result.ownerId, state: 'ready', mimeType: result.mimeType, sizeBytes: result.sizeBytes };
        if (!validateDto('ArtifactMetadata', normalized) || result.artifactId.toLowerCase() !== input.artifactId.toLowerCase()) throw { errorCode: 'DEPENDENCY_UNAVAILABLE' };
        return normalized;
      },
    },
    localCatalog: {
      async list(): Promise<unknown> {
        if (!localAi) throw { errorCode: 'MODEL_CATALOG_UNAVAILABLE' };
        const items: unknown[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let scanned = 0;
        do {
          const input = { filter: { operation: 'transcribe', inputKind: 'audio_artifact', outputKind: 'transcription' },
            page: { limit: Math.min(bounds.catalogPageSize, bounds.maxCatalogItems - scanned), ...(cursor ? { cursor } : {}) } };
          if (!local.validateRequest(local.subjects.modelsList, input)) throw { errorCode: 'MODEL_CATALOG_UNAVAILABLE' };
          const result = await request(localAi, local.subjects.modelsList, input, bounds, 'MODEL_CATALOG_UNAVAILABLE') as any;
          if (!local.validateResponse(local.subjects.modelsList, result) || scanned + result.items.length > bounds.maxCatalogItems) throw { errorCode: 'MODEL_CATALOG_UNAVAILABLE' };
          scanned += result.items.length;
          for (const card of result.items) {
            // Unsupported карточка без profileId не обозначает исполнимый selector.
            if (card.supported === false && !card.profileId) continue;
            if (!card.operations.includes('transcribe') || !card.inputKinds.includes('audio_artifact') || !card.outputKinds.includes('transcription')) continue;
            const normalized = { selector: { modelId: card.modelId, revision: card.revision, profileId: card.profileId },
              supported: card.supported, installed: card.installationState === 'installed', ready: card.runtimeState === 'ready' };
            if (!validateDto('ModelSummary', normalized)) throw { errorCode: 'MODEL_CATALOG_UNAVAILABLE' };
            items.push(normalized);
          }
          cursor = result.nextCursor ?? undefined;
          if (cursor) {
            if (!result.items.length || scanned >= bounds.maxCatalogItems || cursors.has(cursor)) throw { errorCode: 'MODEL_CATALOG_UNAVAILABLE' };
            cursors.add(cursor);
          }
        } while (cursor);
        return items;
      },
    },
    history: {
      async append(input: unknown): Promise<unknown> {
        if (!validateDto('HistoryAppendRequest', input)) throw { errorCode: 'INVALID_ARGUMENT', outcome: 'not_started' };
        const result = await request(nc, 'brai.history.v1.append.transcription', input, bounds, 'HISTORY_DELIVERY_FAILED', historyError);
        if (!historyResponse(result)) throw { errorCode: 'HISTORY_DELIVERY_FAILED', outcome: 'unknown' };
        const event = (result as any).event;
        if (event.id !== (input as any).id || event.source !== 'transcription') throw { errorCode: 'HISTORY_DELIVERY_FAILED', outcome: 'unknown' };
        return result;
      },
    },
  };
}
