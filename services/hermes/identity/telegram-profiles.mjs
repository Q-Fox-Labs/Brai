// ABOUTME: Сохраняет имя, username и маленькую фотографию Telegram один раз на аккаунт.
// ABOUTME: Байты доступны только через проверенный административный API; токен не выходит из control.
import { openSync, closeSync, lstatSync, constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const validId = id => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id);
const maxPhoto = 24 * 1024;
export function createTelegramProfiles({ path, info, download, requireRoot = true }) {
  const pending = new Map();
  const db = () => {
    if (!isAbsolute(path)) throw new Error('INVALID_PROFILE_CACHE');
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || (requireRoot && stat.uid !== 0) || (stat.mode & 0o022) && !(stat.mode & 0o1000)) throw new Error('INVALID_PROFILE_CACHE');
      if (dir === '/') break;
    }
    let fd;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (requireRoot && stat.uid !== 0) || (stat.mode & 0o077)) throw new Error('INVALID_PROFILE_CACHE');
    const connection = new DatabaseSync(path);
    connection.exec('CREATE TABLE IF NOT EXISTS telegram_profiles(id TEXT PRIMARY KEY, data TEXT NOT NULL, retry_at INTEGER NOT NULL)');
    return connection;
  };
  const cached = id => {
    const connection = db();
    try { return connection.prepare('SELECT data,retry_at FROM telegram_profiles WHERE id=?').get(id); }
    finally { connection.close(); }
  };
  const save = (id, value, retry) => {
    const connection = db();
    try { connection.prepare('INSERT OR REPLACE INTO telegram_profiles VALUES(?,?,?)').run(id, JSON.stringify(value), retry); }
    finally { connection.close(); }
  };
  const fetchProfile = async id => {
    let old;
    try {
      old = cached(id);
      if (old && (old.retry_at === 0 || old.retry_at > Date.now())) return JSON.parse(old.data);
      const value = await info('getChat', id);
      if (String(value?.id) !== id || value.type !== 'private') throw new Error('INVALID_PROFILE');
      const clean = part => typeof part === 'string' ? part.slice(0, 256) : '';
      const profile = { telegramId: id, name: clean([value.first_name, value.last_name].filter(x => typeof x === 'string').join(' ')),
        username: /^[A-Za-z0-9_]{1,32}$/.test(value.username ?? '') ? value.username : null, avatar: null };
      let retry = 0;
      if (value.photo?.small_file_id) {
        try {
          const bytes = await download(value.photo.small_file_id, maxPhoto);
          if (!Buffer.isBuffer(bytes) || bytes.length > maxPhoto || bytes.length < 3 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error('INVALID_PHOTO');
          profile.avatar = 'data:image/jpeg;base64,' + bytes.toString('base64');
        } catch { retry = Date.now() + 3600000; }
      }
      save(id, profile, retry);
      return profile;
    } catch {
      const value = old ? JSON.parse(old.data) : { telegramId: id, name: '', username: null, avatar: null };
      try { save(id, value, Date.now() + 3600000); } catch { /* Доступ к Telegram не зависит от доступности кэша. */ }
      return value;
    }
  };
  return {
    get(id) {
      if (!validId(id)) return Promise.resolve(null);
      if (!pending.has(id)) pending.set(id, fetchProfile(id).finally(() => pending.delete(id)));
      return pending.get(id);
    },
  };
}
/** Скачать только маленький JPEG Telegram с ограничением на фактически прочитанные байты. */
export function telegramPhotoDownload(token, request = fetch) {
  return async (fileId, maxBytes = maxPhoto) => {
    const signal = AbortSignal.timeout(4000);
    const response = await request(`https://api.telegram.org/bot${token}/getFile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file_id: fileId }), signal, redirect: 'error' });
    const file = await response.json();
    const path = file?.result?.file_path;
    if (!response.ok || file.ok !== true || typeof path !== 'string' || !/^[A-Za-z0-9_/-]+\.(?:jpg|jpeg)$/i.test(path) || path.split('/').includes('..') || file.result.file_size > maxBytes) throw new Error('PHOTO_UNAVAILABLE');
    const image = await request(`https://api.telegram.org/file/bot${token}/${path}`, { signal, redirect: 'error' });
    if (!image.ok || !image.body || Number(image.headers.get('content-length')) > maxBytes) throw new Error('PHOTO_UNAVAILABLE');
    const reader = image.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > maxBytes) throw new Error('PHOTO_TOO_LARGE');
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, size);
    } finally { await reader.cancel(); }
  };
}
