// ABOUTME: Хранит очереди Агента в IndexedDB с CAS и лимитом на аккаунт.
// ABOUTME: Бинарные данные остаются structured clone, а preview URL создаются заново.
import type { Attachment } from "./images";
import {
  QUEUE_LIMIT,
  queueScopeKey,
  releaseQueueEntries,
  type QueueEntry,
  type QueueScope,
  type QueueSnapshot,
  type QueueStore,
} from "./queue.ts";

const DATABASE_NAME = "brai-agent-queue";
const DATABASE_VERSION = 1;
const STORE_NAME = "snapshots";
const USER_INDEX = "userId";

type StoredAttachment = Omit<Attachment, "previewUrl" | "previewObjectUrl">;
type StoredQueueEntry = Omit<QueueEntry, "draft"> & { draft: Omit<QueueEntry["draft"], "images"> & { images: StoredAttachment[] } };
type StoredSnapshot = { key: string; userId: string; scope: QueueScope; revision: number; entries: StoredQueueEntry[] };

/** Удаляет из записи временные preview URL, сохраняя Blob и стабильные request IDs. */
export function serializeQueueEntry(entry: QueueEntry): StoredQueueEntry {
  return {
    ...entry,
    scope: { ...entry.scope },
    settings: { ...entry.settings },
    ...(entry.attempt ? { attempt: { ...entry.attempt } } : {}),
    draft: {
      ...entry.draft,
      images: entry.draft.images.map(image => {
        const stored: StoredAttachment & { previewUrl?: string; previewObjectUrl?: boolean } = { ...image };
        delete stored.previewUrl;
        delete stored.previewObjectUrl;
        return stored;
      }),
    },
  };
}

/** Создаёт независимую запись с новым локальным preview URL для каждого изображения. */
export function hydrateQueueEntry(entry: StoredQueueEntry): QueueEntry {
  const createdUrls: string[] = [];
  try {
    return {
      ...entry,
      scope: { ...entry.scope },
      settings: { ...entry.settings },
      ...(entry.attempt ? { attempt: { ...entry.attempt } } : {}),
      draft: {
        ...entry.draft,
        images: entry.draft.images.map(image => {
          const previewUrl = URL.createObjectURL(image.model);
          createdUrls.push(previewUrl);
          return { ...image, previewUrl, previewObjectUrl: true };
        }),
      },
    };
  } catch (error) {
    for (const previewUrl of createdUrls) URL.revokeObjectURL(previewUrl);
    throw error;
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Не удалось выполнить запрос IndexedDB."));
  });
}

function transactionResult(transaction: IDBTransaction): Promise<void> {
  const result = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Транзакция IndexedDB отменена."));
    transaction.onerror = () => reject(transaction.error ?? new Error("Ошибка транзакции IndexedDB."));
  });
  void result.catch(() => undefined);
  return result;
}

function hydrateSnapshot(scope: QueueScope, revision: number, entries: StoredQueueEntry[]): QueueSnapshot {
  const hydrated: QueueEntry[] = [];
  try {
    for (const entry of entries) hydrated.push(hydrateQueueEntry(entry));
    return { scope: { ...scope }, revision, entries: hydrated };
  } catch (error) {
    releaseQueueEntries(hydrated);
    throw error;
  }
}

/** Создаёт IndexedDB-адаптер; при отсутствии API load/save отклоняются понятной ошибкой. */
export function createQueueStore(factory?: IDBFactory): QueueStore {
  let databasePromise: Promise<IDBDatabase> | undefined;
  let closed = false;

  const database = (): Promise<IDBDatabase> => {
    if (closed) return Promise.reject(new Error("Хранилище очереди закрыто."));
    if (!databasePromise) {
      const idbFactory = factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
      if (!idbFactory) return Promise.reject(new Error("IndexedDB недоступен в этой среде."));
      databasePromise = new Promise((resolve, reject) => {
        const request = idbFactory.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
            store.createIndex(USER_INDEX, "userId", { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("Не удалось открыть IndexedDB очереди."));
        request.onblocked = () => reject(new Error("Открытие IndexedDB очереди заблокировано другой вкладкой."));
      });
    }
    return databasePromise;
  };

  return {
    /** Загружает только точный scope; отсутствующая очередь имеет ревизию 0. */
    async load(scope) {
      const db = await database();
      const transaction = db.transaction(STORE_NAME, "readonly");
      const done = transactionResult(transaction);
      let record: StoredSnapshot | undefined;
      try { record = await requestResult<StoredSnapshot | undefined>(transaction.objectStore(STORE_NAME).get(queueScopeKey(scope))); }
      catch (error) { await done.catch(() => undefined); throw error; }
      await done;
      return hydrateSnapshot(scope, record?.revision ?? 0, record?.entries ?? []);
    },

    /** Сохраняет очередь одной атомарной транзакцией с проверкой ревизии и userId-лимита. */
    async save(scope, expectedRevision, entries) {
      if (entries.some(entry => queueScopeKey(entry.scope) !== queueScopeKey(scope))) {
        throw new Error("Запись очереди относится к другому scope.");
      }
      if (new Set(entries.map(entry => entry.id)).size !== entries.length) {
        throw new Error("Записи очереди должны иметь уникальные id в пределах scope.");
      }

      const db = await database();
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const done = transactionResult(transaction);
      const store = transaction.objectStore(STORE_NAME);
      const key = queueScopeKey(scope);
      return await new Promise<QueueSnapshot>((resolve, reject) => {
        let current: StoredSnapshot | undefined, userRecords: StoredSnapshot[] = [];
        let currentReady = false, usersReady = false, decided = false;
        const fail = (error: Error) => {
          if (decided) return;
          decided = true;
          reject(error);
          try { transaction.abort(); } catch { /* транзакция уже завершилась */ }
          void done.catch(() => undefined);
        };
        const commitIfReady = () => {
          if (!currentReady || !usersReady || decided) return;
          const revision = current?.revision ?? 0;
          if (revision !== expectedRevision) {
            fail(new Error(`Конфликт версии очереди: ожидалась ${expectedRevision}, получена ${revision}.`));
            return;
          }

          const totalForUser = userRecords.reduce((total, record) => total + record.entries.length, 0);
          const currentForScope = current?.entries.length ?? 0;
          if (totalForUser - currentForScope + entries.length > QUEUE_LIMIT) {
            fail(new Error(`Очередь пользователя ограничена ${QUEUE_LIMIT} записями.`));
            return;
          }

          let storedEntries: StoredQueueEntry[];
          try { storedEntries = entries.map(serializeQueueEntry); }
          catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
          const nextRevision = revision + 1;
          decided = true;
          try {
            store.put({ key, userId: scope.userId, scope: { ...scope }, revision: nextRevision, entries: storedEntries } satisfies StoredSnapshot);
          } catch (error) {
            reject(error);
            try { transaction.abort(); } catch { /* транзакция уже завершилась */ }
            return;
          }
          void done.then(() => {
            try { resolve(hydrateSnapshot(scope, nextRevision, storedEntries)); }
            catch (error) { reject(error); }
          }, reject);
        };

        const currentRequest = store.get(key) as IDBRequest<StoredSnapshot | undefined>;
        currentRequest.onsuccess = () => {
          try { current = currentRequest.result; currentReady = true; commitIfReady(); }
          catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        };
        currentRequest.onerror = () => fail(currentRequest.error ?? new Error("Не удалось прочитать очередь."));
        const usersRequest = store.index(USER_INDEX).getAll(scope.userId) as IDBRequest<StoredSnapshot[]>;
        usersRequest.onsuccess = () => {
          try { userRecords = usersRequest.result; usersReady = true; commitIfReady(); }
          catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
        };
        usersRequest.onerror = () => fail(usersRequest.error ?? new Error("Не удалось проверить лимит пользователя."));
        void done.catch(error => { if (!decided) reject(error); });
      });
    },

    /** Закрывает только соединение IndexedDB, оставляя preview URL снимков владельцу. */
    close() {
      if (closed) return;
      closed = true;
      void databasePromise?.then(db => db.close(), () => undefined);
    },
  };
}
