// ABOUTME: Ищет публичные модели Hugging Face и устанавливает только закреплённые профили.
// ABOUTME: Не принимает токены и команды из карточек; установка публикуется после проверки всех файлов.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { HistoryFactPort, LocalAiStore } from '../ports.js';
import { LocalAiError } from '../errors.js';
import type {
  InstallationOperation, InstallationRecord, LocalAiHistoryMetadataEvent, ModelFile, ModelRecord,
} from '../types.js';

const HUB_ORIGIN = 'https://huggingface.co';
const HUB_MODELS_PATH = '/api/models';
const SEARCH_EXPANSIONS = ['sha', 'tags', 'private', 'gated'] as const;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const REVISION = /^[\da-f]{40}$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,255}$/;
const MAX_SEARCH_RESPONSE_BYTES = 1_048_576;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_BYTES = 2048;

export type ProfileFileManifest = Readonly<{ path: string; bytes: number; sha256: string; url?: string }>;
export type SupportedProfile = Readonly<{
  profileId: string;
  modelId: string;
  repository: string;
  revision: string;
  files: readonly ProfileFileManifest[];
  record: ModelRecord;
}>;

type PublicSearchInput = {
  query: string;
  filter?: { operation?: 'embed' | 'transcribe' | 'synthesize'; inputKind?: 'text' | 'image_artifact' | 'audio_artifact' | 'video_artifact'; outputKind?: 'vector' | 'transcription' | 'audio_artifact'; language?: string };
  page?: { cursor?: string; limit?: number };
};

export type HuggingFaceCatalogOptions = {
  profiles: readonly SupportedProfile[];
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  maxQueryLength?: number;
  maxPageSize?: number;
};

export type HuggingFaceCatalog = {
  /** Ищет только публичные карточки по тексту и закреплённым атрибутам; cursor не задаёт URL. */
  search(input: PublicSearchInput): Promise<{ items: ModelRecord[]; nextCursor: string | null }>;
};

export type InstallRequest = Readonly<{
  modelId: string;
  revision: string;
  profileId: string;
  requestId: string;
  ownerId: string;
  deadlineAt: string;
}>;

export type InstallerLimits = Readonly<{
  maxDownloadBytes: number;
  maxFiles: number;
  maxParallel: number;
  maxOperationMs: number;
}>;

export type ModelInstaller = {
  /** Принимает установку с requestId как owner-scoped operationId; повтор возвращает сохранённое состояние. */
  start(request: InstallRequest): Promise<InstallationOperation>;
  /** Читает установку только в области указанного владельца. */
  get(operationId: string, ownerId: string): Promise<InstallationOperation>;
  /** Запрашивает отмену; terminal state устанавливается после остановки и очистки. */
  cancel(operationId: string, ownerId: string): Promise<InstallationOperation>;
  /** Регистрирует уже имеющиеся байты только в точном каталоге закреплённого профиля после повторной проверки хешей. */
  importVerified(input: { modelId: string; revision: string; profileId: string; directory: string }): Promise<InstallationRecord>;
  /** Удаляет только принадлежащую local-ai директорию, если каталог больше на неё не ссылается. */
  cleanupPublished(record: InstallationRecord): Promise<void>;
  /** Удаляет только UUID-временные каталоги известных профилей после startup recovery и до начала новых операций. */
  cleanupAbandonedStaging(): Promise<number>;
  /** Останавливает приём, отменяет загрузки и ждёт terminal updates и очистку. */
  close(): Promise<void>;
};

export type ModelInstallerOptions = {
  store: LocalAiStore;
  history?: HistoryFactPort;
  installed?(modelId: string): Promise<void>;
  /** Согласует установку с invoke/load/remove; освобождение происходит после terminal update и cleanup. */
  acquireModelIdleLock?(modelId: string): Promise<() => void>;
  profiles: readonly SupportedProfile[];
  rootDirectory: string;
  fetchImpl?: typeof fetch;
  now?: () => string;
  limits?: Partial<InstallerLimits>;
};

/** Подключает поиск только к публичному Hub API и помечает поддержанными лишь подготовленные профили. */
export function createHuggingFaceCatalog(options: HuggingFaceCatalogOptions): HuggingFaceCatalog {
  const profiles = indexProfiles(options.profiles);
  for (const [repository, profile] of profiles.byRepository) if (profile.files.some(file => file.url)) profiles.byRepository.delete(repository);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = positive(options.requestTimeoutMs ?? 5_000, 60_000, 'INVALID_HUB_TIMEOUT');
  const maxQueryLength = positive(options.maxQueryLength ?? 200, 1_000, 'INVALID_SEARCH_LIMIT');
  const maxPageSize = positive(options.maxPageSize ?? 20, MAX_PAGE_SIZE, 'INVALID_SEARCH_LIMIT');

  return {
    async search(input) {
      validateSearch(input, maxQueryLength, maxPageSize);
      const limit = input.page?.limit ?? Math.min(20, maxPageSize);
      const pageCursor = input.page?.cursor === undefined ? undefined : decodeCursor(input.page.cursor);
      const url = new URL(HUB_MODELS_PATH, HUB_ORIGIN);
      url.searchParams.set('search', input.query);
      url.searchParams.set('limit', String(limit));
      for (const field of SEARCH_EXPANSIONS) url.searchParams.append('expand[]', field);
      if (pageCursor?.cursor !== undefined) url.searchParams.set('cursor', pageCursor.cursor);
      if (pageCursor?.offset !== undefined) url.searchParams.set('offset', pageCursor.offset);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch {
        throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'HUGGINGFACE_UNAVAILABLE', true);
      }
      if (!response.ok) {
        const unavailable = response.status === 429 || response.status >= 500;
        throw new LocalAiError(unavailable ? 'DEPENDENCY_UNAVAILABLE' : 'NOT_SUPPORTED',
          unavailable ? 'HUGGINGFACE_UNAVAILABLE' : 'HUGGINGFACE_SEARCH_REJECTED', unavailable);
      }
      const payload = await limitedJson(response, MAX_SEARCH_RESPONSE_BYTES, 'HUGGINGFACE_RESPONSE_TOO_LARGE');
      if (!Array.isArray(payload)) throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'INVALID_HUGGINGFACE_RESPONSE', true);
      const items: ModelRecord[] = [];
      for (const raw of payload.slice(0, limit)) {
        const record = publicModelRecord(raw, profiles);
        if (record && matchesFilter(record, input.filter)) items.push(record);
      }
      const nextCursor = nextPageCursor(response.headers.get('link'), input.query, limit);
      return { items, nextCursor };
    },
  };
}

/** Проверяет профильные записи и добавляет отсутствующие записи; совпадающие записи не перезаписывает. */
export async function registerSupportedProfiles(
  store: LocalAiStore,
  profiles: readonly SupportedProfile[],
): Promise<void> {
  const values = indexProfiles(profiles);
  await store.transaction(async tx => {
    for (const profile of values.byModel.values()) {
      const existing = await tx.models.get(profile.modelId);
      if (existing === null) {
        await tx.models.put(profile.record);
      } else if (!samePreparedRecord(existing, profile.record)) {
        throw new LocalAiError('REVISION_CONFLICT', 'SUPPORTED_PROFILE_CATALOG_CONFLICT');
      }
    }
  });
}

/** Создаёт owner-scoped установщик с ограниченным параллелизмом и атомарной публикацией каталогов. */
export function createModelInstaller(options: ModelInstallerOptions): ModelInstaller {
  const indexed = indexProfiles(options.profiles);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const limits: InstallerLimits = {
    maxDownloadBytes: positive(options.limits?.maxDownloadBytes ?? 1_073_741_824, Number.MAX_SAFE_INTEGER, 'INVALID_INSTALL_LIMIT'),
    maxFiles: positive(options.limits?.maxFiles ?? 32, 256, 'INVALID_INSTALL_LIMIT'),
    maxParallel: positive(options.limits?.maxParallel ?? 1, 16, 'INVALID_INSTALL_LIMIT'),
    maxOperationMs: positive(options.limits?.maxOperationMs ?? 1_800_000, 2_147_483_647, 'INVALID_INSTALL_LIMIT'),
  };
  for (const profile of indexed.byModel.values()) {
    if (profile.files.length > limits.maxFiles || profile.files.reduce((sum, file) => sum + file.bytes, 0) > limits.maxDownloadBytes) {
      throw new LocalAiError('INVALID_ARGUMENT', 'SUPPORTED_PROFILE_EXCEEDS_INSTALL_LIMIT');
    }
  }
  const rootDirectory = path.resolve(options.rootDirectory);
  if (!path.isAbsolute(rootDirectory)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_INSTALL_ROOT');

  const admissions = new Map<string, Promise<InstallationOperation>>();
  const active = new Map<string, { controller: AbortController; targetKey: string; deadlineExceeded: () => boolean }>();
  const activeTasks = new Map<string, Promise<void>>();
  const activeTargets = new Set<string>();
  let closing = false;
  let closePromise: Promise<void> | null = null;

  async function getOperation(operationId: string, ownerId: string): Promise<InstallationOperation> {
    validateOperationSelector(operationId, ownerId);
    const operation = await options.store.transaction(tx => tx.installationOperations.get(operationId, ownerId));
    if (!operation) throw new LocalAiError('MODEL_NOT_FOUND', 'INSTALLATION_OPERATION_NOT_FOUND');
    return operation;
  }

  return {
    async start(request) {
      if (closing) throw new LocalAiError('BUSY', 'INSTALLER_CLOSING', true);
      validateInstallRequest(request);
      const profile = findProfile(indexed, request.modelId, request.profileId);
      if (request.revision !== profile.revision) throw new LocalAiError('REVISION_CONFLICT', 'MODEL_SELECTOR_MISMATCH');
      const key = operationKey(request.ownerId, request.requestId);
      const admitted = admissions.get(key);
      if (admitted) { const operation = await admitted; assertSameOperation(operation, request); return operation; }
      if (active.has(key)) { const operation = await getOperation(request.requestId, request.ownerId); assertSameOperation(operation, request); return operation; }
      const saved = await options.store.transaction(tx => tx.installationOperations.get(request.requestId, request.ownerId));
      if (saved) { assertSameOperation(saved, request); return saved; }
      const deadlineAt = Date.parse(request.deadlineAt);
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new LocalAiError('DEADLINE_EXCEEDED', 'INSTALL_DEADLINE_EXCEEDED');
      const targetKey = selectorKey(request.modelId, request.revision, request.profileId);
      if (activeTargets.has(targetKey) || activeTargets.size >= limits.maxParallel) {
        throw new LocalAiError('BUSY', 'INSTALLER_BUSY', true);
      }
      activeTargets.add(targetKey);
      let releaseModel: (() => void) | undefined;
      const pending = (async () => {
        releaseModel = await options.acquireModelIdleLock?.(profile.modelId);
        return admit(request, profile);
      })();
      admissions.set(key, pending);
      try {
        const operation = await pending;
        if (operation.status !== 'accepted') { activeTargets.delete(targetKey); releaseModel?.(); return operation; }
        const controller = new AbortController();
        let deadlineExceeded = false;
        const effectiveMs = Math.min(remaining, limits.maxOperationMs);
        const timer = setTimeout(() => {
          deadlineExceeded = true;
          controller.abort();
        }, effectiveMs);
        active.set(key, { controller, targetKey, deadlineExceeded: () => deadlineExceeded });
        if (closing) controller.abort();
        const task = run(operation, profile, controller, () => deadlineExceeded).catch(() => undefined).finally(() => {
          clearTimeout(timer);
          active.delete(key);
          activeTasks.delete(key);
          activeTargets.delete(targetKey);
          releaseModel?.();
        });
        activeTasks.set(key, task);
        return operation;
      } catch (error) {
        activeTargets.delete(targetKey);
        releaseModel?.();
        throw error;
      } finally {
        admissions.delete(key);
      }
    },

    async get(operationId, ownerId) {
      return getOperation(operationId, ownerId);
    },

    async cancel(operationId, ownerId) {
      const operation = await getOperation(operationId, ownerId);
      const running = active.get(operationKey(ownerId, operationId));
      if (running) running.controller.abort();
      return operation;
    },

    async importVerified(input) {
      if (closing) throw new LocalAiError('BUSY', 'INSTALLER_CLOSING', true);
      const profile = findProfile(indexed, input.modelId, input.profileId);
      const targetKey = selectorKey(profile.modelId, profile.revision, profile.profileId);
      if (activeTargets.has(targetKey) || activeTargets.size >= limits.maxParallel) throw new LocalAiError('BUSY', 'INSTALLER_BUSY', true);
      activeTargets.add(targetKey);
      let releaseModel: (() => void) | undefined;
      try {
        releaseModel = await options.acquireModelIdleLock?.(profile.modelId);
        if (input.revision !== profile.revision || !path.isAbsolute(input.directory)) {
          throw new LocalAiError('REVISION_CONFLICT', 'MODEL_SELECTOR_MISMATCH');
        }
        const source = path.resolve(input.directory);
        if (source !== installationDirectory(rootDirectory, profile)) throw new LocalAiError('INVALID_ARGUMENT', 'IMPORTED_DIRECTORY_NOT_CANONICAL');
        const sourceInfo = await lstat(source).catch(() => { throw new LocalAiError('MODEL_NOT_INSTALLED', 'IMPORTED_DIRECTORY_NOT_FOUND'); });
        if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new LocalAiError('INVALID_ARGUMENT', 'IMPORTED_DIRECTORY_INVALID');
        const realRoot = await mkdir(rootDirectory, { recursive: true }).then(() => realpath(rootDirectory));
        const realSource = await realpath(source).catch(() => { throw new LocalAiError('MODEL_NOT_INSTALLED', 'IMPORTED_DIRECTORY_NOT_FOUND'); });
        if (!isWithin(realRoot, realSource)) throw new LocalAiError('INVALID_ARGUMENT', 'IMPORTED_DIRECTORY_OUTSIDE_MODEL_ROOT');
        await verifyDirectory(realSource, profile.files);
        const install: InstallationRecord = {
          modelId: profile.modelId, revision: profile.revision, profileId: profile.profileId,
          directory: realSource, files: publicFiles(profile.files), installedAt: now(),
        };
        const verified = await options.store.transaction(async tx => {
          const record = await tx.installations.get(profile.modelId, profile.revision);
          if (record) {
            if (!sameInstallation(record, install)) throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_REVISION_CONFLICT');
            return record;
          }
          const model = await tx.models.get(profile.modelId);
          if (!model || !samePreparedRecord(model, profile.record)) throw new LocalAiError('MODEL_NOT_FOUND', 'SUPPORTED_PROFILE_NOT_REGISTERED');
          await tx.installations.put(install);
          return install;
        });
        await options.installed?.(profile.modelId);
        return verified;
      } finally {
        activeTargets.delete(targetKey);
        releaseModel?.();
      }
    },

    async cleanupPublished(record) {
      const profile = findProfile(indexed, record.modelId, record.profileId);
      const targetKey = selectorKey(record.modelId, record.revision, record.profileId);
      if (record.revision !== profile.revision || path.resolve(record.directory) !== installationDirectory(rootDirectory, profile)) {
        return;
      }
      if (activeTargets.has(targetKey) || activeTargets.size >= limits.maxParallel) throw new LocalAiError('BUSY', 'INSTALLER_BUSY', true);
      activeTargets.add(targetKey);
      try {
        const current = await options.store.transaction(tx => tx.installations.get(record.modelId, record.revision));
        if (current) throw new LocalAiError('MODEL_IN_USE', 'INSTALLATION_STILL_REFERENCED');
        const info = await lstat(record.directory).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error));
        if (!info) return;
        if (!info.isDirectory() || info.isSymbolicLink()) throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_DIRECTORY_CONFLICT');
        const realRoot = await realpath(rootDirectory);
        const realDirectory = await realpath(record.directory);
        if (realDirectory !== installationDirectory(realRoot, profile) || !isWithin(realRoot, realDirectory)) {
          throw new LocalAiError('INVALID_ARGUMENT', 'INSTALLATION_DIRECTORY_OUTSIDE_MODEL_ROOT');
        }
        await rm(realDirectory, { recursive: true, force: false });
        await syncDirectory(path.dirname(realDirectory));
      } finally {
        activeTargets.delete(targetKey);
      }
    },

    async cleanupAbandonedStaging() {
      if (activeTargets.size > 0) throw new LocalAiError('BUSY', 'INSTALLER_HAS_ACTIVE_OPERATIONS', true);
      let removed = 0;
      for (const profile of indexed.byModel.values()) {
        const parent = path.dirname(installationDirectory(rootDirectory, profile));
        const entries = await readdir(parent, { withFileTypes: true }).catch(error =>
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : Promise.reject(error));
        for (const entry of entries) {
          const match = /^\.staging-([\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12})$/i.exec(entry.name);
          if (!match) continue;
          const candidate = path.join(parent, entry.name);
          const info = await lstat(candidate);
          if (!info.isDirectory() || info.isSymbolicLink()) continue;
          await rm(candidate, { recursive: true, force: false });
          removed += 1;
        }
      }
      return removed;
    },

    close() {
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          await Promise.allSettled([...admissions.values()]);
          await new Promise<void>(resolve => setImmediate(resolve));
          for (const current of active.values()) current.controller.abort();
          await Promise.allSettled([...activeTasks.values()]);
        })();
      }
      return closePromise;
    },
  };

  async function admit(request: InstallRequest, profile: SupportedProfile): Promise<InstallationOperation> {
    const operationId = request.requestId;
    const current = await options.store.transaction(async tx => {
      const operation = await tx.installationOperations.get(operationId, request.ownerId);
      if (operation) {
        assertSameOperation(operation, request);
        return operation;
      }
      const model = await tx.models.get(profile.modelId);
      if (!model || !samePreparedRecord(model, profile.record)) {
        throw new LocalAiError('MODEL_NOT_FOUND', 'SUPPORTED_PROFILE_NOT_REGISTERED');
      }
      const existing = await tx.installations.get(profile.modelId, profile.revision);
      if (existing && (existing.profileId !== profile.profileId || !sameFiles(existing.files, publicFiles(profile.files)))) {
        throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_REVISION_CONFLICT');
      }
      const created = operationRecord(request, 'accepted', 'queued', null, null, now(), now());
      await tx.installationOperations.put(created);
      return created;
    });
    return current;
  }

  async function run(
    accepted: InstallationOperation,
    profile: SupportedProfile,
    controller: AbortController,
    deadlineExceeded: () => boolean,
  ): Promise<void> {
    let operation: InstallationOperation = { ...accepted, status: 'running', phase: 'downloading', progressPercent: 0, updatedAt: now() };
    try {
      await saveOperation(operation);
      const finalDirectory = installationDirectory(rootDirectory, profile);
      const current = await options.store.transaction(tx => tx.installations.get(profile.modelId, profile.revision));
      if (current) {
        if (current.profileId !== profile.profileId || !sameFiles(current.files, publicFiles(profile.files))) {
          throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_REVISION_CONFLICT');
        }
        operation = { ...operation, phase: 'verifying', progressPercent: 100, updatedAt: now() };
        await saveOperation(operation);
        await verifyDirectory(current.directory, profile.files);
        operation = { ...operation, phase: 'publishing', updatedAt: now() };
        await saveOperation(operation);
        await finishSuccess(operation, profile, current.directory);
        return;
      }

      const parentDirectory = path.dirname(finalDirectory);
      await mkdir(parentDirectory, { recursive: true });
      const stagingDirectory = path.join(parentDirectory, '.staging-' + accepted.operationId);
      await rm(stagingDirectory, { recursive: true, force: true });
      await mkdir(stagingDirectory, { recursive: false });
      const totalBytes = profile.files.reduce((sum, file) => sum + file.bytes, 0);
      let downloadedBytes = 0;
      operation = { ...operation, phase: 'downloading', progressPercent: 0, updatedAt: now() };
      await saveOperation(operation);

      for (const file of profile.files) {
        checkAborted(controller.signal, deadlineExceeded());
        const target = path.join(stagingDirectory, ...file.path.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await downloadFile({
          fetchImpl, file, profile, target, signal: controller.signal,
          onBytes: async count => {
            downloadedBytes += count;
            const percent = Math.min(99, Math.floor(downloadedBytes * 100 / totalBytes));
            if (percent > (operation.progressPercent ?? 0)) {
              operation = { ...operation, phase: 'downloading', progressPercent: percent, updatedAt: now() };
              await saveOperation(operation);
            }
          },
        });
      }

      checkAborted(controller.signal, deadlineExceeded());
      operation = { ...operation, phase: 'verifying', progressPercent: 100, updatedAt: now() };
      await saveOperation(operation);
      await verifyDirectory(stagingDirectory, profile.files);
      checkAborted(controller.signal, deadlineExceeded());
      operation = { ...operation, phase: 'publishing', progressPercent: 100, updatedAt: now() };
      await saveOperation(operation);

      const existingPath = await lstat(finalDirectory).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error));
      if (existingPath) {
        if (!existingPath.isDirectory() || existingPath.isSymbolicLink()) throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_DIRECTORY_CONFLICT');
        await verifyDirectory(finalDirectory, profile.files);
        await rm(stagingDirectory, { recursive: true, force: true });
      } else {
        await rename(stagingDirectory, finalDirectory);
        await syncDirectory(parentDirectory);
      }
      await finishSuccess(operation, profile, finalDirectory);
    } catch (error) {
      const cancelled = controller.signal.aborted && !deadlineExceeded();
      const timedOut = deadlineExceeded();
      const safe = timedOut ? new LocalAiError('DEADLINE_EXCEEDED', 'INSTALL_DEADLINE_EXCEEDED')
        : cancelled ? new LocalAiError('CANCELLED', 'INSTALL_CANCELLED')
        : safeInstallError(error);
      operation = {
        ...operation, status: cancelled ? 'cancelled' : 'failed',
        phase: cancelled ? 'cancelled' : 'failed', progressPercent: null, errorCode: safe.code, updatedAt: now(),
      };
      const stagingDirectory = path.join(path.dirname(installationDirectory(rootDirectory, profile)), '.staging-' + accepted.operationId);
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      await terminal(operation, profile, cancelled ? 'cancelled' : 'failed');
    }
  }

  async function finishSuccess(operation: InstallationOperation, profile: SupportedProfile, directory: string): Promise<void> {
    const install: InstallationRecord = {
      modelId: profile.modelId, revision: profile.revision, profileId: profile.profileId,
      directory, files: publicFiles(profile.files), installedAt: now(),
    };
    const completed: InstallationOperation = {
      ...operation, status: 'completed', phase: 'completed', progressPercent: 100, errorCode: null, updatedAt: now(),
    };
    await options.store.transaction(async tx => {
      const model = await tx.models.get(profile.modelId);
      if (!model || !samePreparedRecord(model, profile.record)) throw new LocalAiError('MODEL_NOT_FOUND', 'SUPPORTED_PROFILE_NOT_REGISTERED');
      await tx.installations.put(install);
      await tx.installationOperations.put(completed);
    });
    await options.installed?.(profile.modelId);
    const fact = installEvent(install, operation.operationId, operation.ownerId, 'succeeded', now());
    fact.data.durationMs = Math.max(0, Date.parse(completed.updatedAt) - Date.parse(operation.createdAt));
    publish(fact);
  }

  function publish(fact: LocalAiHistoryMetadataEvent): void {
    try { options.history?.publish(fact); } catch { /* История не меняет зафиксированный исход. */ }
  }
  async function terminal(operation: InstallationOperation, profile: SupportedProfile, outcome: 'failed' | 'cancelled'): Promise<void> {
    await options.store.transaction(tx => tx.installationOperations.put(operation));
    const fact = installEvent(
      { modelId: profile.modelId, revision: profile.revision, profileId: profile.profileId, directory: installationDirectory(rootDirectory, profile), files: publicFiles(profile.files), installedAt: operation.createdAt },
      operation.operationId, operation.ownerId, outcome, now(), operation.errorCode ?? undefined,
    );
    fact.data.durationMs = Math.max(0, Date.parse(operation.updatedAt) - Date.parse(operation.createdAt));
    publish(fact);
  }

  async function saveOperation(operation: InstallationOperation): Promise<void> {
    await options.store.transaction(tx => tx.installationOperations.put(operation));
  }
}

/** Потоково скачивает ровно один разрешённый файл, ограничивая размер до записи на диск. */
async function downloadFile(input: {
  fetchImpl: typeof fetch;
  file: ProfileFileManifest;
  profile: SupportedProfile;
  target: string;
  signal: AbortSignal;
  onBytes(count: number): Promise<void>;
}): Promise<number> {
  const url = input.file.url ? new URL(input.file.url) : new URL(
    '/' + input.profile.repository.split('/').map(encodeURIComponent).join('/')
      + '/resolve/' + encodeURIComponent(input.profile.revision)
      + '/' + input.file.path.split('/').map(encodeURIComponent).join('/') + '?download=true',
    HUB_ORIGIN,
  );
  let response: Response;
  try {
    response = await input.fetchImpl(url, { method: 'GET', headers: { accept: 'application/octet-stream' }, signal: input.signal, redirect: input.file.url ? 'error' : 'follow' });
  } catch {
    if (input.signal.aborted) throw new LocalAiError('CANCELLED', 'INSTALL_CANCELLED');
    throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'HUGGINGFACE_DOWNLOAD_FAILED', true);
  }
  if (response.status === 401 || response.status === 403) throw new LocalAiError('NOT_SUPPORTED', 'MODEL_ACCESS_RESTRICTED');
  if (response.status === 404) throw new LocalAiError('NOT_SUPPORTED', 'MODEL_REVISION_UNAVAILABLE');
  if (!response.ok) throw new LocalAiError(response.status >= 500 || response.status === 429 ? 'DEPENDENCY_UNAVAILABLE' : 'INSTALLATION_FAILED', 'HUGGINGFACE_DOWNLOAD_FAILED', response.status >= 500 || response.status === 429);
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== input.file.bytes)) {
    throw new LocalAiError('INSTALLATION_FAILED', 'MODEL_FILE_SIZE_MISMATCH');
  }
  if (!response.body) throw new LocalAiError('INSTALLATION_FAILED', 'MODEL_FILE_BODY_MISSING');

  const handle = await open(input.target, 'wx', 0o600);
  const hash = createHash('sha256');
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > input.file.bytes) throw new LocalAiError('INSTALLATION_FAILED', 'MODEL_FILE_SIZE_MISMATCH');
      hash.update(chunk.value);
      await handle.writeFile(chunk.value);
      await input.onBytes(chunk.value.byteLength);
    }
    if (bytes !== input.file.bytes || hash.digest('hex') !== input.file.sha256.toLowerCase()) {
      throw new LocalAiError('INSTALLATION_FAILED', 'MODEL_FILE_VERIFICATION_FAILED');
    }
    await handle.sync();
    return bytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await rm(input.target, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

async function verifyDirectory(directory: string, files: readonly ProfileFileManifest[]): Promise<void> {
  const root = await realpath(directory).catch(() => { throw new LocalAiError('MODEL_NOT_INSTALLED', 'INSTALLATION_DIRECTORY_NOT_FOUND'); });
  const expected = new Map(files.map(file => [file.path, file]));
  const seen = new Set<string>();
  async function visit(current: string, relative: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      const name = relative ? relative + '/' + entry.name : entry.name;
      const info = await lstat(filePath);
      if (info.isSymbolicLink()) throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_CONTAINS_LINK');
      if (info.isDirectory()) {
        await visit(filePath, name);
      } else if (info.isFile()) {
        const manifest = expected.get(name);
        if (!manifest || seen.has(name)) throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_HAS_UNEXPECTED_FILE');
        if (info.size !== manifest.bytes || await hashFile(filePath) !== manifest.sha256.toLowerCase()) {
          throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_FILE_MISMATCH');
        }
        seen.add(name);
      } else {
        throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_HAS_UNEXPECTED_FILE');
      }
    }
  }
  await visit(root, '');
  if (seen.size !== expected.size) throw new LocalAiError('MODEL_NOT_INSTALLED', 'INSTALLATION_FILE_MISSING');
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function limitedJson(response: Response, maximumBytes: number, error: string): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    throw new LocalAiError('DEPENDENCY_UNAVAILABLE', error, true);
  }
  if (!response.body) throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'INVALID_HUGGINGFACE_RESPONSE', true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new LocalAiError('DEPENDENCY_UNAVAILABLE', error, true);
    }
    chunks.push(chunk.value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), length).toString('utf8')) as unknown;
  } catch {
    throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'INVALID_HUGGINGFACE_RESPONSE', true);
  }
}

function indexProfiles(profiles: readonly SupportedProfile[]): { byModel: Map<string, SupportedProfile>; byRepository: Map<string, SupportedProfile> } {
  if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > 32) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_SUPPORTED_PROFILES');
  const byModel = new Map<string, SupportedProfile>();
  const byRepository = new Map<string, SupportedProfile>();
  for (const raw of profiles) {
    validateProfile(raw);
    if (byModel.has(raw.modelId) || byRepository.has(raw.repository)) throw new LocalAiError('INVALID_ARGUMENT', 'DUPLICATE_SUPPORTED_PROFILE');
    byModel.set(raw.modelId, raw);
    byRepository.set(raw.repository, raw);
  }
  return { byModel, byRepository };
}

function validateProfile(profile: SupportedProfile): void {
  if (!profile || typeof profile !== 'object' || !safeSegment(profile.modelId) || !safeSegment(profile.profileId)
    || !safeRepository(profile.repository) || !REVISION.test(profile.revision)
    || !Array.isArray(profile.files) || profile.files.length < 1 || profile.files.length > 256
    || !profile.record || profile.record.modelId !== profile.modelId || profile.record.profileId !== profile.profileId
    || profile.record.revision !== profile.revision || profile.record.source !== profile.repository || !profile.record.supported) {
    throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_SUPPORTED_PROFILE');
  }
  let total = 0;
  const paths = new Set<string>();
  for (const file of profile.files) {
    if (!file || !validRelativeFile(file.path) || paths.has(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || !/^[\da-f]{64}$/i.test(file.sha256)) {
      throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_SUPPORTED_PROFILE_FILES');
    }
    if (profile.profileId === 'silero_pytorch' && file.url === undefined) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_SUPPORTED_PROFILE_FILES');
    if (file.url !== undefined && (profile.profileId !== 'silero_pytorch' || profile.modelId !== 'silero-tts-ru-v5_5'
      || profile.repository !== 'silero-models/tts' || profile.revision !== '50081637b602126ee06cb3bc8a744d25651d2da1'
      || file.path !== 'v5_5_ru.pt' || file.bytes !== 145420684
      || file.sha256 !== '50081637b602126ee06cb3bc8a744d25651d2da149ee8864b9a379bfdd934437'
      || file.url !== 'https://models.silero.ai/models/tts/ru/v5_5_ru.pt')) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_SUPPORTED_PROFILE_FILES');
    paths.add(file.path);
    total += file.bytes;
    if (!Number.isSafeInteger(total)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_SUPPORTED_PROFILE_FILES');
  }
  if (profile.record.files.length !== profile.files.length || !sameFiles(profile.record.files, publicFiles(profile.files))) {
    throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_SUPPORTED_PROFILE_FILES');
  }
}

function publicModelRecord(value: unknown, profiles: { byRepository: Map<string, SupportedProfile> }): ModelRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const model = value as Record<string, unknown>;
  const repository = model.id;
  const revision = model.sha;
  if (typeof repository !== 'string' || !safeRepository(repository)
    || typeof revision !== 'string' || !REVISION.test(revision) || Boolean(model.private)) return null;
  const profile = profiles.byRepository.get(repository);
  if (profile && !model.gated) return profile.record;
  const tags = Array.isArray(model.tags) ? model.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  const license = tags.find(tag => tag.startsWith('license:'))?.slice('license:'.length) ?? null;
  const languages = tags.filter(tag => tag.startsWith('language:')).map(tag => tag.slice('language:'.length)).filter(Boolean).slice(0, 32);
  return {
    modelId: repository,
    name: repository,
    description: '',
    source: repository,
    license: license && license.length <= 128 ? license : null,
    revision,
    profileId: null,
    supported: false,
    operations: [],
    languages,
    inputKinds: [],
    outputKinds: [],
    files: [],
    hardwareRequirements: { cpuArchitectures: [], minMemoryBytes: null, accelerator: null },
    limits: { maxInputBytes: null, maxAudioSeconds: null, maxItems: null, maxResultBytes: null, vectorDimensions: null },
    parameters: { embed: null, transcribe: null },
  };
}

function matchesFilter(record: ModelRecord, filter: PublicSearchInput['filter']): boolean {
  if (!filter) return true;
  if (!record.supported) return false;
  return (filter.operation === undefined || record.operations.includes(filter.operation))
    && (filter.inputKind === undefined || record.inputKinds.includes(filter.inputKind))
    && (filter.outputKind === undefined || record.outputKinds.includes(filter.outputKind))
    && (filter.language === undefined || record.languages.includes(filter.language));
}

function validateSearch(input: PublicSearchInput, maxQueryLength: number, maxPageSize: number): void {
  if (!input || typeof input !== 'object' || typeof input.query !== 'string' || input.query.length > maxQueryLength
    || input.query.includes('\0')) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_CATALOG_SEARCH');
  if (input.filter !== undefined) {
    const filter = input.filter;
    const allowed = new Set(['operation', 'inputKind', 'outputKind', 'language']);
    if (!filter || typeof filter !== 'object' || Object.keys(filter).some(key => !allowed.has(key))
      || filter.operation !== undefined && !['embed', 'transcribe', 'synthesize'].includes(filter.operation)
      || filter.inputKind !== undefined && !['text', 'image_artifact', 'audio_artifact', 'video_artifact'].includes(filter.inputKind)
      || filter.outputKind !== undefined && !['vector', 'transcription', 'audio_artifact'].includes(filter.outputKind)
      || filter.language !== undefined && (typeof filter.language !== 'string' || filter.language.length < 1 || filter.language.length > 128)) {
      throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_CATALOG_SEARCH_FILTER');
    }
  }
  if (input.page !== undefined) {
    if (!input.page || typeof input.page !== 'object' || Object.keys(input.page).some(key => !['cursor', 'limit'].includes(key))
      || input.page.cursor !== undefined && (typeof input.page.cursor !== 'string' || input.page.cursor.length > MAX_CURSOR_BYTES)
      || input.page.limit !== undefined && (!Number.isSafeInteger(input.page.limit) || input.page.limit < 1 || input.page.limit > maxPageSize)) {
      throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_CATALOG_SEARCH_PAGE');
    }
  }
}

function nextPageCursor(link: string | null, query: string, limit: number): string | null {
  if (!link) return null;
  for (const entry of link.split(/,(?=\s*<)/)) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/i.exec(entry);
    if (!match) continue;
    let next: URL;
    try { next = new URL(match[1]); } catch { throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'INVALID_HUGGINGFACE_PAGINATION', true); }
    if (next.origin !== HUB_ORIGIN || next.pathname !== HUB_MODELS_PATH) {
      throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'INVALID_HUGGINGFACE_PAGINATION', true);
    }
    for (const key of next.searchParams.keys()) {
      if (!['search', 'limit', 'cursor', 'offset', 'expand', 'expand[]'].includes(key)) throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'INVALID_HUGGINGFACE_PAGINATION', true);
    }
    const expansions = next.searchParams.getAll('expand');
    const bracketExpansions = next.searchParams.getAll('expand[]');
    const actualExpansions = expansions.length > 0 && bracketExpansions.length === 0 ? expansions : bracketExpansions;
    if ((expansions.length > 0 && bracketExpansions.length > 0)
      || actualExpansions.length !== SEARCH_EXPANSIONS.length
      || actualExpansions.some((value, index) => value !== SEARCH_EXPANSIONS[index])) {
      throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'INVALID_HUGGINGFACE_PAGINATION', true);
    }
    if (next.searchParams.get('search') !== query || next.searchParams.get('limit') !== String(limit)) {
      throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'INVALID_HUGGINGFACE_PAGINATION', true);
    }
    const cursor = next.searchParams.get('cursor');
    const offset = next.searchParams.get('offset');
    if ((cursor === null) === (offset === null) || cursor !== null && cursor.length > 512 || offset !== null && !/^\d{1,12}$/.test(offset)) {
      throw new LocalAiError('DEPENDENCY_UNAVAILABLE', 'INVALID_HUGGINGFACE_PAGINATION', true);
    }
    return encodeCursor(cursor === null ? { offset: offset! } : { cursor });
  }
  return null;
}

function encodeCursor(value: { cursor?: string; offset?: string }): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value: string): { cursor?: string; offset?: string } {
  if (!value || value.length > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_CATALOG_SEARCH_CURSOR');
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('cursor');
    const cursor = decoded as Record<string, unknown>;
    const keys = Object.keys(cursor);
    if (keys.length !== 1 || keys.some(key => !['cursor', 'offset'].includes(key))) throw new Error('cursor');
    if (typeof cursor.cursor === 'string' && cursor.cursor.length > 0 && cursor.cursor.length <= 512) return { cursor: cursor.cursor };
    if (typeof cursor.offset === 'string' && /^\d{1,12}$/.test(cursor.offset)) return { offset: cursor.offset };
    throw new Error('cursor');
  } catch {
    throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_CATALOG_SEARCH_CURSOR');
  }
}

function findProfile(
  indexed: { byModel: Map<string, SupportedProfile> },
  modelId: string,
  profileId: string,
): SupportedProfile {
  if (!safeSegment(modelId) || !safeSegment(profileId)) throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_MODEL_SELECTOR');
  const profile = indexed.byModel.get(modelId);
  if (!profile || profile.profileId !== profileId) throw new LocalAiError('NOT_SUPPORTED', 'MODEL_PROFILE_UNAVAILABLE');
  return profile;
}

function samePreparedRecord(left: ModelRecord, right: ModelRecord): boolean {
  return left.modelId === right.modelId && left.source === right.source && left.revision === right.revision
    && left.profileId === right.profileId && left.supported === right.supported && sameFiles(left.files, right.files);
}

function sameInstallation(left: InstallationRecord, right: InstallationRecord): boolean {
  return left.modelId === right.modelId && left.revision === right.revision && left.profileId === right.profileId
    && path.resolve(left.directory) === path.resolve(right.directory) && sameFiles(left.files, right.files);
}

function sameFiles(left: readonly ModelFile[], right: readonly ModelFile[]): boolean {
  return left.length === right.length && left.every((file, index) =>
    file.path === right[index]?.path && file.sizeBytes === right[index]?.sizeBytes && file.sha256.toLowerCase() === right[index]?.sha256.toLowerCase());
}

function publicFiles(files: readonly ProfileFileManifest[]): ModelFile[] {
  return files.map(file => ({ path: file.path, sizeBytes: file.bytes, sha256: file.sha256.toLowerCase() }));
}

function operationRecord(
  request: InstallRequest,
  status: InstallationOperation['status'],
  phase: InstallationOperation['phase'],
  progressPercent: number | null,
  errorCode: InstallationOperation['errorCode'],
  createdAt: string,
  updatedAt: string,
): InstallationOperation {
  return {
    operationId: request.requestId, ownerId: request.ownerId, modelId: request.modelId,
    revision: request.revision, profileId: request.profileId, status, phase, progressPercent,
    errorCode, createdAt, updatedAt,
  };
}


function installEvent(
  install: InstallationRecord,
  operationId: string,
  actorId: string | null,
  outcome: LocalAiHistoryMetadataEvent['data']['outcome'],
  occurredAt: string,
  errorCode?: LocalAiHistoryMetadataEvent['data']['errorCode'],
): LocalAiHistoryMetadataEvent {
  return {
    id: randomUUID(), type_id: 902, occurred_at: occurredAt, actor_id: actorId,
    scope_type: 'system', scope_id: 'local_ai', object_type: 'installation',
    object_id: install.modelId,
    data: {
      operation: 'install', modelId: install.modelId, revision: install.revision,
      profileId: install.profileId, operationId, outcome,
      ...(errorCode ? { errorCode } : {}),
    },
  };
}

function validateInstallRequest(request: InstallRequest): void {
  if (!request || typeof request !== 'object' || !UUID.test(request.requestId)
    || typeof request.ownerId !== 'string' || request.ownerId.length < 1 || request.ownerId.length > 255
    || request.ownerId.includes('\0') || !safeSegment(request.modelId) || !safeSegment(request.profileId)
    || !REVISION.test(request.revision) || !Number.isFinite(Date.parse(request.deadlineAt))) {
    throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_INSTALL_REQUEST');
  }
}

function validateOperationSelector(operationId: string, ownerId: string): void {
  if (typeof operationId !== 'string' || !UUID.test(operationId)
    || typeof ownerId !== 'string' || ownerId.length < 1 || ownerId.length > 255 || ownerId.includes('\0')) {
    throw new LocalAiError('INVALID_ARGUMENT', 'INVALID_INSTALLATION_OPERATION_SELECTOR');
  }
}

function assertSameOperation(operation: InstallationOperation, request: InstallRequest): void {
  if (operation.modelId !== request.modelId || operation.revision !== request.revision || operation.profileId !== request.profileId) {
    throw new LocalAiError('REVISION_CONFLICT', 'INSTALLATION_OPERATION_ID_CONFLICT');
  }
}

function safeSegment(value: unknown): value is string {
  return typeof value === 'string' && SAFE_SEGMENT.test(value) && value !== '.' && value !== '..' && !value.includes('\0');
}

function safeRepository(value: string): boolean {
  const parts = typeof value === 'string' ? value.split('/') : [];
  return parts.length === 2 && parts.every(part => safeSegment(part));
}

function validRelativeFile(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.startsWith('/')
    && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

function installationDirectory(root: string, profile: SupportedProfile): string {
  return path.join(root, profile.modelId, profile.revision, profile.profileId);
}

function selectorKey(modelId: string, revision: string, profileId: string): string {
  return modelId + '\0' + revision + '\0' + profileId;
}

function operationKey(ownerId: string, operationId: string): string {
  return ownerId + '\0' + operationId;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function checkAborted(signal: AbortSignal, deadlineExceeded: boolean): void {
  if (deadlineExceeded) throw new LocalAiError('DEADLINE_EXCEEDED', 'INSTALL_DEADLINE_EXCEEDED');
  if (signal.aborted) throw new LocalAiError('CANCELLED', 'INSTALL_CANCELLED');
}

function safeInstallError(error: unknown): LocalAiError {
  if (error instanceof LocalAiError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOSPC' || code === 'EIO' || code === 'EROFS' || code === 'EACCES') {
    return new LocalAiError('INSTALLATION_FAILED', 'MODEL_STORAGE_FAILED');
  }
  return new LocalAiError('DEPENDENCY_UNAVAILABLE', 'HUGGINGFACE_DOWNLOAD_FAILED', true);
}

function positive(value: number, maximum: number, message: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new LocalAiError('INVALID_ARGUMENT', message);
  return value;
}
