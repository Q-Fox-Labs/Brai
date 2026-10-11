// ABOUTME: Сохраняет общую прочитанность двух экземпляров agent в SQLite.
// ABOUTME: Доверенный owner и время итога определяют изоляцию и порядок отметок.
import { DatabaseSync } from 'node:sqlite';
import { chmod, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { limits, validateReadState } from '../contracts/index.mjs';
import type { ReadState } from '../contracts/index.mjs';

export type ReadMark = { ownerId: string; projectId: string; threadId: string; messageId: string; lastMessageAt: number };
/** Отметка идемпотентна; commit подтверждается до ответа, транзакции разных процессов изолированы. */
export type ReadStatePort = { read(ownerId: string): Promise<ReadState>; mark(mark: ReadMark): Promise<ReadState>; close(): Promise<void> };
const identifier = (id: unknown): id is string => typeof id === 'string' && Array.from(id).length > 0 && Array.from(id).length <= 128;
function fail(code: string, outcome: string): never { throw Object.assign(new Error(code), { code, outcome }); }

/** Открывает private SQLite state с bounded busy timeout; повреждение останавливает запуск. */
export async function openReadState(path: string): Promise<ReadStatePort> {
  if (!isAbsolute(path)) throw new Error('INVALID_READ_STATE_PATH');
  let exists = false;
  try { const metadata = await lstat(path); if (!metadata.isFile()) throw new Error('INVALID_READ_STATE_FILE'); exists = true; }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(path);
  try {
    if (!exists) await chmod(path, 0o600);
    db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL;');
    const version = db.prepare('PRAGMA user_version').get()!.user_version;
    if (version !== 0 && version !== 1) throw new Error('INVALID_READ_STATE_VERSION');
    db.exec(`CREATE TABLE IF NOT EXISTS read_marks (
      owner_id TEXT NOT NULL, project_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      last_message_at INTEGER NOT NULL CHECK(last_message_at >= 0), message_ids TEXT NOT NULL,
      PRIMARY KEY(owner_id, project_id, thread_id)
    ) STRICT; PRAGMA user_version=1;`);
    const rows = db.prepare('SELECT project_id, thread_id, message_ids FROM read_marks WHERE owner_id=? ORDER BY project_id, thread_id');
    const previous = db.prepare('SELECT last_message_at, message_ids FROM read_marks WHERE owner_id=? AND project_id=? AND thread_id=?');
    const upsert = db.prepare(`INSERT INTO read_marks VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner_id, project_id, thread_id) DO UPDATE SET last_message_at=excluded.last_message_at, message_ids=excluded.message_ids`);
    const total = db.prepare('SELECT coalesce(sum(length(CAST(owner_id || project_id || thread_id || message_ids AS BLOB)) + 64), 0) AS size FROM read_marks');
    function snapshot(ownerId: string): ReadState {
      const state = { marks: Object.fromEntries(rows.all(ownerId).map(row => [row.project_id + ':' + row.thread_id, JSON.parse(row.message_ids as string)])) };
      if (!validateReadState(state)) fail('CAPACITY_EXHAUSTED', 'query');
      return state;
    }
    let closed = false;
    return {
      async read(ownerId) {
        if (!identifier(ownerId)) fail('INVALID_ARGUMENT', 'query');
        try { return snapshot(ownerId); }
        catch (error: any) { if (error.code === 'CAPACITY_EXHAUSTED') throw error; fail('UPSTREAM_UNAVAILABLE', 'query'); }
      },
      async mark(mark) {
        if (![mark.ownerId, mark.projectId, mark.threadId, mark.messageId].every(identifier) || !Number.isSafeInteger(mark.lastMessageAt) || mark.lastMessageAt < 0) fail('INVALID_ARGUMENT', 'not-sent');
        let transaction = false, committing = false;
        try {
          // AIDEV-NOTE: BEGIN IMMEDIATE удерживает межпроцессный write lock до проверки и commit.
          db.exec('BEGIN IMMEDIATE'); transaction = true;
          const old = previous.get(mark.ownerId, mark.projectId, mark.threadId);
          let ids: string[] = old ? JSON.parse(old.message_ids as string) : [];
          if (!ids.includes(mark.messageId)) {
            ids = old && mark.lastMessageAt <= Number(old.last_message_at) ? ids : [];
            if (!ids.includes(mark.messageId)) ids.push(mark.messageId);
            if (ids.length > 128) fail('CAPACITY_EXHAUSTED', 'not-sent');
            upsert.run(mark.ownerId, mark.projectId, mark.threadId, Math.max(mark.lastMessageAt, Number(old?.last_message_at ?? 0)), JSON.stringify(ids));
          }
          const state = snapshot(mark.ownerId);
          if (Number(total.get()!.size) > 16 * limits.state) fail('CAPACITY_EXHAUSTED', 'not-sent');
          committing = true; db.exec('COMMIT'); transaction = false;
          return state;
        } catch (error: any) {
          if (transaction) { try { db.exec('ROLLBACK'); } catch {} }
          if (error.code === 'CAPACITY_EXHAUSTED') fail('CAPACITY_EXHAUSTED', 'not-sent');
          fail('UPSTREAM_UNAVAILABLE', committing ? 'unknown' : 'not-sent');
        }
      },
      async close() { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) { db.close(); throw error; }
}
