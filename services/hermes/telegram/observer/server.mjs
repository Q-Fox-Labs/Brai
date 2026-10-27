// ABOUTME: Предоставляет чтение журнала Telegram через ограниченный NATS Services API.
// ABOUTME: Не принимает команды агенту и не выдаёт файлы или пути профиля.
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, headers, ServiceErrorHeader, ServiceErrorCodeHeader } from 'nats';

const subject = 'brai.hermes.telegram.observer.v1.query';
const encoder = new TextEncoder();
const bad = code => Object.assign(new Error(code), { code });

function result(row) {
  if (!row) return null;
  const { attachments, ...message } = row;
  return { ...message, attachments: JSON.parse(attachments) };
}

/** Выполняет только ограниченные чтения фиксированного журнала текущего профиля. */
export function queryJournal(db, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw bad('INVALID_ARGUMENT');
  const allowed = { status: ['action'], chats: ['action', 'before', 'limit'],
    messages: ['action', 'chatId', 'threadId', 'before', 'limit'], changes: ['action', 'after', 'limit'],
    attachment: ['action', 'identity', 'artifactId'] };
  if (!Object.hasOwn(allowed, request.action) || Object.keys(request).some(key => !allowed[request.action].includes(key))) throw bad('INVALID_ARGUMENT');
  const limit = request.limit === undefined ? 50 : request.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw bad('INVALID_ARGUMENT');
  const string = value => typeof value === 'string' && value.length <= 256;
  const cursor = value => Number.isSafeInteger(value) && value >= 0;
  if (request.action === 'status') {
    const row = db.prepare('SELECT COALESCE(MAX(seq),0) AS cursor FROM changes').get();
    return { cursor: row.cursor };
  }
  if (request.action === 'chats') {
    if (request.before !== undefined && !cursor(request.before)) throw bad('INVALID_ARGUMENT');
    const rows = db.prepare(`SELECT chat_id, thread_id, MAX(rowid) AS last_row,
      (SELECT m.chat_type FROM messages m WHERE m.chat_id=a.chat_id AND m.thread_id=a.thread_id ORDER BY COALESCE(m.occurred_at,'') DESC, m.rowid DESC LIMIT 1) AS chat_type,
      (SELECT m.chat_name FROM messages m WHERE m.chat_id=a.chat_id AND m.thread_id=a.thread_id AND m.chat_name<>'' ORDER BY COALESCE(m.occurred_at,'') DESC, m.rowid DESC LIMIT 1) AS chat_name,
      (SELECT m.text FROM messages m WHERE m.chat_id=a.chat_id AND m.thread_id=a.thread_id ORDER BY COALESCE(m.occurred_at,'') DESC, m.rowid DESC LIMIT 1) AS last_text,
      (SELECT m.occurred_at FROM messages m WHERE m.chat_id=a.chat_id AND m.thread_id=a.thread_id ORDER BY COALESCE(m.occurred_at,'') DESC, m.rowid DESC LIMIT 1) AS last_at
      FROM messages a GROUP BY chat_id, thread_id HAVING MAX(rowid) < ? ORDER BY last_row DESC LIMIT ?`)
      .all(request.before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    const chats = rows.slice(0, limit);
    return { chats, before: rows.length > limit ? chats[chats.length - 1].last_row : null };
  }
  if (request.action === 'messages') {
    if (!string(request.chatId) || !request.chatId || !string(request.threadId) ||
        (request.before !== undefined && !cursor(request.before))) throw bad('INVALID_ARGUMENT');
    const before = request.before ?? Number.MAX_SAFE_INTEGER;
    const previous = request.before === undefined ? null : db.prepare('SELECT COALESCE(occurred_at,\'\') AS stamp FROM messages WHERE rowid=? AND chat_id=? AND thread_id=?')
      .get(before, request.chatId, request.threadId);
    if (request.before !== undefined && !previous) throw bad('INVALID_ARGUMENT');
    const rows = db.prepare(`SELECT rowid AS row_id, * FROM messages WHERE chat_id=? AND thread_id=?
      AND (COALESCE(occurred_at,'') < ? OR (COALESCE(occurred_at,'') = ? AND rowid < ?))
      ORDER BY COALESCE(occurred_at,'') DESC, rowid DESC LIMIT ?`)
      .all(request.chatId, request.threadId, previous?.stamp ?? '\uffff', previous?.stamp ?? '\uffff', before, limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse().map(result);
    return { messages: page, before: hasMore ? page[0].row_id : null };
  }
  if (request.action === 'changes') {
    if (!cursor(request.after)) throw bad('INVALID_ARGUMENT');
    const rows = db.prepare('SELECT c.seq AS change_seq, m.rowid AS row_id, m.* FROM changes c JOIN messages m ON m.identity=c.identity WHERE c.seq>? ORDER BY c.seq LIMIT ?')
      .all(request.after, limit);
    return { changes: rows.map(result), cursor: rows.length ? rows[rows.length - 1].change_seq : request.after };
  }
  if (request.action === 'attachment') {
    if (!string(request.identity) || !request.identity || !string(request.artifactId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.artifactId)) throw bad('INVALID_ARGUMENT');
    const row = db.prepare('SELECT attachments FROM messages WHERE identity=?').get(request.identity);
    return { allowed: !!row && JSON.parse(row.attachments).some(value => value.artifactId === request.artifactId) };
  }
  throw bad('INVALID_ARGUMENT');
}

/** Запускает единственный NATS endpoint; каждый запрос открывает SQLite только на чтение. */
export async function startObserver({ config, database }) {
  if (!database?.startsWith('/') || typeof config.ownerId !== 'string' || !config.ownerId || config.ownerId.length > 128 || /\s/.test(config.ownerId)) throw bad('INVALID_CONFIGURATION');
  const nc = await connect({ servers: config.nats.servers, user: config.nats.user, pass: config.nats.password,
    inboxPrefix: config.nats.inboxPrefix, name: 'brai-hermes-telegram-observer', timeout: 5000 });
  const service = await nc.services.add({ name: 'brai_hermes_telegram_observer', version: '1.0.0', queue: 'brai_hermes_telegram_observer' });
  service.addEndpoint('query', { subject, handler: (_error, message) => {
    if (_error) return;
    let db;
    try {
      if (message.data.length > 4096) throw bad('INVALID_ARGUMENT');
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message.data));
      db = new DatabaseSync(database, { readOnly: true });
      db.exec('PRAGMA busy_timeout=1000; PRAGMA query_only=ON');
      const result = queryJournal(db, input);
      if (input.action === 'attachment' && result.allowed) result.ownerId = config.ownerId;
      const body = encoder.encode(JSON.stringify(result));
      if (body.length > 1_048_576) throw bad('PAYLOAD_TOO_LARGE');
      message.respond(body);
    } catch (error) {
      const code = ['INVALID_ARGUMENT', 'PAYLOAD_TOO_LARGE'].includes(error.code) ? error.code : 'UNAVAILABLE';
      const h = headers(); h.set(ServiceErrorHeader, code); h.set(ServiceErrorCodeHeader, code === 'INVALID_ARGUMENT' ? '400' : '503');
      message.respond(encoder.encode(JSON.stringify({ code })), { headers: h });
    } finally { db?.close(); }
  }});
  return async () => { await service.stop(); await nc.drain(); };
}

let isMain = false;
try { isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); } catch {}
if (isMain) {
  try {
    const path = process.env.BRAI_TELEGRAM_OBSERVER_NATS_CONFIG;
    if (!path?.startsWith('/')) throw bad('INVALID_CONFIGURATION');
    const nats = JSON.parse(await readFile(path, 'utf8'));
    if (!nats || typeof nats !== 'object' || Array.isArray(nats) ||
        Object.keys(nats).sort().join(',') !== 'inboxPrefix,ownerId,password,servers,user' ||
        !Array.isArray(nats.servers) || !nats.servers.length || nats.servers.some(value => typeof value !== 'string' || !value) ||
        !['inboxPrefix', 'ownerId', 'password', 'user'].every(key => typeof nats[key] === 'string' && nats[key])) throw bad('INVALID_CONFIGURATION');
    const stop = await startObserver({ config: { nats, ownerId: nats.ownerId }, database: process.env.BRAI_TELEGRAM_OBSERVER_DB });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop(); });
  } catch { console.error('TELEGRAM_OBSERVER_START_FAILED'); process.exitCode = 1; }
}
