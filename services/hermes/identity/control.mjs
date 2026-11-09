// ABOUTME: Проверяет административный доступ и доставляет код владельцу.
// ABOUTME: Источники данных и транспорт предоставляются доверенной сборкой.
import { openSync, closeSync, fstatSync, lstatSync, readFileSync, constants, mkdtempSync, copyFileSync, rmSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { once } from 'node:events';

const operations = {
  'admin-memory-list': ['memory.list', 'memoryRead'], 'admin-memory-get': ['memory.read', 'memoryRead'],
  'admin-chats-list': ['chats.list', 'chatRead'], 'admin-chats-get': ['chats.read', 'chatRead'],
  'admin-artifacts-list': ['artifacts.list', 'artifactsCall'], 'admin-artifacts-get': ['artifacts.read', 'artifactsCall'],
  'admin-artifacts-download': ['artifacts.read', 'artifactsCall'],
};
/** Реальные NATS subjects административного API. */
export const controlSubjects = Object.freeze(Object.fromEntries(Object.keys(operations).map(name => [name, `brai.hermes.identity.v1.${name}`])));
const quarantineTarget = '__quarantine__';
function quarantineProfile(value, artifactOwner) {
  const fields = ['userId', 'profileId', 'homeScope', 'memoryEpoch', 'cubes', 'home', 'workerUid', 'authorId'];
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key)) ||
      ['userId', 'profileId', 'homeScope', 'memoryEpoch', 'home'].some(key => !text(value[key])) ||
      !isAbsolute(value.home) || !Number.isSafeInteger(value.workerUid) || value.workerUid <= 0 ||
      !Array.isArray(value.cubes) || !value.cubes.length || value.cubes.some(cube => !text(cube)) ||
      new Set(value.cubes).size !== value.cubes.length ||
      (value.authorId !== undefined && !text(value.authorId)) ||
      (artifactOwner !== undefined && !text(artifactOwner))) throw new Error('INVALID_QUARANTINE_CONFIG');
  return value;
}
const error = (status, code) => ({ status, body: { error: code }, setCookies: [] });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const adminTools = new Set(['local_ai_models_install', 'local_ai_models_configure', 'local_ai_models_load', 'local_ai_models_unload', 'local_ai_models_remove', 'local_ai_cancel', 'transcription_settings_set']);
const permittedTool = (tool, role) => object(tool) && text(tool.name) && !['publish_file','fetch_file'].includes(tool.name) && (!adminTools.has(tool.name) || role === 'admin');

/** Политика control с явно переданными доверенными портами. */
export class Control {
  constructor({ origin, cursorKey, registry, authCall, memoryRead, chatRead, artifactsCall, telegramSend, telegramInfo, toolCatalog, perUserRuntime, historyCall, quarantineProfile: archiveProfile, quarantineArtifactsOwnerId }) {
    if (!text(origin) || new URL(origin).origin !== origin || !text(cursorKey) || Buffer.byteLength(cursorKey) < 32 || typeof registry !== 'function' || typeof authCall !== 'function') throw new TypeError('Invalid control configuration');
    Object.assign(this, { origin, cursorKey, registry, authCall, memoryRead, chatRead, artifactsCall, telegramSend, telegramInfo, toolCatalog, perUserRuntime, historyCall, archiveProfile, quarantineArtifactsOwnerId });
    this.memorySnapshots = new Map();
    this.memoryReads = 0;
  }

  /** Подписать cursor вместе с владельцем и параметрами запроса. */
  encodeCursor(binding, cursor) {
    const data = Buffer.from(JSON.stringify({ binding, cursor })).toString('base64url');
    const mac = createHmac('sha256', this.cursorKey).update(data).digest('base64url');
    return `${data}.${mac}`;
  }

  /** Проверить подпись и область cursor. */
  decodeCursor(binding, token) {
    if (!text(token)) throw new Error('Invalid cursor');
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error('Invalid cursor');
    const expected = createHmac('sha256', this.cursorKey).update(parts[0]).digest();
    const supplied = Buffer.from(parts[1], 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Invalid cursor');
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (JSON.stringify(value.binding) !== JSON.stringify(binding) || !text(value.cursor)) throw new Error('Invalid cursor');
    return value.cursor;
  }

  /** Проверить сессию и записать аудит до чтения данных владельца. */
  async invoke(operation, input) {
    const entry = operations[operation];
    if (!entry || !object(input) || !object(input.headers) || !text(input.userId)) return error(400, 'INVALID_ARGUMENT');
    const idKey = operation.endsWith('-get') || operation === 'admin-artifacts-download' ? operation.includes('memory') ? 'memoryId' : operation.includes('chats') ? 'chatId' : 'artifactId' : null;
    const allowed = new Set(['headers', 'userId', 'cursor', 'limit', ...(operation === 'admin-chats-get' ? ['order'] : []), ...(operation === 'admin-memory-list' ? ['query'] : []), ...(idKey ? [idKey] : [])]);
    if (input.order !== undefined && !['asc', 'desc'].includes(input.order)) return error(400, 'INVALID_ARGUMENT');
    if (Object.keys(input).some(k => !allowed.has(k)) || Object.keys(input.headers).some(k => !['cookie', 'origin'].includes(k)) || input.headers.origin !== this.origin || !text(input.headers.cookie)) return error(403, 'FORBIDDEN');
    if ((idKey && !text(input[idKey])) || (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 4096)) || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100))) return error(400, 'INVALID_ARGUMENT');
    try {
      const session = await this.authCall('session', { headers: input.headers, body: {} });
      if (session?.status !== 200 || !session.body?.session || session.body?.user?.role !== 'admin' || session.body.user.status !== 'active') return error(403, 'FORBIDDEN');
      const audit = await this.authCall('admin-audit', { headers: input.headers, body: { userId: input.userId, action: entry[0] } });
      if (audit?.status !== 200) return error(audit?.status === 403 ? 403 : 503, audit?.status === 403 ? 'FORBIDDEN' : 'AUTH_UNAVAILABLE');
      let selected;
      if (input.userId === quarantineTarget) {
        if (!this.archiveProfile) return error(503, 'SOURCE_UNAVAILABLE');
        const archive = quarantineProfile(this.archiveProfile, this.quarantineArtifactsOwnerId);
        selected = { ...archive, userId: entry[1] === 'artifactsCall' ? this.quarantineArtifactsOwnerId ?? archive.userId : archive.userId };
      } else {
        const registry = await this.registry();
        if (registry?.version !== 1 || !object(registry.profiles)) return error(503, 'REGISTRY_UNAVAILABLE');
        const profiles = Object.entries(registry.profiles).filter(([uid, p]) => /^[1-9]\d*$/.test(uid) && p?.userId === input.userId && ['active', 'blocked', 'disabled', 'provisioning'].includes(p.status));
        if (profiles.length !== 1) return error(404, 'NOT_FOUND');
        selected = { ...profiles[0][1], workerUid: Number(profiles[0][0]) };
      }
      const port = this[entry[1]];
      if (typeof port !== 'function') return error(503, 'SOURCE_UNAVAILABLE');
      const binding = { operation, userId: input.userId, id: idKey ? input[idKey] : null, query: input.query ?? null, limit: input.limit ?? 50, ...(operation === 'admin-chats-get' ? { order: input.order ?? 'asc' } : {}) };
      if (operation === 'admin-memory-get') {
        if (!text(session.body.user.id) || !text(selected.profileId) || !text(selected.memoryEpoch)) return error(503, 'SOURCE_UNAVAILABLE');
        binding.actor = session.body.user.id;
        binding.session = createHmac('sha256', this.cursorKey).update(input.headers.cookie).digest('hex');
        binding.profileId = selected.profileId;
        binding.memoryEpoch = selected.memoryEpoch;
      }
      let cursor;
      try { cursor = input.cursor === undefined ? undefined : this.decodeCursor(binding, input.cursor); } catch { return error(400, 'INVALID_CURSOR'); }
      const result = operation === 'admin-memory-get'
        ? await this.memoryDetail({ port, selected, input, binding, cursor })
        : await port({ operation, profile: selected, id: idKey ? input[idKey] : undefined, query: input.query, cursor, limit: input.limit ?? 50, order: input.order ?? 'asc' });
      if (!object(result)) return error(503, 'SOURCE_UNAVAILABLE');
      const body = { ...result };
      if ('nextCursor' in body && body.nextCursor !== null) {
        if (!text(body.nextCursor)) return error(503, 'SOURCE_UNAVAILABLE');
        body.nextCursor = this.encodeCursor(binding, body.nextCursor);
      }
      return { status: 200, body, setCookies: [] };
    } catch (err) { return err?.code === 'PAYLOAD_TOO_LARGE' ? error(413, 'PAYLOAD_TOO_LARGE') : error(503, 'SOURCE_UNAVAILABLE'); }
  }

  /** Удалить временные снимки при остановке управляющего процесса. */
  closeMemorySnapshots() {
    for (const item of this.memorySnapshots.values()) clearTimeout(item.timer);
    this.memorySnapshots.clear();
  }

  /** Вернуть последовательную часть неизменяемой записи только тому же администратору и сессии. */
  async memoryDetail({ port, selected, input, binding, cursor }) {
    const now = Date.now(), maxBytes = 16 * 1024 * 1024, chunkBytes = 450000;
    const remove = key => {
      const item = this.memorySnapshots.get(key);
      if (!item) return;
      clearTimeout(item.timer);
      this.memorySnapshots.delete(key);
    };
    for (const [key, item] of this.memorySnapshots) if (item.expires <= now) remove(key);
    let snapshot, key, offset = 0;
    if (cursor !== undefined) {
      const match = /^([0-9a-f-]{36}):(0|[1-9]\d*)$/.exec(cursor);
      if (!match || !(snapshot = this.memorySnapshots.get(match[1])) || snapshot.binding !== JSON.stringify(binding)) throw new Error('SOURCE_UNAVAILABLE');
      key = match[1]; offset = Number(match[2]);
      if (!Number.isSafeInteger(offset) || offset !== snapshot.next) throw new Error('SOURCE_UNAVAILABLE');
    } else {
      if (this.memorySnapshots.size >= 8 || this.memoryReads >= 4) throw new Error('SOURCE_UNAVAILABLE');
      let record;
      this.memoryReads++;
      try { record = await port({ operation: 'admin-memory-get', profile: selected, id: input.memoryId }); }
      finally { this.memoryReads--; }
      if (!object(record) || record.id !== input.memoryId || record.profileId !== selected.profileId) throw new Error('SOURCE_UNAVAILABLE');
      const bytes = Buffer.from(JSON.stringify(record), 'utf8');
      if (bytes.length > maxBytes) throw Object.assign(new Error('PAYLOAD_TOO_LARGE'), { code: 'PAYLOAD_TOO_LARGE' });
      if (this.memorySnapshots.size >= 8) throw new Error('SOURCE_UNAVAILABLE');
      let total = bytes.length;
      for (const item of this.memorySnapshots.values()) total += item.bytes.length;
      if (total > 64 * 1024 * 1024) throw new Error('SOURCE_UNAVAILABLE');
      key = randomUUID();
      snapshot = { bytes, binding: JSON.stringify(binding), hash: createHash('sha256').update(bytes).digest('hex'), expires: now + 120000, next: 0 };
      snapshot.timer = setTimeout(() => remove(key), 120000); snapshot.timer.unref();
      this.memorySnapshots.set(key, snapshot);
    }
    const end = Math.min(offset + chunkBytes, snapshot.bytes.length), more = end < snapshot.bytes.length;
    const result = { userId: input.userId, memoryId: input.memoryId, snapshotId: key, offset, totalBytes: snapshot.bytes.length,
      sha256: snapshot.hash, chunkBase64: snapshot.bytes.subarray(offset, end).toString('base64'),
      nextCursor: more ? `${key}:${end}` : null };
    snapshot.next = end;
    if (!more) remove(key);
    return result;
  }

  /** Запустить инструмент каталога в области актуального владельца UID. */
  async invokeTool(uid, name, args, signal) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !text(name) || !object(args)) throw new Error('INVALID_ARGUMENT');
    if (['userId', 'user_id', 'ownerId', 'owner_id', 'profileId', 'principal', 'permissions'].some(key => Object.hasOwn(args, key))) throw new Error('INVALID_ARGUMENT');
    const registry = await this.registry();
    const profile = registry?.version === 1 && registry.profiles?.[String(uid)];
    if (!profile || profile.status !== 'active' || !text(profile.userId) || !text(profile.profileId) || !/^\d+$/.test(String(profile.telegramId))) throw new Error('FORBIDDEN');
    const resolved = await this.authCall('identity-get', { userId: profile.userId });
    const user = resolved?.user;
    if (!user || user.id !== profile.userId || user.profileId !== profile.profileId || user.status !== 'active' || String(user.telegramId) !== String(profile.telegramId)) throw new Error('FORBIDDEN');
    signal?.throwIfAborted();
    if (typeof this.perUserRuntime !== 'function') throw new Error('SOURCE_UNAVAILABLE');
    const runtime = await this.perUserRuntime({ ...profile, workerUid: uid, role: user.role });
    if (typeof runtime?.callTool !== 'function' || typeof runtime?.listTools !== 'function') throw new Error('SOURCE_UNAVAILABLE');
    const catalog = await runtime.listTools();
    if (!Array.isArray(catalog) || !catalog.some(tool => tool.name === name && permittedTool(tool, user.role))) throw new Error('FORBIDDEN');
    if (name.startsWith('history_')) {
      if (typeof this.historyCall !== 'function') throw new Error('SOURCE_UNAVAILABLE');
      return this.historyCall({ ...profile, workerUid: uid, role: user.role }, name, args, signal);
    }
    return runtime.callTool(name, args, signal);
  }

  /** Проверить текущие аккаунты владельца по Auth, не по автору памяти. */
  async accountIdentity(uid, telegramId) {
    const data = await this.registry(), profile = data?.version === 1 && data.profiles?.[String(uid)];
    const resolved = await this.authCall('telegram-resolve', { telegramId }), user = resolved?.user;
    if (!profile || profile.status !== 'active' || user?.status !== 'active' ||
        user.id !== profile.userId || user.profileId !== profile.profileId) return null;
    const identity = await this.authCall('identity-get', { userId: profile.userId });
    const ids = identity?.telegramIds;
    if (identity?.user?.status !== 'active' || identity.user.id !== user.id || identity.user.profileId !== profile.profileId ||
        !Array.isArray(ids) || ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length ||
        ids.some(id => !/^[1-9][0-9]{0,19}$/.test(id)) || !ids.includes(telegramId)) return null;
    return { user, ids };
  }

  /** Прочитать имена только уже проверенных аккаунтов; ошибки метаданных не меняют доступ. */
  async accountNames(ids) {
    return Promise.all(ids.map(async id => {
      try {
        const value = await this.telegramInfo('getChat', id);
        if (String(value?.id) !== id || value.type !== 'private') throw new Error('INVALID_ACCOUNT');
        const clean = value => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 128) : '';
        const name = clean([value.first_name, value.last_name].filter(part => typeof part === 'string').join(' '));
        return { name: name || null, username: /^[A-Za-z0-9_]{1,32}$/.test(value.username ?? '') ? value.username : null };
      } catch { return { name: null, username: null }; }
    }));
  }

  /** Получить публичную ссылку именно на текущего бота. */
  async botURL() {
    const value = await this.telegramInfo('getMe');
    if (value?.is_bot !== true || !/^[A-Za-z0-9_]{1,32}$/.test(value.username ?? '')) throw new Error('BOT_UNAVAILABLE');
    return 'https://t.me/' + value.username;
  }

  /** Подготовить сведения для вопроса агента либо отправить его вступление и отдельную команду. */
  async sendAccountLink({ uid, telegramId, phase, threadId, message }) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !/^[1-9][0-9]{0,19}$/.test(telegramId ?? '') ||
        !['offer','command'].includes(phase) || typeof this.telegramSend !== 'function' ||
        threadId !== undefined && (!Number.isSafeInteger(threadId) || threadId <= 0)) return { status: 'denied' };
    try {
      const identity = await this.accountIdentity(uid, telegramId);
      if (!identity) return { status: 'denied' };
      if (phase === 'offer') {
        const accounts = await this.accountNames(identity.ids);
        if (identity.ids.length >= 2) return { status: 'limit_reached', accounts };
        return { status: 'needs_consent', botUrl: await this.botURL(), accounts };
      }
      if (typeof message !== 'string' || !message.trim() || message.length > 2000 || /(?:https?:|t\.me\/|@[A-Za-z0-9_]|\/start\b)/i.test(message)) return { status: 'needs_instruction' };
      const route = { telegramId, ...(threadId === undefined ? {} : { threadId }) };
      const intro = await this.telegramSend({ ...route, message: message + '\n' + await this.botURL() });
      if (intro?.ok !== true) return { status: intro?.ok === false ? 'failed' : 'unknown' };
      // AIDEV-NOTE: При неизвестной доставке вступления секрет ещё не выпускается.
      const issued = await this.authCall('telegram-link-issue', { telegramId });
      if (!/^[A-Za-z0-9_-]{43}$/.test(issued?.code ?? '')) return { status: 'unavailable' };
      const command = '/start link_' + issued.code;
      const receipt = await this.telegramSend({ ...route, message: command,
        entities: [{ type: 'pre', offset: 0, length: command.length }],
        replyMarkup: { inline_keyboard: [[{ text: 'Скопировать', copy_text: { text: command } }]] } });
      return { status: receipt?.ok === true ? 'sent' : receipt?.ok === false ? 'failed' : 'unknown' };
    } catch { return { status: 'unknown' }; }
  }

  /** Погасить команду до модели и отдельно прочитать имена актуальных связанных аккаунтов. */
  async redeemAccountLink(params) {
    const linked = await this.authCall('telegram-link-redeem', params);
    if (!linked?.user) return { user: null, accounts: [] };
    try {
      const current = await this.authCall('identity-get', { userId: linked.user.id });
      const ids = current?.telegramIds;
      if (current?.user?.status !== 'active' || current.user.id !== linked.user.id || current.user.profileId !== linked.user.profileId ||
          !Array.isArray(ids) || ids.length > 2 || new Set(ids).size !== ids.length || !ids.includes(params.telegramId) ||
          ids.some(id => !/^[1-9][0-9]{0,19}$/.test(id))) return { user: null, accounts: [] };
      return { user: current.user, accounts: await this.accountNames(ids) };
    } catch {
      // Успешную привязку нельзя повторять из-за временного отказа чтения имени.
      return { user: linked.user, accounts: [] };
    }
  }

  /** Подготовить цель для вопроса агента либо выполнить подтверждённую отвязку. */
  async sendAccountUnlink({ uid, telegramId, phase, target, targetTelegramId, threadId }) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !/^[1-9][0-9]{0,19}$/.test(telegramId ?? '') ||
        !['offer','confirm'].includes(phase) || !['current','other'].includes(target) || typeof this.telegramSend !== 'function' ||
        threadId !== undefined && (!Number.isSafeInteger(threadId) || threadId <= 0) ||
        phase === 'confirm' && !/^[1-9][0-9]{0,19}$/.test(targetTelegramId ?? '')) return { status: 'denied' };
    try {
      const identity = await this.accountIdentity(uid, telegramId);
      if (!identity) return { status: 'denied' };
      const selected = phase === 'offer' ? (target === 'current' ? telegramId : identity.ids.find(id => id !== telegramId)) : targetTelegramId;
      if (!selected || !identity.ids.includes(selected) || (target === 'current') !== (selected === telegramId)) return { status: 'denied', reason: 'account-unavailable' };
      if (identity.user.role === 'admin' && identity.ids.length <= 1) return { status: 'denied', reason: 'admin-last-channel' };
      const [account] = await this.accountNames([selected]);
      if (phase === 'offer') return { status: 'needs_consent', targetTelegramId: selected, account, lastChannel: identity.ids.length === 1 };
      const result = await this.authCall('telegram-unlink', { telegramId, targetTelegramId: selected });
      if (result?.unlinked !== true) return { status: 'denied', reason: 'account-unavailable' };
      const label = (account.name ?? 'Имя аккаунта недоступно') + (account.username ? ' (@' + account.username + ')' : '');
      const message = 'Аккаунт ' + label + ' отключён. Память, файлы и другие данные сохранены.' +
        (identity.ids.length === 1 ? ' Подключённых Telegram-аккаунтов больше нет.' : ' Вы можете продолжить общение с другого подключённого аккаунта.');
      const receipt = await this.telegramSend({ telegramId, message, ...(threadId === undefined ? {} : { threadId }) });
      return { status: receipt?.ok === true ? 'sent' : receipt?.ok === false ? 'failed' : 'unknown', targetTelegramId: selected };
    } catch { return { status: 'unknown' }; }
  }

  /** Выдать код для UID и личного события, проверенных доверенным ingress. */
  async sendLogin({ uid, telegramId, privateChat, requestId, threadId }) {
    if (!Number.isSafeInteger(uid) || uid <= 0 || !/^\d+$/.test(String(telegramId)) || privateChat !== true || !text(requestId) || typeof this.telegramSend !== 'function') return { status: 'denied' };
    if (threadId !== undefined && (!Number.isSafeInteger(threadId) || threadId <= 0)) return { status: 'denied' };
    try {
      const registry = await this.registry();
      const profile = registry?.version === 1 && registry.profiles?.[String(uid)];
      if (!profile || profile.status !== 'active' || !text(profile.userId) || !text(profile.profileId)) return { status: 'denied' };
      const resolved = await this.authCall('telegram-resolve', { telegramId: String(telegramId) });
      const user = resolved?.user;
      if (!user || user.id !== profile.userId || user.profileId !== profile.profileId || user.status !== 'active' || String(user.telegramId) !== String(profile.telegramId)) return { status: 'denied' };
      const issued = await this.authCall('telegram-code-issue', { telegramId: String(telegramId), requestId });
      if (!/^[0-9A-HJKMNP-TV-Z]{12}$/.test(issued?.code ?? '') || issued.origin !== this.origin || !issued.expiresAt) return { status: 'unavailable' };
      const message = `Для входа откройте ${this.origin} и введите код: ${issued.code}. Код действует 120 секунд.`;
      const receipt = await this.telegramSend({ telegramId: String(telegramId), message, ...(threadId === undefined ? {} : { threadId }) });
      return { status: receipt?.ok === true ? 'sent' : receipt?.ok === false ? 'failed' : 'unknown' };
    } catch { return { status: 'unknown' }; }
  }
}

/** Скопировать подтверждённые inode профиля вместе с WAL в закрытый каталог. */
export function snapshotSessionDB(profile, useCopy, { afterCopy, retainCopy = false } = {}) {
  const { home, workerUid } = profile;
  if (!isAbsolute(home) || !Number.isSafeInteger(workerUid) || workerUid <= 0 || home.split('/').some(part => part === '..' || part === '.')) throw new Error('SOURCE_UNAVAILABLE');
  const fds = [], chain = []; let temporary, retained = false;
  try {
    let dir = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); fds.push(dir);
    for (const part of home.split('/').filter(Boolean)) {
      const parent = dir, path = `/proc/self/fd/${parent}/${part}`;
      dir = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); fds.push(dir);
      const stat = fstatSync(dir);
      if (stat.uid !== 0 && stat.uid !== workerUid) throw new Error('SOURCE_UNAVAILABLE');
      chain.push({ path, stat });
    }
    const files = [];
    for (const name of ['state.db', 'state.db-wal']) {
      const path = `/proc/self/fd/${dir}/${name}`;
      let fd;
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (err) { if (name.endsWith('-wal') && err.code === 'ENOENT') { files.push({ path, missing: true }); continue; } throw err; }
      fds.push(fd);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== workerUid) throw new Error('SOURCE_UNAVAILABLE');
      files.push({ path, fd, stat, name });
    }
    const space = statfsSync(tmpdir());
    const totalBytes = files.reduce((sum, file) => sum + (file.stat?.size ?? 0), 0);
    if (!Number.isSafeInteger(totalBytes) || space.bavail * space.bsize - totalBytes < 512 * 1024 * 1024) throw new Error('SOURCE_UNAVAILABLE');
    temporary = mkdtempSync(join(tmpdir(), 'brai-chat-'));
    for (const file of files) if (!file.missing) copyFileSync(`/proc/self/fd/${file.fd}`, join(temporary, file.name));
    afterCopy?.();
    const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    for (const item of chain) { const stat = lstatSync(item.path); if (item.stat.dev !== stat.dev || item.stat.ino !== stat.ino) throw new Error('SOURCE_UNAVAILABLE'); }
    for (const file of files) {
      if (file.missing) { try { lstatSync(file.path); throw new Error('SOURCE_UNAVAILABLE'); } catch (err) { if (err.code !== 'ENOENT') throw err; } }
      else if (!same(file.stat, fstatSync(file.fd)) || !same(file.stat, lstatSync(file.path))) throw new Error('SOURCE_UNAVAILABLE');
    }
    const db = new DatabaseSync(join(temporary, 'state.db'), { readOnly: true });
    let value;
    try { value = useCopy(db, temporary); } finally { db.close(); }
    retained = retainCopy;
    return value;
  } finally {
    for (const fd of fds.reverse()) closeSync(fd);
    if (temporary && !retained) rmSync(temporary, { recursive: true, force: true });
  }
}

/** Читает последние сообщения; cursor по ID переживает новые записи и не удерживает копию БД между опросами. */
function recentChatPage(profile, id, cursor, limit) {
  if (cursor !== undefined && !/^before:[1-9][0-9]*$/.test(cursor)) throw new Error('INVALID_CURSOR');
  return snapshotSessionDB(profile, db => {
    if (!db.prepare("SELECT id FROM sessions WHERE id=? AND source='telegram'").get(id)) throw new Error('SOURCE_UNAVAILABLE');
    const before = cursor?.slice(7) ?? null;
    const rows = db.prepare("SELECT id,role,CASE WHEN length(CAST(content AS BLOB)) <= 900000 THEN content END AS content,timestamp FROM messages WHERE session_id=? AND role IN ('user','assistant') AND content IS NOT NULL AND (? IS NULL OR id < CAST(? AS INTEGER)) ORDER BY id DESC LIMIT ?").iterate(id, before, before, limit + 1);
    const messages = []; let size = 0, more = false;
    for (const row of rows) {
      if (messages.length === limit) { more = true; break; }
      if (row.content === null) throw new Error('SOURCE_UNAVAILABLE');
      const item = { id: String(row.id), role: row.role, text: row.content, createdAt: new Date(row.timestamp * 1000).toISOString() };
      const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (size + bytes > 900000) { if (!messages.length) throw new Error('SOURCE_UNAVAILABLE'); more = true; break; }
      size += bytes; messages.push(item);
    }
    const nextCursor = more ? `before:${messages.at(-1).id}` : null;
    return { messages: messages.reverse(), nextCursor };
  });
}

/** Хранить закрытую копию SQLite и читать из неё только одну страницу. */
export function createChatRead() {
  const snapshots = new Map();
  function dispose(key) {
    const snapshot = snapshots.get(key);
    if (!snapshot) return;
    snapshots.delete(key);
    clearTimeout(snapshot.timer);
    rmSync(snapshot.directory, { recursive: true, force: true });
  }
  return async ({ operation, profile, id, cursor, limit, order = 'asc' }) => {
    if (operation === 'admin-chats-get' && order === 'desc') return recentChatPage(profile, id, cursor, limit);
    const now = Date.now();
    for (const [key, value] of snapshots) if (value.expires <= now) dispose(key);
    let snapshot, offset = 0, key;
    if (cursor) {
      const match = /^([0-9a-f-]{36}):(\d+)$/.exec(cursor);
      if (!match || !(snapshot = snapshots.get(match[1])) || snapshot.owner !== profile.userId || snapshot.operation !== operation || snapshot.id !== id) throw new Error('SOURCE_UNAVAILABLE');
      key = match[1]; offset = Number(match[2]);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('SOURCE_UNAVAILABLE');
    } else {
      if (snapshots.size >= 20) throw new Error('SOURCE_UNAVAILABLE');
      const directory = snapshotSessionDB(profile, (db, directory) => {
        if (operation === 'admin-chats-list') db.prepare("SELECT id,title,last_activity_at,started_at FROM sessions LIMIT 0").all();
        else {
          db.prepare("SELECT id,session_id,role,content,timestamp FROM messages LIMIT 0").all();
          if (!db.prepare("SELECT id FROM sessions WHERE id=? AND source='telegram'").get(id)) throw new Error('SOURCE_UNAVAILABLE');
        }
        return directory;
      }, { retainCopy: true });
      key = randomUUID();
      snapshot = { owner: profile.userId, operation, id, directory, expires: now + 300000 };
      snapshot.timer = setTimeout(() => dispose(key), 300000);
      snapshot.timer.unref();
      snapshots.set(key, snapshot);
    }
    try {
      const db = new DatabaseSync(join(snapshot.directory, 'state.db'), { readOnly: true });
      let finished = false;
      try {
        const date = value => new Date(value * 1000).toISOString();
        const rows = operation === 'admin-chats-list'
          ? db.prepare("SELECT id,title,COALESCE(last_activity_at,started_at) AS updated FROM sessions WHERE source='telegram' ORDER BY id LIMIT ? OFFSET ?").iterate(limit + 1, offset)
          : db.prepare("SELECT id,role,CASE WHEN length(CAST(content AS BLOB)) <= 900000 THEN content END AS content,timestamp FROM messages WHERE session_id=? AND role IN ('user','assistant') AND content IS NOT NULL ORDER BY id LIMIT ? OFFSET ?").iterate(id, limit + 1, offset);
        const items = []; let size = 0, more = false;
        for (const row of rows) {
          if (items.length === limit) { more = true; break; }
          if (operation !== 'admin-chats-list' && row.content === null) throw new Error('SOURCE_UNAVAILABLE');
          const item = operation === 'admin-chats-list'
            ? { id: row.id, title: row.title ?? '', updatedAt: date(row.updated) }
            : { id: String(row.id), role: row.role, text: row.content, createdAt: date(row.timestamp) };
          const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
          if (size + bytes > 900000) { if (!items.length) throw new Error('SOURCE_UNAVAILABLE'); more = true; break; }
          size += bytes; items.push(item);
        }
        if (cursor && !items.length) throw new Error('SOURCE_UNAVAILABLE');
        const next = offset + items.length;
        finished = !more;
        return { [operation === 'admin-chats-list' ? 'items' : 'messages']: items, nextCursor: more ? `${key}:${next}` : null };
      } finally { db.close(); if (finished) dispose(key); }
    } catch (err) { dispose(key); throw err; }
  };
}

/** Прочитать root-owned файл вместе с проверкой защищённости каталогов. */
export function readProtectedJSON(path) {
  if (!isAbsolute(path)) throw new Error('Invalid protected path');
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Unprotected directory');
    if (dir === '/') break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) || stat.size > 1048576) throw new Error('Unprotected file');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

/** Подготовить descriptor для серверной потоковой выдачи без передачи внутреннего URL. */
export function artifactDownloadDescriptor(artifact, internalBaseURL) {
  const id = artifact?.artifactId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id ?? '') || artifact.status !== 'ready' || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0 || !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? '') || !text(artifact.mimeType) || !text(artifact.filename)) throw new Error('SOURCE_UNAVAILABLE');
  if (artifact.sizeBytes > 2147483648) throw Object.assign(new Error('PAYLOAD_TOO_LARGE'), { code: 'PAYLOAD_TOO_LARGE' });
  const base = new URL(internalBaseURL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('SOURCE_UNAVAILABLE');
  const expected = base.href.replace(/\/$/, '') + '/files/' + id;
  if (artifact.internalUrl !== expected) throw new Error('SOURCE_UNAVAILABLE');
  return { artifactId: id, mimeType: artifact.mimeType, filename: artifact.filename, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 };
}

/** Чтение страницы owner API без накопления всей коллекции. */
export function createArtifactReader({ wire, internalBaseURL }) {
  const publicArtifact = artifact => {
    if (!object(artifact)) throw new Error('SOURCE_UNAVAILABLE');
    const { internalUrl, ...visible } = artifact;
    return visible;
  };
  return async ({ operation, profile, id, cursor, limit }) => {
    if (operation === 'admin-artifacts-get' || operation === 'admin-artifacts-download') {
      const artifact = await wire('brai.artifacts.v1.get', { artifactId: id });
      if (artifact.ownerId !== profile.userId || artifact.artifactId !== id) throw new Error('SOURCE_UNAVAILABLE');
      if (operation === 'admin-artifacts-download') return artifactDownloadDescriptor(artifact, internalBaseURL);
      return publicArtifact(artifact);
    }
    let offset = 0;
    if (cursor !== undefined) {
      const match = /^offset:(0|[1-9]\d*)$/.exec(cursor);
      if (!match || !Number.isSafeInteger(offset = Number(match[1]))) throw new Error('SOURCE_UNAVAILABLE');
    }
    const page = await wire('brai.artifacts.v1.list', { filter: { ownerId: profile.userId }, sort: 'createdAt', order: 'desc', limit, offset });
    if (!Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0 || page.items.length > limit ||
        page.items.some(item => item.ownerId !== profile.userId) || offset + page.items.length > page.total ||
        (!page.items.length && offset < page.total)) throw new Error('SOURCE_UNAVAILABLE');
    const next = offset + page.items.length;
    return { items: page.items.map(publicArtifact), nextCursor: next < page.total ? `offset:${next}` : null };
  };
}

/** Читать HTTP memory gateway с жёстким пределом и немедленным завершением при обрыве. */
export function createMemoryReader(socketPath) {
  return ({ operation, profile, id, query, cursor, limit }) => new Promise((resolve, reject) => {
    const isList = operation === 'admin-memory-list', maxBytes = isList ? 900000 : 16 * 1024 * 1024;
    const body = isList
      ? { userId: profile.userId, ...(query === undefined ? {} : { query }), ...(cursor === undefined ? {} : { cursor }), limit }
      : { userId: profile.userId, memoryId: id };
    const data = Buffer.from(JSON.stringify(body)), chunks = []; let size = 0, settled = false, response;
    const fail = () => {
      if (settled) return;
      settled = true;
      response?.destroy();
      req.destroy();
      reject(new Error('SOURCE_UNAVAILABLE'));
    };
    const req = request({ socketPath, path: isList ? '/admin/list' : '/admin/read', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 10000 }, res => {
      response = res;
      const declared = res.headers['content-length'];
      if (res.statusCode !== 200 || (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))) { fail(); return; }
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) fail(); else chunks.push(chunk); });
      res.on('aborted', fail); res.on('error', fail);
      res.on('close', () => { if (!res.complete) fail(); });
      res.on('end', () => {
        if (settled) return;
        try {
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
          settled = true; resolve(value);
        } catch { fail(); }
      });
    });
    req.on('error', fail); req.on('timeout', fail); req.end(data);
  });
}

/** Вернуть успех или допустимую ошибку через заголовки NATS Service API. */
export function respondControl(msg, result) {
  const allowed = {
    400: new Set(['INVALID_ARGUMENT', 'INVALID_CURSOR']),
    403: new Set(['FORBIDDEN']),
    404: new Set(['NOT_FOUND']),
    413: new Set(['PAYLOAD_TOO_LARGE']),
    503: new Set(['AUTH_UNAVAILABLE', 'REGISTRY_UNAVAILABLE', 'SOURCE_UNAVAILABLE', 'UNAVAILABLE']),
  };
  if (result?.status === 200) return msg.respond(Buffer.from(JSON.stringify(result)));
  const status = result?.status, code = result?.body?.error;
  if (allowed[status]?.has(code)) return msg.respondError(status, code);
  return msg.respondError(503, 'UNAVAILABLE');
}

/** Собрать NATS, доставку Telegram и закрытый сокет памяти. */
export async function startControl(config, adapters = {}) {
  const { connect, credsAuthenticator } = await import('nats');
  const n = config.nats;
  if (!object(n) || !Array.isArray(n.servers) || !n.servers.length || !text(config.telegramToken) || !text(config.registryPath) || !text(config.memorySocket)) throw new Error('Invalid control configuration');
  const nc = await connect({ servers: n.servers, user: n.user, pass: n.password,
    authenticator: n.credsFile ? credsAuthenticator(readFileSync(n.credsFile)) : undefined,
    tls: n.caFile ? { caFile: n.caFile } : undefined, inboxPrefix: '_INBOX.brai_hermes_identity',
    name: 'brai_hermes_identity', timeout: 5000, maxReconnectAttempts: -1 });
  const wire = async (subject, body) => {
    const msg = await nc.request(subject, Buffer.from(JSON.stringify(body)), { timeout: 10000 });
    if (msg.data.length > 1048576) throw new Error('SOURCE_UNAVAILABLE');
    return JSON.parse(new TextDecoder().decode(msg.data));
  };
  const authCall = (name, body) => wire(`brai.auth.${name === 'session' ? 'v1' : 'v2'}.${name}`, body);
  const registry = () => readProtectedJSON(config.registryPath);
  const memoryRead = createMemoryReader(config.memorySocket);
  const artifactsCall = createArtifactReader({ wire, internalBaseURL: config.artifactsInternalBaseURL });
  const telegramSend = async ({ telegramId, message, threadId, entities, replyMarkup }) => {
    const response = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text: message, ...(threadId === undefined ? {} : { message_thread_id: threadId }), ...(entities === undefined ? {} : { entities }), ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }) }), signal: AbortSignal.timeout(10000),
    });
    if (response.status >= 500 || response.status === 429) return {};
    const value = await response.json();
    return { ok: value?.ok === true ? true : value?.ok === false ? false : undefined };
  };
  const telegramInfo = async (method, telegramId) => {
    if (!['getMe', 'getChat'].includes(method)) throw new Error('INVALID_ARGUMENT');
    const response = await fetch('https://api.telegram.org/bot' + config.telegramToken + '/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(method === 'getChat' ? { chat_id: telegramId } : {}), signal: AbortSignal.timeout(3000),
    });
    const value = await response.json();
    if (value?.ok !== true) throw new Error('TELEGRAM_METADATA_UNAVAILABLE');
    return value.result;
  };
  const control = new Control({ origin: config.origin, cursorKey: config.cursorKey, registry, authCall,
    memoryRead, telegramSend: adapters.telegramSend ?? telegramSend, telegramInfo: adapters.telegramInfo ?? telegramInfo, chatRead: adapters.chatRead ?? createChatRead(), artifactsCall: adapters.artifactsCall ?? artifactsCall,
    toolCatalog: adapters.toolCatalog, perUserRuntime: adapters.perUserRuntime, historyCall: adapters.historyCall,
    quarantineProfile: config.quarantineProfile, quarantineArtifactsOwnerId: config.quarantineArtifactsOwnerId });
  control.onIdentityChanged = adapters.onIdentityChanged;
  control.bootstrapFilesConfiguration = adapters.bootstrapFilesConfiguration;
  const service = await nc.services.add({ name: 'brai_hermes_identity', version: '1.0.0', queue: 'brai_hermes_identity' });
  let pending = 0;
  for (const name of Object.keys(operations)) service.addEndpoint(name.replaceAll('-', '_'), {
    subject: controlSubjects[name], queue: 'brai_hermes_identity',
    handler: (err, msg) => {
      if (err) return;
      if (pending >= 32 || msg.data.length > 32768) { msg.respondError(503, 'UNAVAILABLE'); return; }
      pending++;
      void (async () => {
        try { respondControl(msg, await control.invoke(name, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(msg.data)))); }
        catch { msg.respondError(400, 'INVALID_ARGUMENT'); }
        finally { pending--; }
      })();
    },
  });
  return { control, authCall, registry, async stop() { await service.stop(); control.closeMemorySnapshots(); await nc.drain(); } };
}

/** Приватный протокол доступен только управляющему процессу через его stdin/stdout. */
export async function privateCall(runtime, method, params) {
  if (!object(params)) throw new Error('INVALID_ARGUMENT');
  const { control, authCall, registry } = runtime;
  if (method === 'identity.link-redeem') {
    if (Object.keys(params).some(key=>!['telegramId','code'].includes(key)) ||
        !/^[1-9][0-9]{0,19}$/.test(params.telegramId ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(params.code ?? '')) throw new Error('INVALID_ARGUMENT');
    return control.redeemAccountLink(params);
  }
  if (['identity.lifecycle-claim', 'identity.lifecycle-renew', 'identity.lifecycle-complete'].includes(method)) {
    // AIDEV-NOTE: Эти методы доступны только stdin root broker, не Unix API worker.
    const operation = method.slice('identity.'.length);
    return authCall(operation, params);
  }
  if (method === 'identity.resolve') return authCall('telegram-resolve', { telegramId: params.telegramId });
  if (method === 'identity.invite-redeem') return authCall('invite-redeem', { telegramId: params.telegramId, code: params.code, ...(params.name === undefined ? {} : { name: params.name }) });
  if (method === 'identity.profile-ready') {
    if(Object.keys(params).some(key=>!['userId','profileId'].includes(key))||!text(params.userId)||!text(params.profileId))throw new Error('INVALID_ARGUMENT');
    return authCall('profile-ready',{userId:params.userId,profileId:params.profileId});
  }
  if (method === 'login.send') return control.sendLogin(params);
  if (method === 'telegram.link') {
    if (Object.keys(params).some(key=>!['uid','telegramId','phase','threadId','message'].includes(key))) throw new Error('INVALID_ARGUMENT');
    return control.sendAccountLink(params);
  }
  if (method === 'telegram.unlink') {
    if (Object.keys(params).some(key=>!['uid','telegramId','phase','target','targetTelegramId','threadId'].includes(key))) throw new Error('INVALID_ARGUMENT');
    return control.sendAccountUnlink(params);
  }
  if (method === 'tools.call') return control.invokeTool(params.uid, params.name, params.args);
  if (method === 'tools.list') {
    const user = await privateCall(runtime, 'authorize', { uid: params.uid });
    const data = await registry();
    const profile = data?.profiles?.[String(params.uid)];
    if (!profile || profile.userId !== user.userId || profile.status !== 'active' || typeof control.perUserRuntime !== 'function') throw new Error('FORBIDDEN');
    const ownerRuntime = await control.perUserRuntime({ ...profile, workerUid: params.uid, role: user.role });
    if (typeof ownerRuntime?.listTools !== 'function') throw new Error('SOURCE_UNAVAILABLE');
    const tools = await ownerRuntime.listTools();
    if (!Array.isArray(tools)) throw new Error('SOURCE_UNAVAILABLE');
    return { tools: tools.filter(tool => permittedTool(tool, user.role)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  }
  if(method==='files.configuration'){
    if(Object.keys(params).some(key=>key!=='uid')||!Number.isSafeInteger(params.uid)||params.uid<=0)throw new Error('INVALID_ARGUMENT');
    const data=await registry(), profile=data?.version===1&&data.profiles?.[String(params.uid)];
    if(profile?.status==='provisioning'){
      if(typeof control.bootstrapFilesConfiguration!=='function')throw new Error('SOURCE_UNAVAILABLE');
      return control.bootstrapFilesConfiguration({...profile,workerUid:params.uid});
    }
  }
  if (['files.configuration','files.get','files.list','files.prepare'].includes(method)) {
    const needsArgs=method!=='files.configuration';
    if(Object.keys(params).some(key=>!['uid',...(needsArgs?['args']:[])].includes(key)) || !Number.isSafeInteger(params.uid) || params.uid<=0 || (needsArgs&&!object(params.args))) throw new Error('INVALID_ARGUMENT');
    const user=await privateCall(runtime,'authorize',{uid:params.uid});
    const data=await registry(), profile=data?.profiles?.[String(params.uid)];
    if(!profile||profile.userId!==user.userId||profile.profileId!==user.profileId||profile.status!=='active'||typeof control.perUserRuntime!=='function')throw new Error('FORBIDDEN');
    const ownerRuntime=await control.perUserRuntime({...profile,workerUid:params.uid,role:user.role});
    if(!needsArgs && typeof ownerRuntime?.filesConfiguration==='function')return ownerRuntime.filesConfiguration();
    if(needsArgs && typeof ownerRuntime?.callTool==='function')return ownerRuntime.callTool(method.replace('.','_'),params.args);
    throw new Error('SOURCE_UNAVAILABLE');
  }
  if (method === 'artifacts.publish' || method === 'artifacts.fetch') {
    const allowed=method==='artifacts.publish'?['uid','path','requestId']:['uid','artifactId'];
    if (Object.keys(params).some(key=>!allowed.includes(key)) || !Number.isSafeInteger(params.uid) || params.uid<=0 ||
      (method==='artifacts.publish' ? !text(params.path)||!text(params.requestId) : !text(params.artifactId))) throw new Error('INVALID_ARGUMENT');
    const user=await privateCall(runtime,'authorize',{uid:params.uid});
    const data=await registry(), profile=data?.profiles?.[String(params.uid)];
    if (!profile || profile.userId!==user.userId || profile.profileId!==user.profileId || profile.status!=='active' || typeof control.perUserRuntime!=='function') throw new Error('FORBIDDEN');
    const ownerRuntime=await control.perUserRuntime({...profile,workerUid:params.uid});
    if(method==='artifacts.publish' && typeof ownerRuntime?.publishSnapshot==='function') return ownerRuntime.publishSnapshot(params.path,params.requestId);
    if(method==='artifacts.fetch' && typeof ownerRuntime?.fetchArtifact==='function') return ownerRuntime.fetchArtifact(params.artifactId);
    throw new Error('SOURCE_UNAVAILABLE');
  }
  if (method === 'authorize' || method === 'identity.revalidate') {
    if (!Number.isSafeInteger(params.uid) || params.uid <= 0) throw new Error('FORBIDDEN');
    const data = await registry();
    const profile = data?.version === 1 && data.profiles?.[String(params.uid)];
    if (!profile) {
      if (method === 'identity.revalidate') return { active: false };
      throw new Error('FORBIDDEN');
    }
    const result = await authCall('identity-get', { userId: profile.userId });
    const user = result?.user;
    const active = profile.status === 'active' && user?.id === profile.userId && user.profileId === profile.profileId && user.status === 'active' && String(user.telegramId) === String(profile.telegramId);
    const state = { userId: profile.userId, profileId: profile.profileId,
      status: profile.status !== 'active' ? profile.status : active ? 'active' : user?.status === 'blocked' ? 'blocked' : 'unavailable',
      role: user?.role ?? null };
    runtime.identityStates ??= new Map();
    const previous = runtime.identityStates.get(params.uid);
    if ((!active || previous && JSON.stringify(previous) !== JSON.stringify(state)) && typeof control.onIdentityChanged === 'function') {
      await control.onIdentityChanged(state);
    }
    runtime.identityStates.set(params.uid, state);
    if (!active) {
      if (method === 'identity.revalidate') return { active: false };
      throw new Error('FORBIDDEN');
    }
    return { active: true, userId: profile.userId, profileId: profile.profileId, role: user.role };
  }
  throw new Error('METHOD_NOT_FOUND');
}

/** Обработать JSON-RPC 2.0, включая notifications и ограниченные batch. */
export async function handlePrivateRpc(runtime, input) {
  const one = async request => {
    const validId = request?.id === null || typeof request?.id === 'string' || typeof request?.id === 'number' && Number.isFinite(request.id);
    if (!object(request) || request.jsonrpc !== '2.0' || !text(request.method) || ('id' in request && !validId)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    const notification = !Object.hasOwn(request, 'id');
    if (request.params !== undefined && !object(request.params)) return notification ? null : { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: 'Invalid params' } };
    try {
      const result = await privateCall(runtime, request.method, request.params ?? {});
      return notification ? null : { jsonrpc: '2.0', id: request.id, result };
    } catch (err) {
      const code = err?.message === 'METHOD_NOT_FOUND' ? -32601 : err?.message === 'INVALID_ARGUMENT' ? -32602 : -32603;
      return notification ? null : { jsonrpc: '2.0', id: request.id, error: { code, message: code === -32601 ? 'Method not found' : code === -32602 ? 'Invalid params' : 'Request failed' } };
    }
  };
  if (!Array.isArray(input)) return one(input);
  if (!input.length || input.length > 64) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  const results = (await Promise.all(input.map(one))).filter(Boolean);
  return results.length ? results : null;
}

/** Обслужить bounded поток JSON-RPC; долгие запросы не блокируют проверку UID. */
export async function servePrivateRpc(runtime, source, destination) {
  const { createInterface } = await import('node:readline');
  const input = createInterface({ input: source, crlfDelay: Infinity });
  const pending = new Set();
  try {
    for await (const line of input) {
      while (pending.size >= 64) await Promise.race(pending);
      const work = (async () => {
        let result;
        try {
          if (Buffer.byteLength(line) > 2*1024*1024+65536) throw new Error();
          result = await handlePrivateRpc(runtime, JSON.parse(line));
        } catch { result = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
        if (result !== null && !destination.write(JSON.stringify(result) + '\n')) await once(destination, 'drain');
      })();
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
    }
  } finally { await Promise.allSettled(pending); }
}

/** Запустить приватный JSON-RPC только для доверенного управляющего процесса. */
export async function runStdio(adapters = {}) {
  const config = readProtectedJSON(process.env.BRAI_IDENTITY_CONTROL_CONFIG);
  const runtime = await startControl(config, adapters);
  try { await servePrivateRpc(runtime, process.stdin, process.stdout); }
  finally { await runtime.stop(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]) && process.argv[2] === '--stdio') {
  runStdio().catch(() => { process.stderr.write('Identity control unavailable\n'); process.exitCode = 1; });
}
