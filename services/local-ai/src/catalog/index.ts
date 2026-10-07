// ABOUTME: Реализует прикладные операции каталога, настроек и снятия установки.
// ABOUTME: Runtime readiness читается из памяти, а изменения метаданных фиксируются независимо от истории.
import { randomUUID } from 'node:crypto';
import { LocalAiError } from '../errors.js';
import type { LocalAiStore, ModelIdleGuard, ModelSettingsChangedPort, HistoryFactPort } from '../ports.js';
import type { InstallationRecord, LocalAiHistoryMetadataEvent, LocalAiTx, ModelCard, ModelFilter, ModelRecord, ModelSettings, OperationContext, RuntimeState } from '../types.js';

export type CatalogDependencies = ModelIdleGuard & ModelSettingsChangedPort & {
  readRuntimeState(modelId: string, revision: string): RuntimeState | null;
  now?: () => string;
  history?: HistoryFactPort;
  refreshModel?(modelId: string): Promise<void>;
  cleanupPublished?(record: InstallationRecord): Promise<void>;
};

export type LocalAiCatalog = {
  list(filter: ModelFilter): Promise<ModelCard[]>;
  get(modelId: string): Promise<ModelCard>;
  settings(modelId: string): Promise<ModelSettings>;
  configure(input: { modelId: string; revision: string; profileId: string; idleUnloadSeconds: number | null }, context: OperationContext): Promise<{ modelId: string; revision: string; profileId: string; idleUnloadSeconds: number | null }>;
  remove(modelId: string, revision: string, profileId: string, context: OperationContext): Promise<InstallationRecord>;
};

function catalogEvent(
  input: { operation: 'configure' | 'remove'; record: ModelRecord; actorId: string; operationId: string; revision?: string; profileId?: string; now: string; durationMs: number },
): LocalAiHistoryMetadataEvent {
  const remove = input.operation === 'remove';
  return {
    id: randomUUID(), type_id: remove ? 103 : 1301, occurred_at: input.now,
    actor_id: input.actorId, scope_type: 'system', scope_id: 'local_ai',
    object_type: remove ? 'installation' : 'model', object_id: input.record.modelId,
    data: {
      operation: input.operation, modelId: input.record.modelId, outcome: 'succeeded',
      revision: input.revision ?? input.record.revision,
      ...((input.profileId ?? input.record.profileId) !== null ? { profileId: input.profileId ?? input.record.profileId } : {}),
      operationId: input.operationId, durationMs: input.durationMs,
    },
  };
}

/** Подключает каталог к хранилищу и к состоянию runtime, не сохраняя process readiness в БД. */
export function createCatalog(store: LocalAiStore, dependencies: CatalogDependencies): LocalAiCatalog {
  const now = dependencies.now ?? (() => new Date().toISOString());

  async function card(record: ModelRecord, tx: LocalAiTx): Promise<ModelCard> {
    const installed = await tx.installations.get(record.modelId, record.revision);
    return {
      ...record,
      installationState: !record.supported ? 'unsupported' : installed ? 'installed' : 'not_installed',
      runtimeState: installed ? dependencies.readRuntimeState(record.modelId, record.revision) : null,
    };
  }

  return {
    async list(filter) {
      const { ready, ...catalogFilter } = filter;
      const cards = await store.transaction(async tx => {
        const records = await tx.models.list(catalogFilter);
        return Promise.all(records.map(value => card(value, tx)));
      });
      return ready === undefined ? cards : cards.filter(value => (value.runtimeState === 'ready') === ready);
    },
    async get(modelId) {
      return store.transaction(async tx => {
        const record = await tx.models.get(modelId);
        if (!record) throw new LocalAiError('MODEL_NOT_FOUND', 'MODEL_NOT_FOUND');
        return card(record, tx);
      });
    },
    async settings(modelId) {
      return store.transaction(async tx => {
        if (!await tx.models.get(modelId)) throw new LocalAiError('MODEL_NOT_FOUND', 'MODEL_NOT_FOUND');
        return await tx.settings.get(modelId) ?? { idleUnloadSeconds: 600 };
      });
    },
    async configure(input, context) {
      const startedAt = Date.now();
      if (input.idleUnloadSeconds !== null && (!Number.isSafeInteger(input.idleUnloadSeconds) || input.idleUnloadSeconds < 1 || input.idleUnloadSeconds > 2_147_483_647)) {
        throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_SETTINGS');
      }
      let fact: LocalAiHistoryMetadataEvent | undefined;
      const configured = await store.transaction(async tx => {
        const model = await tx.models.get(input.modelId);
        if (!model) throw new LocalAiError('MODEL_NOT_FOUND', 'MODEL_NOT_FOUND');
        if (!model.supported || model.profileId === null) throw new LocalAiError('NOT_SUPPORTED', 'MODEL_PROFILE_UNAVAILABLE');
        if (model.revision !== input.revision || model.profileId !== input.profileId) throw new LocalAiError('REVISION_CONFLICT', 'MODEL_SELECTOR_MISMATCH');
        const value: ModelSettings = { idleUnloadSeconds: input.idleUnloadSeconds };
        await tx.settings.put(input.modelId, value);
        fact = catalogEvent({ operation: 'configure', record: model, revision: input.revision, profileId: input.profileId, actorId: context.ownerId, operationId: context.operationId, now: now(), durationMs: Math.max(0, Date.now() - startedAt) });
        return { modelId: model.modelId, revision: input.revision, profileId: input.profileId, idleUnloadSeconds: value.idleUnloadSeconds };
      });
      dependencies.settingsChanged(configured.modelId, { idleUnloadSeconds: configured.idleUnloadSeconds });
      try { if (fact) dependencies.history?.publish(fact); } catch { /* Потеря истории не меняет итог управления. */ }
      return configured;
    },
    async remove(modelId, revision, profileId, context) {
      const startedAt = Date.now();
      return dependencies.withModelIdleLock(modelId, async () => {
        let fact: LocalAiHistoryMetadataEvent | undefined;
        const removed = await store.transaction(async tx => {
          const model = await tx.models.get(modelId);
          if (!model) throw new LocalAiError('MODEL_NOT_FOUND', 'MODEL_NOT_FOUND');
          if (!model.supported || model.profileId === null) throw new LocalAiError('NOT_SUPPORTED', 'MODEL_PROFILE_UNAVAILABLE');
          if (model.revision !== revision || model.profileId !== profileId) throw new LocalAiError('REVISION_CONFLICT', 'MODEL_SELECTOR_MISMATCH');
          const installation = await tx.installations.get(modelId, revision);
          if (!installation) throw new LocalAiError('MODEL_NOT_INSTALLED', 'MODEL_NOT_INSTALLED');
          if (installation.profileId !== profileId) throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_PROFILE_MISMATCH');
          await tx.installations.remove(modelId, revision);
          fact = catalogEvent({ operation: 'remove', record: model, revision, profileId: installation.profileId, actorId: context.ownerId, operationId: context.operationId, now: now(), durationMs: Math.max(0, Date.now() - startedAt) });
          return installation;
        });
        await dependencies.refreshModel?.(modelId);
        await dependencies.cleanupPublished?.(removed);
        try { if (fact) dependencies.history?.publish(fact); } catch { /* Потеря истории не меняет итог управления. */ }
        return removed;
      });
    },
  };
}
