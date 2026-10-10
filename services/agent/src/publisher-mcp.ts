// ABOUTME: Предоставляет publish_file/fetch_file через MCP stdio фиксированному владельцу.
// ABOUTME: Читает защищённую явную конфигурацию; metadata проверяет контрактом artifacts.
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, ServiceErrorHeader, ServiceErrorCodeHeader, type NatsConnection } from 'nats';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { validateRequest, validateResponse } from '../../artifacts/contracts/index.mjs';
import { createPublisher, type PublisherConfig, type PublisherPort } from './publisher.js';
import { publisherFetch } from './publisher-http.js';

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const object = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, any>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

/** Проверяет конфигурацию без чтения .env; владелец обязательно подтверждён окружением запуска. */
export function validatePublisherConfig(value: unknown, trustedOwnerId: string | undefined): PublisherConfig {
  if (!object(value) || !keys(value, ['ownerId', 'resultRoot', 'allowedReadRoots', 'artifacts', 'uploadTimeoutMs']) || typeof value.ownerId !== 'string' || value.ownerId !== trustedOwnerId || !value.ownerId || /\s/.test(value.ownerId) || [...value.ownerId].length > 128 || typeof value.resultRoot !== 'string' || !isAbsolute(value.resultRoot) || /[\\<>?#%\x00-\x1f\x7f]/.test(value.resultRoot) || !Array.isArray(value.allowedReadRoots) || !value.allowedReadRoots.length || value.allowedReadRoots.some((path: unknown) => typeof path !== 'string' || !isAbsolute(path)) || !object(value.artifacts) || !keys(value.artifacts, ['baseUrl', 'uploadBaseUrl', 'timeoutMs', 'nats']) || typeof value.artifacts.baseUrl !== 'string' || value.artifacts.uploadBaseUrl !== undefined && typeof value.artifacts.uploadBaseUrl !== 'string') fail('INVALID_PUBLISHER_CONFIG');
  const cfg = value as PublisherConfig, nats = cfg.artifacts.nats;
  if (!object(nats) || !keys(nats, ['servers', 'user', 'password', 'inboxPrefix']) || !Array.isArray(nats.servers) || !nats.servers.length || nats.servers.some(server => typeof server !== 'string' || !server.trim()) || [nats.user, nats.password, nats.inboxPrefix].some(value => value !== undefined && typeof value !== 'string') || nats.inboxPrefix !== undefined && !/^[A-Za-z0-9_$.-]+$/.test(nats.inboxPrefix)) fail('INVALID_PUBLISHER_CONFIG');
  for (const [value, max] of [[cfg.artifacts.timeoutMs, 10000], [cfg.uploadTimeoutMs, 1800000]]) if (value !== undefined && (!Number.isSafeInteger(value) || value! < 1 || value! > max!)) fail('INVALID_PUBLISHER_CONFIG');
  try { for (const value of [cfg.artifacts.baseUrl, cfg.artifacts.uploadBaseUrl ?? cfg.artifacts.baseUrl]) { const base = new URL(value); if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) fail('INVALID_PUBLISHER_CONFIG'); } }
  catch { fail('INVALID_PUBLISHER_CONFIG'); }
  return cfg;
}

/** Преобразует NATS Services ответы, ограничивает metadata до 1 MiB и ожидание до timeoutMs. */
export function createPublisherPort(nc: NatsConnection, timeoutMs = 10000): PublisherPort {
  return { fetch: publisherFetch, async request(subject, value, signal) {
    signal.throwIfAborted(); if (!validateRequest(subject, value)) fail('INVALID_ARGUMENT');
    let abort: (() => void) | undefined;
    try {
      const reply = await Promise.race([nc.request(subject, Buffer.from(JSON.stringify(value)), { timeout: timeoutMs }), new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); })]);
      signal.throwIfAborted();
      const code = reply.headers?.get(ServiceErrorHeader), status = reply.headers?.get(ServiceErrorCodeHeader);
      if (Boolean(code) !== Boolean(status) || status && !/^[45][0-9]{2}$/.test(status)) fail('INVALID_ARTIFACT_RESPONSE');
      if (code) fail(status === '404' ? 'NOT_FOUND' : status === '409' ? 'OPERATION_CONFLICT' : 'ARTIFACTS_UNAVAILABLE');
      if (reply.data.length > 1048576) fail('INVALID_ARTIFACT_RESPONSE');
      let result: unknown; try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.data)); } catch { fail('INVALID_ARTIFACT_RESPONSE'); }
      if (!validateResponse(subject, result)) fail('INVALID_ARTIFACT_RESPONSE'); return result;
    } finally { if (abort) signal.removeEventListener('abort', abort); }
  } };
}

export const publisherTools = [
  { name: 'publish_file', description: 'Публикует самостоятельный пользовательский файл или творческий кандидат из разрешённого каталога. Стабильный requestId закрепляет байты; изменённое содержимое требует нового ключа. Возвращает проверенную локальную копию и готовый Markdown.', inputSchema: { type: 'object' as const, additionalProperties: false, required: ['path', 'requestId'], properties: { path: { type: 'string', minLength: 1 }, requestId: { type: 'string', minLength: 1, maxLength: 256 }, title: { type: 'string', minLength: 1, maxLength: 512 } } } },
  { name: 'fetch_file', description: 'Восстанавливает готовый артефакт текущего владельца в неизменяемую локальную копию и проверяет SHA-256. Не принимает путь назначения или ownerId.', inputSchema: { type: 'object' as const, additionalProperties: false, required: ['artifactId'], properties: { artifactId: { type: 'string', format: 'uuid' } } } },
];
const safeCodes = new Set(['INVALID_ARGUMENT', 'READ_ROOT_DENIED', 'INVALID_FILE', 'INVALID_FILENAME', 'FILE_TOO_LARGE', 'FORBIDDEN', 'NOT_READY', 'HASH_MISMATCH', 'LOCAL_CONTENT_CONFLICT', 'UNSAFE_RESULT_PATH', 'OPERATION_CONFLICT', 'NOT_FOUND', 'OVERLOADED', 'STOPPING', 'INVALID_ARTIFACT_URL', 'INVALID_ARTIFACT_RESPONSE', 'UPLOAD_NOT_CONFIRMED', 'DOWNLOAD_FAILED', 'ARTIFACTS_UNAVAILABLE']);

/** Создаёт настоящий MCP сервер; tools/call отмена передаётся publisher без раскрытия secrets. */
export function createPublisherMcpServer(publisher: Awaited<ReturnType<typeof createPublisher>>) {
    const server = new Server({ name: 'brai-agent-publisher', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: publisherTools }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        const result = request.params.name === 'publish_file' ? await publisher.publishFile(request.params.arguments as any, extra.signal) : request.params.name === 'fetch_file' ? await publisher.fetchFile(request.params.arguments as any, extra.signal) : fail('INVALID_ARGUMENT');
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error: any) { const code = extra.signal.aborted ? 'CANCELLED' : error.name === 'TimeoutError' ? 'TIMEOUT' : safeCodes.has(error.code) ? error.code : 'PUBLISHER_UNAVAILABLE'; return { isError: true, content: [{ type: 'text', text: code }] }; }
    });
    return server;
}

/** Подключает fixed-owner MCP stdio; завершение закрывает свои HTTP потоки и NATS соединение. */
export async function startPublisherMcp(config: PublisherConfig, trustedOwnerId: string, transport = new StdioServerTransport()) {
  validatePublisherConfig(config, trustedOwnerId);
  const nc = await connect({ servers: config.artifacts.nats.servers, user: config.artifacts.nats.user, pass: config.artifacts.nats.password, inboxPrefix: config.artifacts.nats.inboxPrefix ?? '_INBOX.brai_agent_publisher', name: 'brai-agent-publisher', timeout: 5000 });
  try {
    const publisher = await createPublisher(config, createPublisherPort(nc, config.artifacts.timeoutMs), trustedOwnerId), server = createPublisherMcpServer(publisher);
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => { await publisher.close(); await server.close(); await nc.close(); })();
    server.onclose = () => { void close(); };
    try { await server.connect(transport); } catch (error) { await close(); throw error; }
    return { server, close };
  } catch (error) { await nc.close(); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const path = process.env.BRAI_AGENT_PUBLISHER_CONFIG;
    if (!path || !isAbsolute(path)) fail('PUBLISHER_CONFIG_REQUIRED');
    const config = validatePublisherConfig(JSON.parse(await readFile(path!, 'utf8')), process.env.BRAI_AGENT_OWNER_ID);
    const runtime = await startPublisherMcp(config, process.env.BRAI_AGENT_OWNER_ID!);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void runtime.close().finally(() => { process.exitCode = 0; }); });
  } catch { console.error('PUBLISHER_STARTUP_FAILED'); process.exitCode = 1; }
}
