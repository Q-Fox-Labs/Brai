// ABOUTME: Предоставляет HTTP API и stateless MCP поверх одного проверенного прикладного порта.
// ABOUTME: Ограничивает вход/ответ до сериализации; разрыв соединения не отменяет вычисление.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { methodMap, schemas } from '#transcription-contracts';
import { encodeBoundedJson } from '../../runtime/stdio-rpc.js';
import type { CoordinatorRuntimeConfig } from '../config.js';
import { errorStatus, safeError, type PublicGateway } from './boundary.js';

function readBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const length = req.headers['content-length'];
  if (typeof length === 'string' && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes)) {
    return Promise.reject({ errorCode: 'INPUT_TOO_LARGE' });
  }
  return new Promise((resolve, reject) => {
    const buffer = Buffer.allocUnsafe(maxBytes);
    let size = 0;
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('aborted', aborted); req.off('error', aborted); };
    const aborted = () => { cleanup(); reject({ errorCode: 'DEADLINE_EXCEEDED' }); };
    const data = (chunk: Buffer) => {
      if (size + chunk.length > maxBytes) { cleanup(); req.pause(); reject({ errorCode: 'INPUT_TOO_LARGE' }); return; }
      chunk.copy(buffer, size); size += chunk.length;
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)))); }
      catch { reject({ errorCode: 'INVALID_ARGUMENT' }); }
    };
    req.on('data', data); req.on('end', end); req.on('aborted', aborted); req.on('error', aborted);
  });
}

function send(res: ServerResponse, status: number, value: unknown, maxBytes: number): void {
  if (res.destroyed || res.writableEnded) return;
  let bytes: Buffer;
  try { bytes = encodeBoundedJson(value, maxBytes); }
  catch {
    status = 413;
    try { bytes = encodeBoundedJson({ errorCode: 'RESULT_TOO_LARGE' }, maxBytes); }
    catch { res.destroy(); return; }
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'connection': 'close' });
  res.end(bytes);
}

function resolveSchema(value: unknown, seen: Set<string> = new Set()): any {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => resolveSchema(entry, seen));
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === 'string') {
    const match = /^#\/definitions\/([A-Za-z0-9_]+)$/.exec(record.$ref);
    const definition = match && (schemas.definitions as Record<string, unknown>)[match[1]];
    if (!definition || seen.has(record.$ref)) throw new Error('Invalid MCP owner schema');
    return resolveSchema(definition, new Set([...seen, record.$ref]));
  }
  return Object.fromEntries(Object.entries(record).map(([name, entry]) => [name, resolveSchema(entry, seen)]));
}

const tools = Object.entries(methodMap.public).map(([method, [input, output]]) => ({
  name: `transcription_${method.replaceAll('.', '_')}`, description: 'Операция transcription по доверенной сессии.',
  inputSchema: resolveSchema((schemas.definitions as Record<string, unknown>)[input]),
  outputSchema: { type: 'object', ...resolveSchema((schemas.definitions as Record<string, unknown>)[output]) }, method,
}));

function mcpFailure(error: unknown) {
  // SDK проверяет любой structuredContent по success-schema даже при isError.
  return { isError: true, content: [{ type: 'text' as const, text: 'Transcription operation failed.' },
    { type: 'text' as const, text: JSON.stringify(safeError(error)) }] };
}

function mcpRequest(body: unknown): body is JSONRPCMessage & { method: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return value.jsonrpc === '2.0' && typeof value.method === 'string' &&
    Object.keys(value).every((key) => ['jsonrpc', 'id', 'method', 'params'].includes(key)) &&
    (!Object.hasOwn(value, 'id') || typeof value.id === 'string' || (typeof value.id === 'number' && Number.isFinite(value.id))) &&
    (!Object.hasOwn(value, 'params') || Boolean(value.params && typeof value.params === 'object' && !Array.isArray(value.params)));
}

async function handleMcp(body: JSONRPCMessage & { method: string }, res: ServerResponse, gateway: PublicGateway,
  principal: Record<string, unknown>, maxBytes: number, onDeadline: (stop: () => void) => void): Promise<void> {
  const server = new Server({ name: 'brai-transcription', version: '1.0.0' }, { capabilities: { tools: {} } });
  const tasks = new Set<Promise<unknown>>();
  let finish!: () => void;
  const replied = new Promise<void>((resolve) => { finish = resolve; });
  let closed = false;
  const transport: Transport = {
    start: async () => {},
    close: async () => { closed = true; finish(); transport.onclose?.(); },
    send: async (message) => {
      if (!closed) {
        let response: unknown = message;
        if ('error' in message) response = { jsonrpc: '2.0', id: message.id, error: { code: message.error.code, message: 'Invalid MCP request' } };
        try { encodeBoundedJson(response, maxBytes); }
        catch {
          response = 'id' in message ? { jsonrpc: '2.0', id: message.id, result: mcpFailure({ errorCode: 'RESULT_TOO_LARGE' }) } : undefined;
        }
        if (response !== undefined) send(res, 200, response, maxBytes);
        else res.destroy();
      }
      finish();
    },
  };
  server.onerror = () => {}; // SDK diagnostics do not receive a payload logger.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ method: _method, ...tool }) => tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((entry) => entry.name === request.params.name);
    if (!tool) return mcpFailure({ errorCode: 'INVALID_ARGUMENT' });
    const task = gateway.invoke(tool.method, request.params.arguments ?? {}, principal);
    tasks.add(task);
    try { return { structuredContent: await task as Record<string, unknown>, content: [] }; }
    catch (error) { return mcpFailure(error); }
    finally { tasks.delete(task); }
  });
  await server.connect(transport);
  onDeadline(() => { void server.close(); });
  try {
    transport.onmessage?.(body);
    if (!Object.hasOwn(body, 'id')) {
      if (!res.destroyed && !res.writableEnded) { res.writeHead(202, { 'cache-control': 'no-store', 'connection': 'close' }); res.end(); }
      finish();
    }
    await replied;
  } finally {
    // AIDEV-NOTE: Close/deadline может прервать SDK, но прикладная операция занимает слот до своего завершения.
    await Promise.allSettled([...tasks]);
    await server.close();
  }
}

/** Запускает собственный HTTP listener с 7 API и 7 MCP tools; MCP не хранит сессии/SSE/resume. */
export async function startHttpTransport(config: CoordinatorRuntimeConfig['http'], gateway: PublicGateway) {
  const server = createServer({ maxHeaderSize: config.headerBytes, headersTimeout: config.requestTimeoutMs,
    requestTimeout: 0, keepAliveTimeout: config.requestTimeoutMs }, (req, res) => {
    req.on('error', () => {});
    res.setHeader('cache-control', 'no-store');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopMcp: (() => void) | undefined;
    const operation = async () => {
      const host = req.headers.host;
      const origin = req.headers.origin;
      if (!host || !config.allowedHosts.includes(host.toLowerCase()) || (origin && !config.allowedOrigins.includes(origin))) {
        throw { errorCode: 'FORBIDDEN' };
      }
      const principal = gateway.authenticate(req.headers.authorization);
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); send(res, 405, { errorCode: 'INVALID_ARGUMENT' }, config.responseBytes); return; }
      const contentType = req.headers['content-type'];
      if (!contentType || contentType.split(';')[0].trim().toLowerCase() !== 'application/json') throw { errorCode: 'INVALID_ARGUMENT' };
      timer = setTimeout(() => {
        send(res, 504, { errorCode: 'DEADLINE_EXCEEDED' }, config.responseBytes);
        stopMcp?.();
        if (!req.complete) req.destroy();
      }, config.requestTimeoutMs);
      const body = await readBody(req, config.requestBytes);
      if (res.destroyed || res.writableEnded) return;
      if (req.url === '/mcp') {
        if (req.headers['mcp-session-id'] || !mcpRequest(body)) throw { errorCode: 'INVALID_ARGUMENT' };
        await handleMcp(body, res, gateway, principal, config.responseBytes, (stop) => { stopMcp = stop; });
        return;
      }
      const prefix = '/v1/transcription/';
      const method = req.url?.startsWith(prefix) ? req.url.slice(prefix.length) : '';
      if (!Object.hasOwn(methodMap.public, method)) throw { errorCode: 'NOT_FOUND' };
      send(res, 200, await gateway.invoke(method, body, principal), config.responseBytes);
    };
    void gateway.withCapacity(operation).catch((error) => {
      const failure = safeError(error);
      send(res, errorStatus(failure.errorCode), failure, config.responseBytes);
    }).finally(() => { if (timer) clearTimeout(timer); });
  });
  server.maxConnections = config.maxConnections;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
  });
  return {
    address: () => server.address(),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
