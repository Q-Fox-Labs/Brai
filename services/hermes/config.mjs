// ABOUTME: Читает явную конфигурацию мостов Hermes без доступа к .env.
// ABOUTME: Владелец и адреса задаются доверенным запуском, а не аргументами модели.
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw Object.assign(new Error('INVALID_HERMES_CONFIG'), { code: 'INVALID_HERMES_CONFIG' }); };
const endpoint = value => {
  if (!object(value) || typeof value.url !== 'string') invalid();
  let url; try { url = new URL(value.url); } catch { invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid();
  if (value.token !== undefined && (typeof value.token !== 'string' || !value.token || /\s/.test(value.token))) invalid();
};

/** Проверяет фиксированного владельца и необходимые порты; соседние секции принадлежат своим адаптерам. */
export function validateConfig(value, trustedOwnerId) {
  if (!object(value) || typeof value.ownerId !== 'string' || value.ownerId !== trustedOwnerId ||
    !value.ownerId || /\s/.test(value.ownerId) || [...value.ownerId].length > 128) invalid();
  if (!object(value.nats) || !Array.isArray(value.nats.servers) || !value.nats.servers.length ||
    value.nats.servers.some(server => typeof server !== 'string' || !server.trim()) ||
    ['user', 'password', 'inboxPrefix'].some(key => value.nats[key] !== undefined && typeof value.nats[key] !== 'string')) invalid();
  for (const name of ['gameCore', 'history', 'transcription']) endpoint(value[name]);
  if (value.gameCore.ownerId !== value.ownerId) invalid();
  if (!object(value.publisher) || typeof value.publisher.configPath !== 'string' || !isAbsolute(value.publisher.configPath) ||
    value.publisher.entrypoint !== undefined && (typeof value.publisher.entrypoint !== 'string' || !isAbsolute(value.publisher.entrypoint))) invalid();
  for (const [name, maximum] of [['requestTimeoutMs', 60_000], ['longRequestTimeoutMs', 1_800_000]]) {
    if (value[name] !== undefined && (!Number.isSafeInteger(value[name]) || value[name] < 1 || value[name] > maximum)) invalid();
  }
  return value;
}

/** Загружает защищённый JSON; доверенный owner передаётся отдельно окружением запуска. */
export async function loadConfig(env = process.env) {
  if (!env.BRAI_HERMES_CONFIG || !isAbsolute(env.BRAI_HERMES_CONFIG)) invalid();
  return validateConfig(JSON.parse(await readFile(env.BRAI_HERMES_CONFIG, 'utf8')), env.BRAI_HERMES_OWNER_ID);
}
