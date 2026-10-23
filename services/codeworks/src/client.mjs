// ABOUTME: Подключает CLI и защитный хук к NATS API Codeworks.
// ABOUTME: Проверяет схемы владельца и не выполняет команды или операции с файлами проекта.
import {connect, credsAuthenticator} from 'nats';
import {readFile} from 'node:fs/promises';
import {methods, validate, outputNames} from './contracts.mjs';
import {Fault} from './errors.mjs';

/** Читает публичные настройки подключения; явные переменные окружения перекрывают файл. */
export async function loadClientConfig(env = process.env) {
  const file = env.CODEWORKS_CLIENT_CONFIG ? JSON.parse(await readFile(env.CODEWORKS_CLIENT_CONFIG, 'utf8')) : {};
  return {
    server: env.CODEWORKS_NATS_URL || file.server,
    credsFile: env.CODEWORKS_NATS_CONFIG || env.CODEWORKS_NATS_CREDS_FILE || file.credsFile,
    executorId: env.CODEWORKS_EXECUTOR_ID || file.executorId,
  };
}

function validServers(value) {
  return typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) && value.length > 0 && value.every(server => typeof server === 'string' && server.trim().length > 0);
}

/** Читает protected NATS JSON или стандартный .creds; содержимое и причины ошибок чтения не раскрывает. */
export async function loadNatsOptions(file, {readCredentials = readFile} = {}) {
  try {
    if (typeof file !== 'string' || !file) throw new Error();
    const bytes = await readCredentials(file);
    const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes).trim();
    if (text.startsWith('-----BEGIN NATS USER JWT-----')) return {authenticator: credsAuthenticator(bytes)};
    const options = JSON.parse(text);
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['servers', 'user', 'pass', 'inboxPrefix'].includes(key))) throw new Error();
    if (Object.hasOwn(options, 'servers') && !validServers(options.servers)) throw new Error();
    for (const key of ['user', 'pass', 'inboxPrefix']) if (Object.hasOwn(options, key) && (typeof options[key] !== 'string' || !options[key])) throw new Error();
    if (Object.hasOwn(options, 'user') !== Object.hasOwn(options, 'pass')) throw new Error();
    return options;
  } catch {
    throw new Error('NATS_CONFIGURATION_INVALID');
  }
}

/** Подключает клиент; credentials остаются в NATS handshake, ответ ожидается не более 10 секунд. */
export async function connectClient({server, credsFile, executorId}, {connectNats = connect, readCredentials = readFile} = {}) {
  if (!credsFile || !/^[a-z][a-z0-9_]{0,63}$/.test(executorId ?? '')) throw new Error('CODEWORKS_CLIENT_CONFIGURATION_REQUIRED');
  const options = await loadNatsOptions(credsFile, {readCredentials});
  const servers = server || options.servers;
  if (!validServers(servers)) throw new Error('CODEWORKS_CLIENT_CONFIGURATION_REQUIRED');
  const nc = await connectNats({...options, servers, name: 'codeworks_' + executorId, timeout: 5000, waitOnFirstConnect: false});
  return {
    /** Тайм-аут не отменяет операцию: повтор мутации использует прежний request_key. */
    async call(method, args) {
      if (!methods.includes(method)) throw new Fault('INVALID_ARGUMENT');
      validate(method, args);
      const bytes = Buffer.from(JSON.stringify(args));
      if (bytes.length > 65536) throw new Fault('INVALID_ARGUMENT');
      const reply = await nc.request('brai.codeworks.v2.' + executorId + '.' + method, bytes, {timeout: 10000});
      const result = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(reply.data));
      if (reply.headers?.get('Nats-Service-Error') || reply.headers?.get('Nats-Service-Error-Code')) {
        validate('error', result);
        throw new Fault(result.code, result.message);
      }
      validate(outputNames[method], result);
      return result;
    },
    /** Освобождает только собственное соединение. */
    close: () => nc.close(),
  };
}
