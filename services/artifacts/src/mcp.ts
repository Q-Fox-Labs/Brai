// ABOUTME: Публикует фиксированные инструменты artifacts через MCP Streamable HTTP.
// ABOUTME: Все операции идут в NATS; конфигурация не включает доступ к БД или файлам.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createInbox, connect, type Msg, type NatsConnection, type Subscription } from 'nats';
import { schemas, subjects, validateRequest, validateResponse } from '../contracts/index.mjs';

type McpConfig = {
  natsURL: string; natsUser?: string; natsPassword?: string; inboxPrefix: string;
  host: string; port: number; maxRequestBytes: number; maxResponseBytes: number;
  deadlineMs: number; maxConcurrent: number; maxSessions: number; sessionIdleMs: number; stopMs: number;
  allowedHosts?: string[]; allowedOrigins?: string[];
};
type Tool = { name: string; subject: string; request: string; description: string };
type Session = { server: Server; transport: StreamableHTTPServerTransport; touched: number; calls: Map<string, AbortController> };
type SafeFailure = { code: string; message: string; status: number };
const tools: Tool[] = [
  { name: 'prepare', subject: subjects.prepare, request: 'PrepareRequest', description: 'Резервирует артефакт и возвращает HTTP URL для загрузки байтов.' },
  { name: 'get', subject: subjects.get, request: 'GetRequest', description: 'Получает метаданные артефакта.' },
  { name: 'update', subject: subjects.update, request: 'UpdateRequest', description: 'Изменяет метаданные артефакта.' },
  { name: 'list', subject: subjects.list, request: 'ListRequest', description: 'Ищет артефакты владельца с сортировкой и смещением.' },
  { name: 'stats', subject: subjects.stats, request: 'StatsRequest', description: 'Возвращает агрегаты готовых артефактов владельца.' },
  { name: 'delete', subject: subjects.delete, request: 'DeleteRequest', description: 'Удаляет байты артефакта и сохраняет его запись.' },
  { name: 'relation_add', subject: subjects.relationAdd, request: 'RelationMutationRequest', description: 'Добавляет связь копии с оригиналом.' },
  { name: 'relation_remove', subject: subjects.relationRemove, request: 'RelationMutationRequest', description: 'Удаляет связь копии с оригиналом.' },
  { name: 'relation_list', subject: subjects.relationList, request: 'RelationListRequest', description: 'Перечисляет связи артефакта.' },
  { name: 'reference_reserve', subject: subjects.referenceReserve, request: 'ReferenceReserveRequest', description: 'Атомарно резервирует native reference перед отправкой команды.' },
  { name: 'reference_get', subject: subjects.referenceGet, request: 'ReferenceGetRequest', description: 'Получает native reference по scope.' },
  { name: 'reference_confirm', subject: subjects.referenceConfirm, request: 'ReferenceConfirmRequest', description: 'Привязывает reference к подтверждённому native item.' },
  { name: 'reference_list', subject: subjects.referenceList, request: 'ReferenceListRequest', description: 'Ищет references для точных native item IDs.' },
  { name: 'reference_update_state', subject: subjects.referenceUpdateState, request: 'ReferenceUpdateStateRequest', description: 'Явно отмечает reference как unknown или not-sent.' },
  { name: 'link_create', subject: subjects.linkCreate, request: 'LinkCreateRequest', description: 'Создаёт внешнюю ссылку по явному запросу.' },
  { name: 'link_revoke', subject: subjects.linkRevoke, request: 'LinkRevokeRequest', description: 'Отзывает внешнюю ссылку.' },
];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const serviceErrorCodes = new Map([['INVALID_ARGUMENT', 400], ['NOT_FOUND', 404], ['CONFLICT', 409], ['PAYLOAD_TOO_LARGE', 413], ['LIMIT_EXCEEDED', 413], ['OVERLOADED', 429], ['INTERNAL', 500], ['STORAGE_UNAVAILABLE', 503], ['SHARING_NOT_CONFIGURED', 503]]);
const localErrorCodes = new Set(['CANCELLED', 'NATS_TIMEOUT', 'NATS_UNAVAILABLE', 'INVALID_RESPONSE', 'REQUEST_TIMEOUT', 'FORBIDDEN', 'STOPPING', 'SESSION_NOT_FOUND', 'INVALID_SESSION', 'DUPLICATE_REQUEST', 'TRANSPORT_ERROR']);
const loopback = new Set(['127.0.0.1', '::1', 'localhost']);

function positive(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`Invalid ${key}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) throw new Error(`Invalid ${key}`);
  return value;
}
function list(env: NodeJS.ProcessEnv, key: string, validate: (value: string) => boolean): string[] | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const values = raw.split(',').map((part) => part.trim()).filter(Boolean);
  if (!values.length || values.some((part) => !validate(part))) throw new Error(`Invalid ${key}`);
  return [...new Set(values)];
}
/** Читает только параметры MCP и NATS; параметры PostgreSQL и тома не требуются. */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const natsURL = env.NATS_URL;
  if (!natsURL || natsURL.split(',').some((part) => !part.trim())) throw new Error('Missing or invalid NATS_URL');
  const host = env.ARTIFACTS_MCP_HOST ?? '127.0.0.1';
  if (!host || /[\s/]/.test(host)) throw new Error('Invalid ARTIFACTS_MCP_HOST');
  const port = positive(env, 'ARTIFACTS_MCP_PORT', 3005, 65535);
  const allowedHosts = list(env, 'ARTIFACTS_MCP_ALLOWED_HOSTS', (value) => !/[\s/]/.test(value));
  const allowedOrigins = list(env, 'ARTIFACTS_MCP_ALLOWED_ORIGINS', (value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash; } catch { return false; } });
  if (!loopback.has(host) && (!allowedHosts?.length || !allowedOrigins?.length)) throw new Error('Explicit MCP hosts and origins required for non-loopback bind');
  const inboxPrefix = env.NATS_INBOX_PREFIX ?? '_INBOX.brai_artifacts_mcp';
  if (!/^[A-Za-z0-9_$.-]+$/.test(inboxPrefix)) throw new Error('Invalid NATS_INBOX_PREFIX');
  return {
    natsURL, natsUser: env.NATS_USER, natsPassword: env.NATS_PASSWORD, inboxPrefix, host, port,
    maxRequestBytes: positive(env, 'ARTIFACTS_MCP_MAX_REQUEST_BYTES', 131072, 10485760),
    maxResponseBytes: positive(env, 'ARTIFACTS_MCP_MAX_RESPONSE_BYTES', 1048576, 10485760),
    deadlineMs: positive(env, 'ARTIFACTS_MCP_REQUEST_TIMEOUT_MS', 15000, 600000),
    maxConcurrent: positive(env, 'ARTIFACTS_MCP_MAX_CONCURRENT', 16, 1000),
    maxSessions: positive(env, 'ARTIFACTS_MCP_MAX_SESSIONS', 64, 1000),
    sessionIdleMs: positive(env, 'ARTIFACTS_MCP_SESSION_IDLE_MS', 300000, 3600000),
    stopMs: positive(env, 'ARTIFACTS_MCP_STOP_TIMEOUT_MS', 5000, 600000), allowedHosts, allowedOrigins,
  };
}

function resolveSchema(value: any, depth = 0): any {
  if (depth > 20) throw new Error('MCP schema nesting limit exceeded');
  if (value && typeof value === 'object' && typeof value.$ref === 'string') {
    const match = /^#\/definitions\/([A-Za-z0-9_-]+)$/.exec(value.$ref);
    const definition = match && schemas.definitions[match[1]];
    if (!definition) throw new Error('Unknown MCP schema reference');
    return resolveSchema(definition, depth + 1);
  }
  if (Array.isArray(value)) return value.map((item) => resolveSchema(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSchema(item, depth + 1)]));
}
function inputSchema(tool: Tool): Record<string, unknown> {
  const definition = schemas.definitions[tool.request];
  if (!definition) throw new Error('Missing MCP request schema');
  return resolveSchema(definition) as Record<string, unknown>;
}
function safeFailure(code: string, status: number): SafeFailure {
  const valid = (serviceErrorCodes.get(code) === status) || (localErrorCodes.has(code) && [400, 403, 404, 408, 409, 499, 502, 503].includes(status)) || (code === 'PAYLOAD_TOO_LARGE' && status === 502) || (code === 'OVERLOADED' && status === 503) || (code === 'INVALID_ARGUMENT' && status === 400);
  const selected = valid ? code : 'INVALID_RESPONSE';
  return { code: selected, message: selected === 'INVALID_ARGUMENT' ? 'Проверьте аргументы инструмента.' : 'Операция artifacts не выполнена.', status: valid ? status : 502 };
}
function mcpError(failure: SafeFailure) {
  const value = { code: failure.code, message: failure.message, status: failure.status };
  return { isError: true, structuredContent: value, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}
function header(msg: Msg, name: string): string | undefined {
  const value = msg.headers?.get(name);
  return typeof value === 'string' ? value : undefined;
}
function checkNatsError(msg: Msg): SafeFailure | undefined {
  const code = header(msg, 'Nats-Service-Error');
  const rawStatus = header(msg, 'Nats-Service-Error-Code');
  if (!code && !rawStatus) return undefined;
  const status = rawStatus && /^[45][0-9]{2}$/.test(rawStatus) ? Number(rawStatus) : 0;
  if (!code || serviceErrorCodes.get(code) !== status) return safeFailure('INVALID_RESPONSE', 502);
  return safeFailure(code, status);
}
function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw safeFailure('CANCELLED', 499);
}

/** Выполняет ровно один request-reply и всегда снимает собственную inbox subscription. */
async function requestNats(nc: NatsConnection, cfg: McpConfig, tool: Tool, input: unknown, signal: AbortSignal, active: Set<AbortController>, onWait: (promise: Promise<void>) => void): Promise<unknown> {
  if (!validateRequest(tool.subject, input)) throw safeFailure('INVALID_ARGUMENT', 400);
  const payload = encoder.encode(JSON.stringify(input));
  if (payload.byteLength > cfg.maxRequestBytes) throw safeFailure('PAYLOAD_TOO_LARGE', 413);
  if (active.size >= cfg.maxConcurrent) throw safeFailure('OVERLOADED', 429);
  throwIfAborted(signal);
  const controller = new AbortController();
  active.add(controller);
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  let sub: Subscription | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const inbox = createInbox(cfg.inboxPrefix);
    sub = nc.subscribe(inbox, { max: 1 });
    const receive = (async () => { for await (const msg of sub!) return msg; throw safeFailure('NATS_UNAVAILABLE', 503); })();
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(safeFailure('NATS_TIMEOUT', 503)), cfg.deadlineMs); timer.unref(); });
    const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => {
      const reason = controller.signal.reason;
      reject(reason && typeof reason === 'object' && 'code' in reason && 'status' in reason ? reason : safeFailure('CANCELLED', 499));
    }, { once: true }));
    const waiting = Promise.race([receive, timeout, cancelled]);
    onWait(waiting.then(() => undefined, () => undefined));
    nc.publish(tool.subject, payload, { reply: inbox });
    const msg = await waiting;
    if (msg.headers?.hasError && msg.headers.status === '503') throw safeFailure('NATS_UNAVAILABLE', 503);
    const serviceError = checkNatsError(msg);
    if (serviceError) throw serviceError;
    if (msg.data.byteLength > cfg.maxResponseBytes) throw safeFailure('PAYLOAD_TOO_LARGE', 502);
    let value: unknown;
    try { value = JSON.parse(decoder.decode(msg.data)); } catch { throw safeFailure('INVALID_RESPONSE', 502); }
    if (!validateResponse(tool.subject, value)) throw safeFailure('INVALID_RESPONSE', 502);
    return value;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && 'status' in error) throw error;
    throw safeFailure('NATS_UNAVAILABLE', 503);
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    controller.abort();
    sub?.unsubscribe();
    active.delete(controller);
  }
}

async function readBody(req: IncomingMessage, max: number, deadlineMs: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const body = (async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > max) throw safeFailure('PAYLOAD_TOO_LARGE', 413);
      chunks.push(bytes);
    }
    try { return JSON.parse(decoder.decode(Buffer.concat(chunks))); } catch { throw safeFailure('INVALID_ARGUMENT', 400); }
  })();
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { req.destroy(); reject(safeFailure('REQUEST_TIMEOUT', 408)); }, deadlineMs);
    timer.unref();
  });
  try { return await Promise.race([body, deadline]); } finally { if (timer) clearTimeout(timer); }
}
function requestId(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'id' in body && (typeof body.id === 'string' || typeof body.id === 'number')) return String(body.id);
  return undefined;
}
function sendHttpError(req: IncomingMessage, res: ServerResponse, status: number, code: string) {
  if (!res.headersSent) {
    const incomplete = !req.complete;
    if (incomplete) res.shouldKeepAlive = false;
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: code }));
  } else res.end();
}
function safeStatus(error: unknown): { status: number; code: string } {
  if (error && typeof error === 'object' && 'status' in error && 'code' in error && typeof error.status === 'number' && typeof error.code === 'string') return { status: error.status, code: error.code };
  return { status: 400, code: 'TRANSPORT_ERROR' };
}

/** Запускает один внутренний /mcp endpoint с ограниченным числом сессий и запросов. */
export async function startMcpServer(cfg = loadMcpConfig()): Promise<{ url: string; close(): Promise<void> }> {
  const nc = await connect({ servers: cfg.natsURL.split(',').map((value) => value.trim()), user: cfg.natsUser, pass: cfg.natsPassword, inboxPrefix: cfg.inboxPrefix, maxReconnectAttempts: -1, timeout: 5000, name: 'brai_artifacts_mcp' });
  const sessions = new Map<string, Session>();
  const pending = new Set<Promise<void>>();
  const active = new Set<AbortController>();
  const sockets = new Set<Socket>();
  let initializing = 0;
  let receiving = 0;
  let stopping = false;
  let port = cfg.port;
  const connectionClosed = nc.closed();
  void connectionClosed.then(() => { for (const controller of active) controller.abort(safeFailure('NATS_UNAVAILABLE', 503)); });
  const http = createServer(async (req, res) => {
    if (stopping) { sendHttpError(req, res, 503, 'STOPPING'); return; }
    if (req.url !== '/mcp') { sendHttpError(req, res, 404, 'NOT_FOUND'); return; }
    const allowedHosts = cfg.allowedHosts ?? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    const allowedOrigins = cfg.allowedOrigins ?? allowedHosts.map((host) => `http://${host}`);
    if (!req.headers.host || !allowedHosts.includes(req.headers.host) || (req.headers.origin && !allowedOrigins.includes(req.headers.origin))) { sendHttpError(req, res, 403, 'FORBIDDEN'); return; }
    if (Array.isArray(req.headers['mcp-session-id'])) { sendHttpError(req, res, 400, 'INVALID_SESSION'); return; }
    const sessionHeader = req.headers['mcp-session-id'];
    let session = sessionHeader ? sessions.get(sessionHeader) : undefined;
    if (sessionHeader && !session) { sendHttpError(req, res, 404, 'SESSION_NOT_FOUND'); return; }
    let ownsInit = false;
    let ownsReceive = false;
    if (!session && req.method !== 'POST') { sendHttpError(req, res, 400, 'INVALID_REQUEST'); return; }
    if (!session && sessions.size + initializing >= cfg.maxSessions) { sendHttpError(req, res, 503, 'OVERLOADED'); return; }
    if (req.method === 'POST') {
      if (receiving >= cfg.maxConcurrent) { sendHttpError(req, res, 503, 'OVERLOADED'); return; }
      receiving++;
      ownsReceive = true;
    }
    if (!session) {
      initializing++;
      ownsInit = true;
    }
    const httpAbort = new AbortController();
    const disconnect = () => { if (!res.writableEnded) httpAbort.abort(); };
    res.once('close', disconnect);
    req.once('aborted', disconnect);
    req.socket.once('close', disconnect);
    let id: string | undefined;
    try {
      let body: unknown;
      if (req.method === 'POST') {
        req.setTimeout(cfg.deadlineMs, () => req.destroy());
        body = await readBody(req, cfg.maxRequestBytes, cfg.deadlineMs);
        if (Array.isArray(body)) throw safeFailure('INVALID_ARGUMENT', 400);
        id = requestId(body);
        if (ownsReceive) { receiving--; ownsReceive = false; }
      }
      if (!session) {
        const mcp = new Server({ name: 'brai-artifacts-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: inputSchema(tool) })) }));
        mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          const tool = tools.find((candidate) => candidate.name === request.params.name);
          if (!tool) return mcpError(safeFailure('INVALID_ARGUMENT', 400));
          try {
            const httpSignal = session?.calls.get(String(extra.requestId))?.signal;
            const signal = httpSignal ? AbortSignal.any([extra.signal, httpSignal]) : extra.signal;
            const value = await requestNats(nc, cfg, tool, request.params.arguments ?? {}, signal, active, (promise) => {
              pending.add(promise);
              void promise.finally(() => pending.delete(promise));
            });
            return { structuredContent: value as Record<string, unknown>, content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
          } catch (error) {
            const failure = safeStatus(error);
            return mcpError(safeFailure(failure.code, failure.status));
          }
        });
        const created: Session = { server: mcp, transport: undefined as unknown as StreamableHTTPServerTransport, touched: Date.now(), calls: new Map() };
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts, allowedOrigins, onsessioninitialized: (sessionId) => { sessions.set(sessionId, created); } });
        created.transport = transport;
        session = created;
        transport.onclose = () => {
          for (const controller of created.calls.values()) controller.abort();
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await mcp.connect(transport);
      }
      if (httpAbort.signal.aborted) return;
      if (id !== undefined) {
        if (session.calls.has(id)) { sendHttpError(req, res, 409, 'DUPLICATE_REQUEST'); return; }
        session.calls.set(id, httpAbort);
      }
      session.touched = Date.now();
      await session.transport.handleRequest(req, res, body);
    } catch (error) {
      const safe = safeStatus(error);
      sendHttpError(req, res, safe.status, safe.code);
    } finally {
      if (ownsInit) initializing--;
      if (ownsReceive) receiving--;
      if (id !== undefined) session?.calls.delete(id);
      res.removeListener('close', disconnect);
      req.removeListener('aborted', disconnect);
      req.socket.removeListener('close', disconnect);
      if (session && !session.transport.sessionId) await session.server.close().catch(() => {});
    }
  });
  http.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  http.requestTimeout = cfg.deadlineMs;
  http.headersTimeout = Math.max(1000, Math.min(cfg.deadlineMs, 60000));
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) if (session.calls.size === 0 && Date.now() - session.touched > cfg.sessionIdleMs) {
      sessions.delete(id);
      void session.server.close().catch(() => {});
    }
  }, Math.min(cfg.sessionIdleMs, 30000));
  cleanup.unref();
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(cfg.port, cfg.host, () => { http.removeListener('error', reject); resolve(); }); });
  } catch (error) {
    clearInterval(cleanup);
    await nc.close();
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === 'string') { clearInterval(cleanup); await nc.close(); throw new Error('LISTEN_FAILED'); }
  port = address.port;
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://${cfg.host === '::1' ? '[::1]' : cfg.host}:${port}/mcp`,
    close: () => closePromise ??= (async () => {
      stopping = true;
      clearInterval(cleanup);
      for (const controller of active) controller.abort();
      const closeHttp = new Promise<void>((resolve) => {
        const deadline = setTimeout(() => { http.closeAllConnections(); for (const socket of sockets) socket.destroy(); }, cfg.stopMs);
        deadline.unref();
        http.close(() => { clearTimeout(deadline); resolve(); });
      });
      for (const session of sessions.values()) await session.server.close().catch(() => {});
      sessions.clear();
      let stopTimer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled([...pending]), new Promise<void>((resolve) => { stopTimer = setTimeout(resolve, cfg.stopMs); stopTimer.unref(); })]);
      if (stopTimer) clearTimeout(stopTimer);
      await nc.close();
      await closeHttp;
    })(),
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let runtime: Awaited<ReturnType<typeof startMcpServer>> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    runtime = await startMcpServer();
    console.info(JSON.stringify({ component: 'artifacts-mcp', event: 'ready', endpoint: '/mcp' }));
    const stop = () => { stopping ??= runtime!.close(); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await new Promise<void>((resolve) => process.once('beforeExit', resolve));
    await stopping;
  } catch (error) {
    console.error(JSON.stringify({ component: 'artifacts-mcp', event: 'startup-failed', code: error instanceof Error && 'code' in error ? 'NATS_UNAVAILABLE' : 'STARTUP_FAILED' }));
    process.exitCode = 1;
  }
}
