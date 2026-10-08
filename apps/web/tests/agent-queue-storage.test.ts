// ABOUTME: Проверяет сериализацию и атомарные правила IndexedDB очереди Агента.
// ABOUTME: Локальный IndexedDB port моделирует user index, ревизии и отказ транзакции.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueueStore, hydrateQueueEntry, serializeQueueEntry } from "../lib/agent/queue-storage.ts";
import { queueScopeKey, releaseQueueEntries, type QueueEntry, type QueueScope } from "../lib/agent/queue.ts";
import type { Attachment } from "../lib/agent/images.ts";

type StoredRecord = { key: string; userId: string; scope: QueueScope; revision: number; entries: ReturnType<typeof serializeQueueEntry>[] };
type FixtureRequest<T = unknown> = { result?: T; error?: unknown; onsuccess?: (event: Event) => void; onerror?: (event: Event) => void };

function cloneFixtureValue<T>(value: T): T {
  return cloneValue(value) as T;
}
function cloneValue(value: unknown): unknown {
  if (value instanceof File) return new File([value], value.name, { type: value.type, lastModified: value.lastModified });
  if (value instanceof Blob) return new Blob([value], { type: value.type });
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  return value;
}

class FixtureTransaction {
  error: DOMException | null = null;
  oncomplete: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private pending = 0;
  private active = true;
  private aborted = false;
  private staged = new Map<string, StoredRecord>();
  private readonly store: FixtureObjectStore;
  private readonly factory: FixtureFactory;

  constructor(factory: FixtureFactory, mode: IDBTransactionMode) {
    this.factory = factory;
    this.store = new FixtureObjectStore(this, factory.records);
    this.readonly = mode === "readonly";
  }

  readonly readonly: boolean;
  objectStore(): FixtureObjectStore { return this.store; }
  schedule<T>(request: FixtureRequest<T>, action: () => T, write = false): void {
    if (!this.active) throw new DOMException("Transaction inactive", "TransactionInactiveError");
    this.pending++;
    queueMicrotask(() => {
      if (this.aborted) return;
      if (write && this.factory.failNextPut) {
        this.factory.failNextPut = false;
        this.error = new DOMException("Storage full", "QuotaExceededError");
        this.abort();
        request.error = this.error;
        request.onerror?.(new Event("error"));
        return;
      }
      try {
        request.result = action();
        request.onsuccess?.(new Event("success"));
      } catch (error) {
        request.error = error;
        this.abort();
        request.onerror?.(new Event("error"));
        return;
      }
      this.pending--;
      queueMicrotask(() => this.finishIfReady());
    });
  }

  commit(record: StoredRecord): void { this.staged.set(record.key, record); }
  abort(): void {
    if (this.aborted) return;
    this.aborted = true; this.active = false; this.staged.clear();
    queueMicrotask(() => this.onabort?.(new Event("abort")));
  }

  private finishIfReady(): void {
    if (!this.active || this.pending !== 0) return;
    for (const [key, record] of this.staged) this.factory.records.set(key, record);
    this.active = false;
    queueMicrotask(() => this.oncomplete?.(new Event("complete")));
  }
}

class FixtureObjectStore {
  private readonly tx: FixtureTransaction;
  private readonly records: Map<string, StoredRecord>;
  constructor(tx: FixtureTransaction, records: Map<string, StoredRecord>) { this.tx = tx; this.records = records; }
  index(name: string) {
    assert.equal(name, "userId");
    return { getAll: (userId: string) => this.request(() => [...this.records.values()].filter(record => record.userId === userId).map(cloneFixtureValue)) };
  }
  get(key: string) { return this.request(() => cloneFixtureValue(this.records.get(key))); }
  getAll() { return this.request(() => [...this.records.values()].map(cloneFixtureValue)); }
  put(record: StoredRecord) {
    const request: FixtureRequest = {};
    this.tx.schedule(request, () => { this.tx.commit(cloneFixtureValue(record)); return record.key; }, true);
    return request as IDBRequest<IDBValidKey>;
  }
  private request<T>(read: () => T): IDBRequest<T> {
    const request: FixtureRequest = {};
    this.tx.schedule(request, read);
    return request as IDBRequest<T>;
  }
}

class FixtureFactory {
  records = new Map<string, StoredRecord>();
  failNextPut = false;
  private db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({ createIndex() {} }),
    transaction: (_name: string, mode: IDBTransactionMode) => new FixtureTransaction(this, mode),
    close() {},
  };
  open() {
    const request: FixtureRequest<typeof this.db> = { result: this.db };
    queueMicrotask(() => { request.onsuccess?.(new Event("success")); });
    return request as unknown as IDBOpenDBRequest;
  }
}

const scope = (userId = "user-a", projectId = "project", threadId = "thread"): QueueScope => ({ userId, projectId, threadId });
const image = (id: string): Attachment => ({
  id, name: `${id}.png`, original: new File([new Uint8Array([1, 2, 3])], `${id}.png`, { type: "image/png" }),
  model: new Blob([new Uint8Array([4, 5, 6])], { type: "image/webp" }), bytes: 3, reduced: true,
  previewUrl: `blob:composer-${id}`, previewObjectUrl: false, originalRequestId: `original-${id}`,
  modelRequestId: `model-${id}`, relationRequestId: `relation-${id}`,
});
const entry = (id: string, target = scope(), withImage = false): QueueEntry => ({
  id, scope: target, generation: "generation-1", draft: { text: `text-${id}`, revision: 3, images: withImage ? [image(id)] : [] },
  settings: { model: "model-a", effort: "high", permissionMode: "auto", agentMode: "default" }, state: "waiting",
});

test("serialization round-trips File and Blob bytes, keeps request IDs, and hydration makes fresh URLs", async () => {
  const source = entry("with-image", scope(), true), stored = serializeQueueEntry(source);
  assert.equal("previewUrl" in stored.draft.images[0], false);
  assert.equal("previewObjectUrl" in stored.draft.images[0], false);
  assert.equal(stored.draft.images[0].originalRequestId, "original-with-image");
  assert.equal(stored.draft.images[0].modelRequestId, "model-with-image");
  assert.equal(stored.draft.images[0].relationRequestId, "relation-with-image");
  assert.deepEqual([...new Uint8Array(await stored.draft.images[0].original.arrayBuffer())], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(await stored.draft.images[0].model.arrayBuffer())], [4, 5, 6]);
  const first = hydrateQueueEntry(stored), second = hydrateQueueEntry(stored);
  assert.equal(first.draft.images[0].previewObjectUrl, true);
  assert.notEqual(first.draft.images[0].previewUrl, second.draft.images[0].previewUrl);
  const store = createQueueStore(new FixtureFactory() as unknown as IDBFactory);
  const saved = await store.save(scope(), 0, [source]), loaded = await store.load(scope());
  for (const snapshot of [saved, loaded]) {
    const restored = snapshot.entries[0].draft.images[0];
    assert.equal(restored.original.name, "with-image.png");
    assert.deepEqual([...new Uint8Array(await restored.original.arrayBuffer())], [1, 2, 3]);
    assert.deepEqual([...new Uint8Array(await restored.model.arrayBuffer())], [4, 5, 6]);
    assert.equal(restored.originalRequestId, "original-with-image");
    assert.equal(restored.modelRequestId, "model-with-image");
    assert.equal(restored.relationRequestId, "relation-with-image");
  }
  assert.notEqual(saved.entries[0].draft.images[0].previewUrl, loaded.entries[0].draft.images[0].previewUrl);
  releaseQueueEntries([first, second, ...saved.entries, ...loaded.entries]); store.close();
});

test("scope keys cannot collide and stale revision writes leave the stored snapshot intact", async () => {
  assert.notEqual(queueScopeKey(scope("a:b", "c", "d")), queueScopeKey(scope("a", "b:c", "d")));
  const store = createQueueStore(new FixtureFactory() as unknown as IDBFactory), target = scope();
  const saved = await store.save(target, 0, [entry("one", target)]);
  const stale = await store.load(target);
  const next = await store.save(target, saved.revision, [entry("two", target)]);
  await assert.rejects(store.save(target, stale.revision, [entry("stale", target)]), /Конфликт версии/);
  const loaded = await store.load(target);
  assert.equal(loaded.revision, next.revision);
  assert.deepEqual(loaded.entries.map(value => value.id), ["two"]);
  store.close();
});

test("the exact account index enforces the 16-entry total without mixing accounts", async () => {
  const factory = new FixtureFactory(), store = createQueueStore(factory as unknown as IDBFactory);
  const firstScope = scope("shared", "project", "one"), secondScope = scope("shared", "project", "two"), otherUser = scope("other", "project", "one");
  await store.save(firstScope, 0, Array.from({ length: 10 }, (_, i) => entry(`a-${i}`, firstScope)));
  await store.save(secondScope, 0, Array.from({ length: 6 }, (_, i) => entry(`b-${i}`, secondScope)));
  await assert.rejects(store.save(secondScope, 1, Array.from({ length: 7 }, (_, i) => entry(`overflow-${i}`, secondScope))), /ограничена 16/);
  const unchanged = await store.load(secondScope);
  assert.equal(unchanged.revision, 1); assert.equal(unchanged.entries.length, 6);
  const independent = await store.save(otherUser, 0, Array.from({ length: 16 }, (_, i) => entry(`other-${i}`, otherUser)));
  assert.equal(independent.entries.length, 16);
  assert.equal((await store.load(firstScope)).entries.length, 10);
  store.close();
});

test("quota failure rejects and preserves the previous revision and entries", async () => {
  const factory = new FixtureFactory(), store = createQueueStore(factory as unknown as IDBFactory), target = scope();
  const first = await store.save(target, 0, [entry("kept", target)]);
  factory.failNextPut = true;
  await assert.rejects(store.save(target, first.revision, [entry("lost", target)]), /Storage full|QuotaExceeded/);
  const after = await store.load(target);
  assert.equal(after.revision, first.revision);
  assert.deepEqual(after.entries.map(value => value.id), ["kept"]);
  store.close();
});

test("creating the default store is safe without IndexedDB and operations reject clearly", async () => {
  assert.equal(typeof indexedDB, "undefined");
  const store = createQueueStore();
  await assert.rejects(store.load(scope()), /IndexedDB недоступен/);
  await assert.rejects(store.save(scope(), 0, [entry("without-idb")] ), /IndexedDB недоступен/);
  assert.doesNotThrow(() => store.close());
});
