// ABOUTME: Проверяет координацию очереди, сохранение попыток и отмену через независимые порты.
// ABOUTME: Не подменяет проверку Web Locks/IndexedDB в настоящем браузере.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueueController, type QueueCoordination, type QueueCoordinationMessage, type QueueControllerDeps, type QueueDispatch, type QueueOutcome } from "../lib/agent/queue-controller.ts";
import { queueScopeKey, type QueueEntry, type QueueScope, type QueueSettings, type QueueStore } from "../lib/agent/queue.ts";
import type { ComposerDraft } from "../lib/agent/images.ts";

const scope: QueueScope = { userId: "user", projectId: "project", threadId: "thread" };
const settings: QueueSettings = { model: "model", effort: "high", permissionMode: "auto", agentMode: "default" };
const draft = (text = "message"): ComposerDraft => ({ text, revision: 1, images: [] });
const ready: QueueDispatch = { action: "start", generation: "gen", settings };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function copy(entries: QueueEntry[], previews = false): QueueEntry[] {
  return entries.map(entry => ({
    ...entry, scope: { ...entry.scope }, settings: { ...entry.settings }, attempt: entry.attempt ? { ...entry.attempt } : undefined,
    draft: { ...entry.draft, images: entry.draft.images.map(image => ({ ...image, previewUrl: previews ? URL.createObjectURL(image.model) : "", previewObjectUrl: previews })) },
  }));
}
function fixtures() {
  const database = new Map<string, { revision: number; entries: QueueEntry[] }>();
  const locks = new Map<string, Promise<void>>();
  const subscribers = new Set<(message: QueueCoordinationMessage) => void>();
  let rejectSave: ((entries: QueueEntry[]) => boolean) | undefined;
  const store = (): QueueStore => ({
    async load(address) {
      const value = database.get(queueScopeKey(address)) ?? { revision: 0, entries: [] };
      return { scope: address, revision: value.revision, entries: copy(value.entries, true) };
    },
    async save(address, expectedRevision, entries) {
      const key = queueScopeKey(address), previous = database.get(key) ?? { revision: 0, entries: [] };
      if (previous.revision !== expectedRevision) throw new Error("CAS conflict");
      if (rejectSave?.(entries)) throw new Error("Quota exceeded");
      database.set(key, { revision: previous.revision + 1, entries: copy(entries) });
      return { scope: address, revision: previous.revision + 1, entries: copy(entries, true) };
    },
    close() {},
  });
  const coordination = (): QueueCoordination => {
    const owned = new Set<(message: QueueCoordinationMessage) => void>();
    return {
      available: true,
      async runExclusive(userId, job, signal) {
        const previous = locks.get(userId) ?? Promise.resolve();
        const done = deferred<void>();
        locks.set(userId, done.promise);
        await previous;
        try {
          signal.throwIfAborted();
          return await job();
        } finally { done.resolve(); }
      },
      notify(message) { for (const listener of subscribers) listener(message); },
      subscribe(listener) {
        subscribers.add(listener); owned.add(listener);
        return () => { subscribers.delete(listener); owned.delete(listener); };
      },
      close() { for (const listener of owned) subscribers.delete(listener); owned.clear(); },
    };
  };
  const sent: QueueEntry[] = [];
  const controller = (ports: Partial<QueueControllerDeps> = {}, userId = scope.userId) => createQueueController(userId, {
    store: store(), coordination: coordination(), canDispatch: async () => ready,
    send: async entry => { sent.push(copy([entry])[0]); return "accepted"; }, check: async () => false, ...ports,
  });
  return { controller, store, database, sent, failSave(predicate?: (entries: QueueEntry[]) => boolean) { rejectSave = predicate; } };
}

async function queued(f: ReturnType<typeof fixtures>, ports: Partial<QueueControllerDeps> = {}) {
  const controller = f.controller(ports);
  assert.equal(await controller.open(scope), true);
  assert.equal(await controller.enqueue(draft(), settings, "gen"), true);
  return controller;
}

test("two controllers serialize the whole dispatch and only one mutation wins", async () => {
  const f = fixtures(), first = await queued(f), second = f.controller();
  await second.open(scope); await first.resume(); await second.resume();
  const result = await Promise.all([first.dispatch(), second.dispatch()]);
  assert.equal(result.filter(Boolean).length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].state, "sending");
  assert.ok(f.sent[0].attempt?.operationId);
  assert.deepEqual(f.database.get(queueScopeKey(scope))?.entries, []);
  first.dispose(); second.dispose();
});

test("reload waits for live upload/mutation lock and does not recover a live sending entry", async () => {
  const f = fixtures(), entered = deferred<void>(), reply = deferred<QueueOutcome>();
  const first = await queued(f, { send: async (entry, attempt) => {
    const persisted = f.database.get(queueScopeKey(scope))!.entries[0];
    assert.equal(persisted.state, "sending"); assert.deepEqual(persisted.attempt, attempt);
    assert.equal(entry.attempt?.operationId, attempt.operationId);
    entered.resolve(); return reply.promise;
  } });
  await first.resume();
  const dispatch = first.dispatch(); await entered.promise;
  const second = f.controller(); let opened = false;
  const reload = second.open(scope).then(value => { opened = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(opened, false);
  assert.equal(f.database.get(queueScopeKey(scope))!.entries[0].state, "sending");
  reply.resolve("accepted");
  assert.equal(await dispatch, true); assert.equal(await reload, true);
  assert.equal(second.state().paused, false); assert.equal(second.state().entries.length, 0);
  first.dispose(); second.dispose();
});

test("open converts crash sending to unknown; unknown blocks immediate and FIFO until exact reconciliation", async () => {
  const f = fixtures();
  const entry: QueueEntry = { id: "pending", scope, generation: "gen", draft: draft(), settings, state: "sending", attempt: { operationId: "exact", generation: "gen", action: "start" } };
  f.database.set(queueScopeKey(scope), { revision: 4, entries: [entry] });
  let confirmed = false, checked: string | undefined;
  const controller = f.controller({ check: async value => { checked = value.attempt?.operationId; return confirmed; } });
  await controller.open(scope);
  assert.equal(controller.state().paused, true); assert.equal(controller.state().entries[0].state, "unknown");
  assert.equal(f.database.get(queueScopeKey(scope))!.revision, 5);
  assert.equal(await controller.enqueue(draft("next"), settings, "gen"), true);
  assert.equal(await controller.resume(), false); assert.equal(await controller.dispatch("pending", true), false);
  assert.equal(await controller.edit("pending", draft("edit"), settings), false);
  assert.equal(await controller.move("pending", 1), false);
  assert.equal(await controller.reconcile("pending"), false); assert.equal(checked, "exact");
  assert.equal(f.sent.length, 0);
  confirmed = true;
  assert.equal(await controller.reconcile("pending"), true);
  assert.equal(controller.state().paused, true);
  assert.equal(await controller.dispatch(), false);
  await controller.resume(); assert.equal(await controller.dispatch(), true);
  controller.dispose();
});

test("scope pause broadcasts through a held lock and an ambiguous reply stays unknown", async () => {
  const f = fixtures(), entered = deferred<void>(), reply = deferred<QueueOutcome>(); let sendSignal!: AbortSignal;
  const first = await queued(f, { send: async (_entry, _attempt, signal) => { sendSignal = signal; entered.resolve(); return reply.promise; } });
  const second = f.controller(); await second.open(scope); await first.resume(); await second.resume();
  const dispatch = first.dispatch(); await entered.promise;
  second.pause();
  assert.equal(first.state().paused, true); assert.equal(second.state().paused, true); assert.equal(sendSignal.aborted, true);
  reply.resolve("unknown"); assert.equal(await dispatch, false);
  await second.open(scope);
  assert.equal(first.state().entries[0].state, "unknown"); assert.equal(second.state().entries[0].state, "unknown");
  assert.equal(await first.dispatch(first.state().entries[0].id, true), false);
  assert.equal(await second.remove(second.state().entries[0].id), true);
  assert.equal(second.state().paused, true);
  first.dispose(); second.dispose();
});

test("not-sent is editable and failed head is never automatically retried", async () => {
  const f = fixtures(); let sends = 0;
  const controller = await queued(f, { send: async () => { sends++; return "not-sent"; } });
  await controller.resume(); assert.equal(await controller.dispatch(), false);
  const id = controller.state().entries[0].id;
  assert.equal(controller.state().entries[0].state, "failed");
  assert.equal(await controller.dispatch(), false); assert.equal(sends, 1);
  assert.equal(await controller.edit(id, draft("corrected"), settings), true);
  assert.equal(controller.state().entries[0].state, "waiting");
  assert.equal(controller.state().entries[0].attempt, undefined);
  assert.equal(controller.state().entries[0].draft.text, "corrected");
  controller.dispose();
});

test("storage rejection preserves composer and queue and never calls send", async () => {
  const f = fixtures(), controller = f.controller(); await controller.open(scope);
  const input = draft("keep me"); f.failSave(() => true);
  assert.equal(await controller.enqueue(input, settings, "gen"), false);
  assert.deepEqual(input, draft("keep me")); assert.equal(controller.state().entries.length, 0);
  assert.match(controller.state().error!, /Quota/); assert.equal(f.sent.length, 0);
  f.failSave(); await controller.enqueue(input, settings, "gen"); await controller.resume();
  f.failSave(entries => entries.some(entry => entry.state === "sending"));
  assert.equal(await controller.dispatch(), false); assert.equal(f.sent.length, 0);
  assert.equal(controller.state().entries[0].draft.text, "keep me");
  controller.dispose();
});

test("post-accepted save failure leaves unknown paused and does not send again", async () => {
  const f = fixtures(); let sends = 0;
  const controller = await queued(f, { send: async () => { sends++; f.failSave(() => true); return "accepted"; } });
  await controller.resume(); assert.equal(await controller.dispatch(), false);
  assert.equal(controller.state().paused, true); assert.equal(controller.state().entries[0].state, "unknown");
  assert.match(controller.state().error!, /сохранить исход/);
  assert.equal(await controller.dispatch(controller.state().entries[0].id, true), false); assert.equal(sends, 1);
  controller.dispose();
});

test("temporary prerequisite keeps waiting; invalid model becomes failed; recheck applies actual steer settings", async () => {
  const f = fixtures(); let calls = 0, mode = "temporary";
  const actual = { ...settings, model: "active-model" };
  const controller = await queued(f, {
    canDispatch: async () => {
      calls++;
      if (mode === "invalid") throw new Error("Модель недоступна");
      return mode === "temporary" && calls % 2 === 0 ? null : { ...ready, action: "steer", expectedTurnId: "active", settings: actual };
    },
  });
  await controller.resume(); assert.equal(await controller.dispatch(), false);
  assert.equal(calls, 2); assert.equal(controller.state().entries[0].state, "waiting"); assert.equal(f.sent.length, 0);
  mode = "invalid"; assert.equal(await controller.dispatch(), false);
  assert.equal(controller.state().entries[0].state, "failed"); assert.match(controller.state().entries[0].error!, /Модель/);
  const id = controller.state().entries[0].id; await controller.edit(id, draft(), settings);
  mode = "ready"; assert.equal(await controller.dispatch(), true);
  assert.equal(f.sent[0].settings.model, "active-model"); assert.equal(f.sent[0].attempt?.action, "steer"); assert.equal(f.sent[0].attempt?.expectedTurnId, "active");
  controller.dispose();
});

test("FIFO, explicit immediate, edits, moves and removal keep the selected scope isolated", async () => {
  const f = fixtures(), controller = await queued(f);
  await controller.enqueue(draft("second"), settings, "gen");
  const [first, second] = controller.state().entries;
  assert.equal(await controller.move(second.id, -1), true);
  assert.equal(controller.state().entries[0].id, second.id);
  assert.equal(await controller.dispatch(first.id, true), true);
  assert.equal(controller.state().paused, false); assert.equal(f.sent[0].id, first.id);
  const other = { ...scope, threadId: "other" }; await controller.open(other);
  assert.equal(controller.state().entries.length, 0); assert.equal(await controller.remove(second.id), false);
  await controller.open(scope); assert.equal(controller.state().entries[0].id, second.id);
  assert.equal(await controller.remove(second.id), true);
  assert.equal(await controller.open({ ...scope, userId: "wrong" }), false);
  assert.equal(await controller.enqueue(draft(), settings, "gen"), false);
  controller.dispose();
});

test("selection abort prevents upload continuation and late reply cannot modify the new scope", async () => {
  const f = fixtures(), entered = deferred<void>(), reply = deferred<QueueOutcome>(); let signal!: AbortSignal;
  const controller = await queued(f, { send: async (_entry, _attempt, current) => { signal = current; entered.resolve(); return reply.promise; } });
  await controller.resume(); const sending = controller.dispatch(); await entered.promise;
  const other = { ...scope, threadId: "other" }, opening = controller.open(other);
  assert.equal(signal.aborted, true); assert.deepEqual(controller.state().scope, other);
  reply.resolve("not-sent"); assert.equal(await sending, false); assert.equal(await opening, true);
  assert.deepEqual(controller.state().scope, other); assert.equal(controller.state().entries.length, 0);
  assert.equal(f.database.get(queueScopeKey(scope))!.entries[0].state, "failed");
  controller.dispose();
});

test("dispose aborts a late account reply and releases every owned URL but never composer URL", async () => {
  const previousCreate = URL.createObjectURL, previousRevoke = URL.revokeObjectURL;
  const created: string[] = [], revoked: string[] = [];
  URL.createObjectURL = () => { const value = `blob:owned-${created.length}`; created.push(value); return value; };
  URL.revokeObjectURL = value => { revoked.push(value); };
  try {
    const f = fixtures(), entered = deferred<void>(), reply = deferred<QueueOutcome>(); let signal!: AbortSignal;
    const controller = f.controller({ send: async (_entry, _attempt, current) => { signal = current; entered.resolve(); return reply.promise; } });
    await controller.open(scope);
    const file = new File(["image"], "a.png", { type: "image/png" });
    const input: ComposerDraft = { ...draft(), images: [{ id: "image", name: file.name, original: file, model: file, bytes: file.size, reduced: false, previewUrl: "blob:composer", previewObjectUrl: true, originalRequestId: "original", modelRequestId: null, relationRequestId: "relation" }] };
    await controller.enqueue(input, settings, "gen");
    assert.notEqual(controller.state().entries[0].draft.images[0].previewUrl, "blob:composer");
    await controller.resume(); const sending = controller.dispatch(); await entered.promise;
    controller.dispose(); assert.equal(signal.aborted, true);
    reply.resolve("accepted"); await sending;
    assert.equal(controller.state().scope, null); assert.deepEqual(controller.state().entries, []);
    assert.equal(f.database.get(queueScopeKey(scope))!.entries.length, 0);
    assert.equal(revoked.includes("blob:composer"), false);
    assert.deepEqual([...new Set(revoked)].sort(), [...created].sort());
    assert.equal(new Set(revoked).size, revoked.length);
  } finally { URL.createObjectURL = previousCreate; URL.revokeObjectURL = previousRevoke; }
});

test("unavailable coordination disables all queue commands with an explicit error", async () => {
  const f = fixtures();
  const controller = createQueueController(scope.userId, { store: f.store(), canDispatch: async () => ready, send: async () => "accepted", check: async () => false });
  assert.equal(controller.state().available, false); assert.match(controller.state().error!, /Web Locks.*BroadcastChannel/);
  assert.equal(await controller.open(scope), false); assert.equal(await controller.enqueue(draft(), settings, "gen"), false);
  controller.dispose();
});


test("new queue runs automatically; restored queue pauses; scoped Stop survives navigation and does not pause another chat", async () => {
  const f = fixtures(), first = f.controller(), second = f.controller();
  await first.open(scope); assert.equal(first.state().paused, false);
  await first.enqueue(draft(), settings, "gen");
  await second.open(scope); assert.equal(second.state().paused, true);
  const other = { ...scope, threadId: "other" }; await second.open(other);
  assert.equal(second.state().paused, false);
  first.pause(); assert.equal(second.state().paused, false);
  await first.open(other); assert.equal(first.state().paused, false);
  await first.open(scope); assert.equal(first.state().paused, true);
  await second.open(scope); assert.equal(second.state().paused, true);
  await first.resume(); await first.open(other); await first.open(scope);
  assert.equal(first.state().paused, false);
  first.dispose(); second.dispose();
});

test("persistent attempt-save failure pauses dispatch instead of retrying storage automatically", async () => {
  const f = fixtures(), controller = await queued(f);
  await controller.resume(); f.failSave(() => true);
  assert.equal(await controller.dispatch(), false);
  assert.equal(controller.state().paused, true);
  assert.equal(controller.state().entries[0].draft.text, "message");
  assert.equal(controller.state().entries[0].state, "waiting");
  assert.match(controller.state().error!, /Quota/);
  assert.equal(await controller.dispatch(), false); assert.equal(f.sent.length, 0);
  controller.dispose();
});

test("reentrant dispatch while prerequisites wait is rejected without building a chain of jobs", async () => {
  const f = fixtures(), entered = deferred<void>(), permit = deferred<QueueDispatch>(); let checks = 0;
  const controller = await queued(f, { canDispatch: async () => { checks++; entered.resolve(); return permit.promise; } });
  const attempts: Promise<boolean>[] = [];
  const unsubscribe = controller.subscribe(() => { attempts.push(controller.dispatch()); });
  const sending = controller.dispatch(); await entered.promise;
  assert.equal(await controller.dispatch(), false);
  permit.resolve(ready); assert.equal(await sending, true);
  assert.equal((await Promise.all(attempts)).every(value => !value), true);
  assert.equal(checks, 2); assert.equal(f.sent.length, 1);
  unsubscribe(); controller.dispose();
});

test("steer uses active settings on the wire but not-sent preserves user's queued settings for future start", async () => {
  const f = fixtures(), actual = { ...settings, model: "active", effort: "low" };
  let wire: QueueSettings | undefined;
  const controller = await queued(f, {
    canDispatch: async () => ({ ...ready, action: "steer", settings: actual }),
    send: async entry => { wire = entry.settings; return "not-sent"; },
  });
  assert.equal(await controller.dispatch(controller.state().entries[0].id, true), false);
  assert.deepEqual(wire, actual);
  assert.deepEqual(controller.state().entries[0].settings, settings);
  assert.deepEqual(f.database.get(queueScopeKey(scope))!.entries[0].settings, settings);
  controller.dispose();
});


test("known unknown after accepted/save failures reconciles or removes exact persisted attempt without reopening", async () => {
  for (const action of ["reconcile", "remove"] as const) {
    const f = fixtures(); let sends = 0, operation: string | undefined;
    const controller = await queued(f, {
      send: async entry => { sends++; operation = entry.attempt?.operationId; f.failSave(() => true); return "accepted"; },
      check: async entry => entry.attempt?.operationId === operation,
    });
    assert.equal(await controller.dispatch(), false);
    const id = controller.state().entries[0].id;
    assert.equal(controller.state().entries[0].state, "unknown");
    assert.equal(f.database.get(queueScopeKey(scope))!.entries[0].state, "sending");
    f.failSave();
    assert.equal(await controller[action](id), true);
    assert.equal(controller.state().entries.length, 0);
    assert.equal(controller.state().paused, true);
    assert.equal(sends, 1); assert.equal(f.database.get(queueScopeKey(scope))!.entries.length, 0);
    controller.dispose();
  }
});

test("Stop arriving while Resume waits for another live dispatch remains authoritative", async () => {
  const f = fixtures(), entered = deferred<void>(), reply = deferred<QueueOutcome>();
  const sender = await queued(f, { send: async () => { entered.resolve(); return reply.promise; } });
  const receiver = f.controller(); await receiver.open(scope);
  const sending = sender.dispatch(); await entered.promise;
  const resuming = receiver.resume(); receiver.pause();
  reply.resolve("not-sent"); await sending;
  assert.equal(await resuming, false); assert.equal(receiver.state().paused, true);
  sender.dispose(); receiver.dispose();
});


test("dispatch load failure pauses auto dispatch and preserves the waiting message", async () => {
  const f = fixtures(), store = f.store(), originalLoad = store.load;
  const controller = await queued(f, { store });
  store.load = async () => { throw new Error("IndexedDB unavailable"); };
  assert.equal(await controller.dispatch(), false);
  assert.equal(controller.state().paused, true);
  assert.equal(controller.state().entries[0].draft.text, "message");
  assert.match(controller.state().error!, /IndexedDB/);
  assert.equal(await controller.dispatch(), false); assert.equal(f.sent.length, 0);
  store.load = originalLoad; controller.dispose();
});


test("enqueue checks fresh thread eligibility after the held account lock, preserving draft after archive", async () => {
  const f = fixtures(), entered = deferred<void>(), reply = deferred<QueueOutcome>();
  const sender = await queued(f, { send: async () => { entered.resolve(); return reply.promise; } });
  let allowed = true, checks = 0;
  const receiver = f.controller({ canEnqueue: async entry => { checks++; assert.deepEqual(entry.scope, scope); return allowed; } });
  await receiver.open(scope);
  const sending = sender.dispatch(); await entered.promise;
  const input = draft("retain after archive"), enqueueing = receiver.enqueue(input, settings, "gen");
  await Promise.resolve(); assert.equal(checks, 0);
  allowed = false; reply.resolve("accepted"); await sending;
  const afterArchive = f.database.get(queueScopeKey(scope))!.revision;
  assert.equal(await enqueueing, false);
  assert.equal(checks, 1); assert.deepEqual(input, draft("retain after archive"));
  assert.equal(f.database.get(queueScopeKey(scope))!.revision, afterArchive);
  assert.equal(f.database.get(queueScopeKey(scope))!.entries.length, 0);
  sender.dispose(); receiver.dispose();
});

test("enqueue eligibility failure reports the exact reason without saving or consuming composer", async () => {
  const f = fixtures(), controller = f.controller({ canEnqueue: async () => { throw new Error("Чат архивирован. Выберите другой чат."); } });
  await controller.open(scope);
  const input = draft("retain me");
  assert.equal(await controller.enqueue(input, settings, "gen"), false);
  assert.equal(controller.state().error, "Чат архивирован. Выберите другой чат.");
  assert.deepEqual(input, draft("retain me")); assert.equal(controller.state().entries.length, 0);
  assert.equal(f.database.has(queueScopeKey(scope)), false);
  controller.dispose();
});

test("selection abort during enqueue eligibility cannot save the old scope", async () => {
  const f = fixtures(), entered = deferred<void>(), permitted = deferred<boolean>();
  const controller = f.controller({ canEnqueue: async (_entry, signal) => { entered.resolve(); const value = await permitted.promise; assert.equal(signal.aborted, true); return value; } });
  await controller.open(scope);
  const input = draft("keep old input"), enqueueing = controller.enqueue(input, settings, "gen");
  await entered.promise;
  const other = { ...scope, threadId: "other" }, opening = controller.open(other);
  permitted.resolve(true);
  assert.equal(await enqueueing, false); assert.equal(await opening, true);
  assert.equal(f.database.has(queueScopeKey(scope)), false);
  assert.deepEqual(input, draft("keep old input")); assert.deepEqual(controller.state().scope, other);
  controller.dispose();
});
