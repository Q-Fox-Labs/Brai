// ABOUTME: Читает фактический Telegram-журнал выбранного профиля через защищённые снимки.
// ABOUTME: Текст не преобразует; вложения связывает по сохранённому provenance, владельца проверяет Control.
import { join, isAbsolute } from 'node:path';

const safe = value => Number.isSafeInteger(value) && value >= 0;
const ref = value => {
  if (!value || !/^[0-9a-f-]{36}$/i.test(value.artifactId) || typeof value.filename !== 'string' || typeof value.mimeType !== 'string') return null;
  return Object.fromEntries(['artifactId', 'filename', 'mimeType', 'sizeBytes', 'sha256', 'width', 'height'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
};


/** Восстановить только список известных тем; содержимое native messages не читается. */
function knownChats(snapshot, profile, cursor, limit) {
  const offset = Number(cursor.slice('metadata:'.length));
  if (!safe(offset)) throw new Error('INVALID_CURSOR');
  try {
    return snapshot(profile, db => {
      const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name));
      const fields = ['chat_id','thread_id','display_name','origin_json','title','last_activity_at','started_at'].filter(key => columns.has(key));
      const rows = db.prepare('SELECT id' + (fields.length ? ',' + fields.join(',') : '') + " FROM sessions WHERE source='telegram' ORDER BY id DESC LIMIT ? OFFSET ?").all(limit + 1, offset);
      const items = [];
      for (const row of rows.slice(0, limit)) {
        let origin = {};
        try { origin = JSON.parse(row.origin_json || '{}') || {}; } catch {}
        const chat = String(row.chat_id || origin.chat_id || ''), thread = String(row.thread_id || origin.thread_id || '');
        if (!/^[1-9][0-9]{0,19}$/.test(chat)) continue;
        const stamp = row.last_activity_at ?? row.started_at;
        items.push({ id: JSON.stringify([chat, thread === '1' ? '' : thread]), title: row.title || '',
          updatedAt: typeof stamp === 'number' ? new Date(stamp * 1000).toISOString() : '',
          participant: { telegramId: chat, name: row.display_name || origin.user_name || '' } });
      }
      return { source: 'telegram', items, nextCursor: rows.length > limit ? 'metadata:' + (offset + limit) : null };
    });
  } catch (error) {
    if (error.code === 'ENOENT') return { source: 'telegram', items: [], nextCursor: null };
    throw error;
  }
}

/** Создать read-only порт; пути и UID поступают только из защищённой сборки. */
export function createTelegramChatRead({ root, uid, snapshot }) {
  return async ({ operation, profile, id, cursor, limit }) => {
    if (!isAbsolute(root ?? '') || !Number.isSafeInteger(uid) || uid <= 0 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(profile.profileId)) throw new Error('SOURCE_UNAVAILABLE');
    if (operation === 'admin-chats-list' && cursor?.startsWith('metadata:')) return knownChats(snapshot, profile, cursor, limit);
    const target = { ...profile, home: join(root, profile.profileId), workerUid: uid };
    let page;
    try {
      page = snapshot(target, db => {
        let before, after;
        if (cursor) {
          const match = /^(before|changes):([0-9]+)$/.exec(cursor);
          if (!match || !safe(Number(match[2]))) throw new Error('INVALID_CURSOR');
          if (match[1] === 'before') before = Number(match[2]); else after = Number(match[2]);
        }
        if (operation === 'admin-chats-list') {
          if (after !== undefined) throw new Error('INVALID_CURSOR');
          const rows = db.prepare(`SELECT chat,thread,MAX(id) AS last,
            (SELECT name FROM messages m WHERE m.chat=a.chat AND m.direction='in' ORDER BY id DESC LIMIT 1) AS name,
            (SELECT username FROM messages m WHERE m.chat=a.chat AND m.direction='in' ORDER BY id DESC LIMIT 1) AS username,
            MAX(at) AS updated FROM messages a GROUP BY chat,thread HAVING MAX(id)<? ORDER BY last DESC LIMIT ?`)
            .all(before ?? Number.MAX_SAFE_INTEGER, limit + 1);
          return { source: 'telegram', items: rows.slice(0, limit).map(row => ({
            id: JSON.stringify([row.chat, row.thread]), title: row.name || row.username || '', updatedAt: row.updated || '',
            participant: { telegramId: row.chat, name: row.name || '', username: row.username || null }
          })), nextCursor: rows.length > limit ? 'before:' + rows[limit - 1].last : 'metadata:0' };
        }
        const route = JSON.parse(id);
        if (!Array.isArray(route) || route.length !== 2 || route.some(value => typeof value !== 'string')) throw new Error('INVALID_CHAT');
        const through = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM changes').get().seq;
        const rows = after === undefined
          ? db.prepare('SELECT * FROM messages WHERE chat=? AND thread=? AND CAST(telegram_id AS INTEGER)<? ORDER BY CAST(telegram_id AS INTEGER) DESC LIMIT ?').all(...route, before ?? Number.MAX_SAFE_INTEGER, limit + 1)
          : db.prepare('SELECT m.*,c.seq AS seq FROM changes c JOIN messages m ON m.id=c.message WHERE m.chat=? AND m.thread=? AND c.seq>? ORDER BY c.seq LIMIT ?').all(...route, after, limit + 1);
        const selected = rows.slice(0, limit);
        const next = rows.length > limit ? (after === undefined ? 'before:' + selected.at(-1).telegram_id : 'changes:' + selected.at(-1).seq) : null;
        const updatesCursor = 'changes:' + (after === undefined || !next ? through : selected.at(-1).seq);
        return { source: 'telegram', _changes: after !== undefined, messages: (after === undefined ? selected.reverse() : selected).map(row => ({
          id: String(row.telegram_id), _seq: row.seq, role: row.direction === 'in' ? 'user' : 'assistant', text: row.text, createdAt: row.at || '',
          authorName: row.name, authorUsername: row.username, telegramId: row.telegram_id, messageType: row.kind,
          editedAt: row.edited || null, deleted: row.deleted === 1, ...(row.rich && row.rich !== 'null' ? { richMessage: JSON.parse(row.rich) } : {}), attachments: JSON.parse(row.attachments).map(ref).filter(Boolean),
          attachmentState: 'none', chat: row.chat, thread: row.thread
        })), nextCursor: next, updatesCursor };
      }, { databaseName: 'telegram.sqlite3' });
    } catch (error) {
      if (error.code === 'ENOENT') return operation === 'admin-chats-list'
        ? knownChats(snapshot, profile, 'metadata:0', limit)
        : { source: 'telegram', messages: [], nextCursor: null, updatesCursor: 'changes:0' };
      throw error;
    }
    // AIDEV-NOTE: Входные файлы уже публикует штатный FileStore worker. Читаем только
    // его подтверждённые ссылки по exact source; байты и owner повторно проверяет Artifacts.
    const incoming = page.messages?.filter(message => message.role === 'user' && !message.deleted) ?? [];
    if (incoming.length) {
      try {
        snapshot({ ...profile, home: join(profile.home, 'brai-files') }, db => {
          const query = db.prepare(`SELECT ref FROM items WHERE artifact IS NOT NULL AND ref IS NOT NULL
            AND json_extract(source,'$.platform')='telegram' AND json_extract(source,'$.chat')=?
            AND json_extract(source,'$.thread') IN (?,?) AND json_extract(source,'$.messageId')=? ORDER BY position`);
          for (const message of incoming) {
            for (const row of query.all(message.chat, message.thread, message.thread || '1', message.telegramId)) {
              const file = ref(JSON.parse(row.ref));
              if (file && !message.attachments.some(item => item.artifactId === file.artifactId)) message.attachments.push(file);
            }
          }
        }, { databaseName: 'files.sqlite' });
      } catch { /* Файл ещё публикуется; следующая свежая страница повторит чтение. */ }
    }
    for (const message of page.messages ?? []) {
      message.attachmentState = message.attachments.length ? 'ready' : ['photo','voice','audio','video','animation','document','sticker'].includes(message.messageType) ? 'pending' : 'none';
      delete message.chat; delete message.thread;
    }
    while (Buffer.byteLength(JSON.stringify(page)) > 895000 && page.messages?.length > 1) {
      if (page._changes) page.messages.pop(); else page.messages.shift();
      page.nextCursor = page._changes ? 'changes:' + page.messages.at(-1)._seq : 'before:' + page.messages[0].id;
      if (page._changes) page.updatesCursor = page.nextCursor;
    }
    delete page._changes;
    for (const message of page.messages ?? []) delete message._seq;
    if (Buffer.byteLength(JSON.stringify(page)) > 900000) throw new Error('PAYLOAD_TOO_LARGE');
    return page;
  };
}
