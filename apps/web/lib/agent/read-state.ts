// ABOUTME: Сверяет общие отметки чтения и переносит прежние browser marks после подтверждения.
// ABOUTME: localStorage хранит только неотправленные отметки; ошибки сохраняют очередь и подтверждённое состояние.
import { validateReadState } from "@brai/agent/contracts";
import type { ReadState, ThreadMetadata } from "@brai/agent/contracts";

type Mark = { projectId: string; threadId: string; messageId: string; lastMessageAt: number };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
type Ports = {
  read: () => Promise<ReadState>; mark: (mark: Mark) => Promise<ReadState>;
  storage: Storage; userId: string; update: (state: ReadState, error: string) => void;
};

/** Использует тот же предикат для галочки чата и счётчика всех завершённых чатов проекта. */
export function unreadFinal(projectId: string, thread: ThreadMetadata, marks: ReadState["marks"]): boolean {
  return !!thread.finalMessageId && !thread.active && !thread.awaitingReply && !marks[`${projectId}:${thread.id}`]?.includes(thread.finalMessageId);
}

/** Сериализует readState/readMark; повтор отметки идемпотентен, dispose игнорирует поздние ответы. */
export function createReadStateSync({ read, mark, storage, userId, update }: Ports) {
  const legacyKey = `brai.agent.read:${userId}`, pendingKey = `brai.agent.read-pending:${userId}`;
  const pending = new Map<string, Mark>();
  let state: ReadState = { marks: {} }, stopped = false, rerun = false, running: Promise<void> | undefined;
  const identity = (value: Mark) => JSON.stringify([value.projectId, value.threadId, value.messageId]);
  const parse = (key: string): unknown => { try { return JSON.parse(storage.getItem(key) ?? "null"); } catch { return null; } };
  const legacy = parse(legacyKey);
  const remainingLegacy: Record<string, string> = {};
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) for (const [key, value] of Object.entries(legacy)) {
    const split = key.indexOf(":");
    if (split < 1 || key.length > 300 || typeof value !== "string" || !value.trim() || value.length > 128) continue;
    const entry = { projectId: key.slice(0, split), threadId: key.slice(split + 1), messageId: value, lastMessageAt: 0 };
    if (!entry.threadId || entry.projectId.length > 128 || entry.threadId.length > 128) continue;
    remainingLegacy[key] = value; pending.set(identity(entry), entry);
  }
  const saved = parse(pendingKey);
  if (Array.isArray(saved)) for (const value of saved) {
    if (!value || ![value.projectId, value.threadId, value.messageId].every(item => typeof item === "string" && item.trim() && item.length <= 128) || !Number.isSafeInteger(value.lastMessageAt) || value.lastMessageAt < 0) continue;
    const entry = { projectId: value.projectId, threadId: value.threadId, messageId: value.messageId, lastMessageAt: value.lastMessageAt };
    pending.set(identity(entry), entry);
  }
  function persist() {
    try {
      if (pending.size) storage.setItem(pendingKey, JSON.stringify([...pending.values()])); else storage.removeItem(pendingKey);
      if (Object.keys(remainingLegacy).length) storage.setItem(legacyKey, JSON.stringify(remainingLegacy)); else storage.removeItem(legacyKey);
    } catch { /* До подтверждения очередь остаётся в памяти; прежнее хранилище не удаляется при ошибке записи. */ }
  }
  function accept(value: ReadState) {
    if (!validateReadState(value)) throw new Error("BAD_READ_STATE");
    state = value;
  }
  async function flush() {
    const error = "Не удалось синхронизировать прочтение. Повторим при следующей сверке.";
    let failed = false;
    try {
      const value = await read();
      if (stopped) return false;
      accept(value); update(state, "");
      // AIDEV-NOTE: Каждая отметка ждёт durable ack; при отказе следующие остаются для очередной сверки.
      for (const [id, entry] of [...pending]) {
        try {
          const value = await mark(entry);
          if (stopped) return false;
          accept(value);
        } catch (problem) {
          if (stopped) return false;
          failed = true; update(state, error);
          // AIDEV-NOTE: Удалённый проект не должен блокировать чтение доступных чатов; общий отказ останавливает пакет.
          if (problem && typeof problem === "object" && "code" in problem && ["NOT_FOUND", "INVALID_ARGUMENT"].includes(String(problem.code))) continue;
          return false;
        }
        if (pending.get(id) === entry) pending.delete(id);
        const key = `${entry.projectId}:${entry.threadId}`;
        if (remainingLegacy[key] === entry.messageId) delete remainingLegacy[key];
        persist(); update(state, failed ? error : "");
      }
      return true;
    } catch { if (!stopped) update(state, error); return false; }
  }
  const sync = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (!running) running = (async () => {
      do { rerun = false; if (!await flush()) break; } while (rerun && !stopped);
    })().finally(() => { running = undefined; });
    return running;
  };
  return {
    sync,
    /** Ставит показанный итог в очередь; интерфейс скрывает галочку только после ответа сервера. */
    seen(entry: Mark) {
      if (stopped || state.marks[`${entry.projectId}:${entry.threadId}`]?.includes(entry.messageId)) return;
      const id = identity(entry);
      if ((pending.get(id)?.lastMessageAt ?? -1) >= entry.lastMessageAt) return;
      pending.set(id, entry); persist(); if (running) rerun = true; void sync();
    },
    dispose() { stopped = true; },
  };
}
