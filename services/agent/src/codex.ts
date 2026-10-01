// ABOUTME: Реализует ограниченный raw WebSocket адаптер к Codex app-server.
// ABOUTME: Владеет только RPC correlation и транспортом server requests, не состоянием ходов.

import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import openrpc from '../contracts/codex/openrpc.json' with { type: 'json' };
import schema from '../contracts/codex/schema.json' with { type: 'json' };
import { CodexError } from './errors.js';
import type {
  CodexObservation,
  CodexOptions,
  CodexPort,
  CodexStatus,
  RawRequestId,
} from './ports.js';

const DEFAULT_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const DEFAULT_PENDING = 64;
const DEFAULT_EVENTS = 256;
const MAX_QUEUED_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_SERVER_REQUESTS = 64;
const MAX_SERVER_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_TIMEOUT_MS = 10_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 12_000;

type Method = (typeof openrpc.methods)[number];
type SocketFactory = (url: string, options: WebSocket.ClientOptions) => WebSocket;
type Pending = {
  method: string;
  mutation: boolean;
  resolve: (value: unknown) => void;
  reject: (error: CodexError) => void;
  timer: ReturnType<typeof setTimeout>;
};
type ServerRequest = { response: (value: unknown) => boolean; size: number };
type QueuedEvent = { event: CodexObservation; bytes: number };

/**
 * Создать CodexPort для явного Unix socket WebSocket URL.
 * @param socketFactory Подмена raw WebSocket-конструктора нужна только изолированным проверкам протокола.
 */
export function createCodex(
  options: CodexOptions,
  socketFactory: SocketFactory = (url, clientOptions) => new WebSocket(url, clientOptions),
): CodexPort {
  if (!options.socketUrl.startsWith('ws+unix:') || !options.socketUrl.endsWith(':/')) {
    throw new TypeError('socketUrl must be an explicit ws+unix endpoint');
  }

  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_FRAME_BYTES;
  const maxPending = options.maxPending ?? DEFAULT_PENDING;
  const maxEvents = options.maxEvents ?? DEFAULT_EVENTS;
  if (![maxFrameBytes, maxPending, maxEvents].every(Number.isSafeInteger) ||
      maxFrameBytes < 1 || maxPending < 1 || maxEvents < 1) {
    throw new RangeError('Codex limits must be positive safe integers');
  }

  const ajv = new Ajv.default({ strict: false, allErrors: false, validateFormats: false });
  ajv.addSchema(schema, 'schema.json');
  const methods = new Map<string, { method: Method; params: ReturnType<typeof ajv.compile>; result: ReturnType<typeof ajv.compile> }>();
  for (const method of openrpc.methods) {
    methods.set(method.name, {
      method,
      params: ajv.compile(method['x-paramsSchema']),
      result: ajv.compile(method.result.schema),
    });
  }
  const notificationValidators = new Map(openrpc['x-notifications'].map((item) =>
    [item.name, ajv.compile(item.schema)]));
  const requestDefinitions = new Map(openrpc['x-serverRequests'].map((item) =>
    [item.name, { params: ajv.compile(item.params), response: ajv.compile(item.response) }]));

  let ws: WebSocket | null = null;
  let closed = false;
  let connecting = false;
  let socketOpen = false;
  let protocolReady = false;
  let generation: string | null = null;
  let authorization: CodexStatus['authorization'] = 'unknown';
  let eventOverflow = false;
  let nextId = 0;
  let queue: QueuedEvent[] = [];
  let queuedEventBytes = 0;
  let dispatching = false;
  let overflowPending = false;
  const listeners = new Set<(event: CodexObservation) => void | Promise<void>>();
  const pending = new Map<RawRequestId, Pending>();
  const serverRequests = new Map<RawRequestId, ServerRequest>();
  let serverRequestBytes = 0;

  const snapshot = (): CodexStatus => ({
    generation,
    connection: protocolReady && ws?.readyState === WebSocket.OPEN ? 'connected' : connecting || socketOpen ? 'connecting' : 'disconnected',
    authorization,
    eventOverflow,
  });

  const publish = (event: CodexObservation): void => {
    if (!listeners.size) return;
    let bytes: number;
    try { bytes = Buffer.byteLength(JSON.stringify(event)); } catch { bytes = MAX_QUEUED_EVENT_BYTES + 1; }
    if (queue.length >= maxEvents || queuedEventBytes + bytes > MAX_QUEUED_EVENT_BYTES) {
      eventOverflow = true;
      overflowPending = true;
      return;
    }
    queue.push({ event, bytes });
    queuedEventBytes += bytes;
    void drainEvents();
  };

  async function drainEvents(): Promise<void> {
    if (dispatching) return;
    dispatching = true;
    try {
      while (queue.length) {
        const queued = queue.shift()!;
        queuedEventBytes -= queued.bytes;
        for (const listener of listeners) {
          try { await listener(queued.event); } catch { /* Ошибка подписчика не останавливает приём кадров. */ }
        }
      }
      if (overflowPending) {
        overflowPending = false;
        const diagnostic: CodexObservation = { type: 'connection', status: snapshot(), code: 'event-overflow' };
        for (const listener of listeners) {
          try { await listener(diagnostic); } catch { /* Ошибка подписчика не скрывает факт переполнения. */ }
        }
      }
    } finally {
      dispatching = false;
      if (queue.length || overflowPending) void drainEvents();
    }
  }

  const sendRaw = (packet: unknown, mutation = false): Promise<void> => new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new CodexError('disconnected', 'not-sent'));
      return;
    }
    const data = JSON.stringify(packet);
    if (Buffer.byteLength(data) > maxFrameBytes) {
      reject(new CodexError('frame-too-large', 'not-sent'));
      return;
    }
    const bytes = Buffer.byteLength(data);
    if (ws.bufferedAmount + bytes > MAX_BUFFERED_BYTES) {
      reject(new CodexError('send-capacity', 'not-sent'));
      return;
    }
    ws.send(data, (error) => error
      ? reject(new CodexError('send-failed', mutation ? 'unknown' : 'query'))
      : resolve());
  });

  const failPending = (code: string): void => {
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      pending.delete(id);
      item.reject(new CodexError(code, item.mutation ? 'unknown' : 'query'));
    }
  };

  const disconnect = (socket: WebSocket, code: string): void => {
    if (ws !== socket) return;
    ws = null;
    socketOpen = false;
    connecting = false;
    protocolReady = false;
    authorization = 'unknown';
    serverRequests.clear();
    serverRequestBytes = 0;
    failPending(code);
    publish({ type: 'connection', status: snapshot(), code });
    if (socket.readyState < WebSocket.CLOSING) socket.terminate();
  };

  const compactKeys = (params: Record<string, unknown>): Record<string, string> => {
    const keys: Record<string, string> = {};
    for (const name of ['threadId', 'turnId', 'itemId']) {
      const value = params[name];
      if (typeof value === 'string' && value.length <= 256) keys[name] = value;
    }
    return keys;
  };

  const onMessage = (socket: WebSocket, data: WebSocket.RawData): void => {
    if (socket !== ws) return;
    const size = typeof data === 'string' ? Buffer.byteLength(data) : Array.isArray(data)
      ? data.reduce((total, part) => total + part.byteLength, 0)
      : data.byteLength;
    if (size > maxFrameBytes) {
      disconnect(socket, 'frame-too-large');
      return;
    }
    let packet: unknown;
    try { packet = JSON.parse(data.toString()); } catch {
      publish({ type: 'connection', status: snapshot(), code: 'invalid-json' });
      return;
    }
    if (!isRecord(packet)) {
      publish({ type: 'connection', status: snapshot(), code: 'invalid-packet' });
      return;
    }
    if (hasOwn(packet, 'id') && typeof packet.method === 'string') {
      if (!isRequestId(packet.id)) {
        publish({ type: 'connection', status: snapshot(), code: 'invalid-server-request' });
        return;
      }
      const params = isRecord(packet.params) ? packet.params : {};
      const definition = requestDefinitions.get(packet.method);
      const supported = Boolean(definition && isRecord(packet.params) && definition.params(packet.params));
      const keys = compactKeys(params);
      const requestBytes = Buffer.byteLength(JSON.stringify({ id: packet.id, method: packet.method, keys }));
      const previous = serverRequests.get(packet.id);
      if (serverRequests.size - (previous ? 1 : 0) >= MAX_SERVER_REQUESTS || serverRequestBytes - (previous?.size ?? 0) + requestBytes > MAX_SERVER_REQUEST_BYTES) {
        publish({ type: 'connection', status: snapshot(), code: 'server-request-overflow' });
        return;
      }
      if (previous) serverRequestBytes -= previous.size;
      serverRequests.set(packet.id, { response: definition?.response ?? (() => false), size: requestBytes });
      serverRequestBytes += requestBytes;
      publish({ type: 'request', method: packet.method, params: supported ? params : keys, id: packet.id, supported, ...(supported ? {} : { code: definition ? 'invalid-server-request-schema' : 'unsupported-server-request' }) });
      return;
    }
    if (typeof packet.method === 'string' && !hasOwn(packet, 'id')) {
      const validator = notificationValidators.get(packet.method);
      if (!validator) {
        publish({ type: 'connection', status: snapshot(), code: 'unsupported-notification' });
        return;
      }
      if (!isRecord(packet.params) || !validator(packet.params)) {
        publish({ type: 'connection', status: snapshot(), code: 'invalid-notification-schema' });
        return;
      }
      if (packet.method === 'account/updated') {
        authorization = typeof packet.params.authMode === 'string' ? 'ready' : 'unknown';
        publish({ type: 'connection', status: snapshot(), code: 'account-updated' });
        return;
      }
      publish({ type: 'notification', method: packet.method, params: packet.params });
      if (packet.method === 'serverRequest/resolved' && isRequestId(packet.params.requestId)) {
        const request = serverRequests.get(packet.params.requestId);
        if (request) serverRequestBytes -= request.size;
        serverRequests.delete(packet.params.requestId);
      }
      return;
    }
    if (!isRequestId(packet.id) || hasOwn(packet, 'method')) {
      publish({ type: 'connection', status: snapshot(), code: 'invalid-response' });
      return;
    }
    const item = pending.get(packet.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(packet.id);
    if (hasOwn(packet, 'error') === hasOwn(packet, 'result')) {
      item.reject(new CodexError('invalid-response-shape', item.mutation ? 'unknown' : 'query'));
      return;
    }
    if (hasOwn(packet, 'error')) {
      if (!isRecord(packet.error) || !Number.isInteger(packet.error.code)) {
      item.reject(new CodexError('invalid-error-response', item.mutation ? 'unknown' : 'query'));
        return;
      }
      item.reject(new CodexError(
        'upstream-error',
        item.mutation ? 'unknown' : 'query',
        packet.error.code as number,
      ));
      return;
    }
    const descriptor = methods.get(item.method);
    if (!hasOwn(packet, 'result') || !descriptor?.result(packet.result)) {
      item.reject(new CodexError('invalid-result', item.mutation ? 'unknown' : 'query'));
      return;
    }
    if (item.method === 'account/read') {
      const auth = isRecord(packet.result) && isRecord(packet.result.account)
        ? 'ready'
        : isRecord(packet.result) && packet.result.requiresOpenaiAuth === true ? 'required' : 'ready';
      item.resolve({ authorization: auth });
      return;
    }
    item.resolve(packet.result);
  };

  const port: CodexPort = {
    async connect() {
      if (closed) throw new CodexError('closed', 'not-sent');
      if (ws?.readyState === WebSocket.OPEN && protocolReady) return;
      if (connecting) throw new CodexError('connecting', 'not-sent');
      connecting = true;
      const socket = socketFactory(options.socketUrl, {
        maxPayload: maxFrameBytes,
        perMessageDeflate: false,
        handshakeTimeout: options.connectTimeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS,
      });
      ws = socket;
      socket.on('message', (data) => onMessage(socket, data));
      socket.once('close', () => disconnect(socket, 'disconnected'));
      socket.once('error', () => disconnect(socket, 'transport-error'));
      try {
        await waitForOpen(socket, options.connectTimeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS);
        connecting = false;
        socketOpen = true;
        const init = await port.call('initialize', {
          clientInfo: options.clientInfo ?? { name: 'brai-agent', version: '1.0.0' },
          capabilities: { experimentalApi: true },
        }, { mutation: false, timeoutMs: options.connectTimeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS });
        if (!isRecord(init)) throw new CodexError('invalid-initialize-result', 'query');
        await sendRaw({ method: 'initialized', params: {} });
        generation = randomUUID();
        protocolReady = true;
        authorization = 'unknown';
        try {
          const account = await port.call('account/read', { refreshToken: false }, { mutation: false });
          if (isRecord(account) && ['ready', 'required', 'failed', 'unknown'].includes(String(account.authorization))) {
            authorization = account.authorization as CodexStatus['authorization'];
          }
        } catch (error) {
          authorization = error instanceof CodexError && error.code === 'upstream-error' ? 'failed' : 'unknown';
        }
        publish({ type: 'connection', status: snapshot() });
      } catch (error) {
        if (ws === socket) {
          try { socket.terminate(); } catch { /* Ошибка закрытия не заменяет исходную ошибку подключения. */ }
          disconnect(socket, error instanceof CodexError ? error.code : 'connect-failed');
        }
        throw error;
      }
    },
    call(method, params, callOptions) {
      if (!ws || ws.readyState !== WebSocket.OPEN || !socketOpen || !protocolReady && method !== 'initialize') {
        return Promise.reject(new CodexError('disconnected', 'not-sent'));
      }
      const descriptor = methods.get(method);
      if (!descriptor) return Promise.reject(new CodexError('unsupported-method', 'not-sent'));
      if (!isRecord(params) || !descriptor.params(params)) return Promise.reject(new CodexError('invalid-params', 'not-sent'));
      if (method === 'account/read' && params.refreshToken !== false) {
        return Promise.reject(new CodexError('unsafe-account-read', 'not-sent'));
      }
      if (pending.size >= maxPending) return Promise.reject(new CodexError('pending-limit', 'not-sent'));
      const id = `brai-${++nextId}`;
      const timeoutMs = callOptions.timeoutMs ?? (callOptions.mutation ? DEFAULT_MUTATION_TIMEOUT_MS : DEFAULT_READ_TIMEOUT_MS);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new CodexError('invalid-timeout', 'not-sent'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(new CodexError('timeout', callOptions.mutation ? 'unknown' : 'query'));
        }, timeoutMs);
        pending.set(id, { method, mutation: callOptions.mutation, resolve, reject, timer });
        void sendRaw({ id, method, params }, callOptions.mutation).catch((error: unknown) => {
          if (!pending.has(id)) return;
          clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof CodexError ? error : new CodexError('send-failed', 'unknown'));
        });
      });
    },
    async respond(rawRequestId, answer) {
      if (!isRequestId(rawRequestId)) throw new CodexError('invalid-request-id', 'not-sent');
      const request = serverRequests.get(rawRequestId);
      if (!request) throw new CodexError('unknown-server-request', 'not-sent');
      if (!request.response(answer)) throw new CodexError('invalid-response-params', 'not-sent');
      await sendRaw({ id: rawRequestId, result: answer }, true);
      serverRequestBytes -= request.size;
      serverRequests.delete(rawRequestId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: snapshot,
    async close() {
      if (closed) return;
      closed = true;
      failPending('closed');
      const socket = ws;
      ws = null;
      socketOpen = false;
      connecting = false;
      protocolReady = false;
      authorization = 'unknown';
      serverRequests.clear();
      serverRequestBytes = 0;
      if (socket && socket.readyState < WebSocket.CLOSING) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { socket.terminate(); resolve(); }, 2_000);
          socket.once('close', () => { clearTimeout(timer); resolve(); });
          socket.close();
        });
      }
      publish({ type: 'connection', status: snapshot(), code: 'closed' });
    },
  };
  return port;
}

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CodexError('connect-timeout', 'not-sent')), timeoutMs);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', () => { clearTimeout(timer); reject(new CodexError('connect-failed', 'not-sent')); });
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isRequestId(value: unknown): value is RawRequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
