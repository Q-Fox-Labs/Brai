// ABOUTME: Связывает ограниченные RPC и server requests с действующим Codex.
// ABOUTME: Не запускает daemon, не повторяет мутации и не передаёт аккаунт наружу.
import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import openrpc from '../contracts/codex/openrpc.json' with { type: 'json' };
import schema from '../contracts/codex/schema.json' with { type: 'json' };
import { bytes, limits } from '../contracts/index.mjs';
export type ServerRequestRejection = 'unsupported-method' | 'invalid-params' | 'request-too-large' | 'too-many-pending' | 'presentation-limit';
export type Observation = { type: 'notification' | 'request' | 'connection'; method?: string; params?: any; id?: string | number; supported?: boolean; reason?: ServerRequestRejection; status?: ReturnType<CodexPort['status']> };
export type CodexPort = ReturnType<typeof createCodex>;
/** Создаёт подключение к явному Unix socket; каждый RPC отправляется один раз. */
export function createCodex(options: { socketUrl: string }) {
  const ajv = new Ajv.default({ strict: false, validateFormats: false });
  ajv.addSchema(schema, 'schema.json');
  const methods = new Map(openrpc.methods.map(m => [m.name, { params: ajv.compile(m['x-paramsSchema']), result: ajv.compile(m.result.schema) }]));
  const notifications = new Map(openrpc['x-notifications'].map(n => [n.name, ajv.compile(n.schema)]));
  const definitions = new Map(openrpc['x-serverRequests'].map(r => [r.name, { params: ajv.compile(r.params), answer: ajv.compile(r.response) }]));
  const listeners = new Set<(event: Observation) => void>();
  const pending = new Map<number, { method: string; mutation: boolean; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const requests = new Map<string | number, (answer: unknown) => boolean>();
  let ws: WebSocket | undefined, connection: Promise<void> | undefined;
  let generation = randomUUID(), nextId = 0, ready = false, closed = false, authorization = 'unknown';
  const status = () => ({ generation, connection: ready ? 'connected' : ws ? 'connecting' : 'disconnected', authorization });
  const notify = (event: Observation) => { for (const listener of listeners) listener(event); };
  const fail = (code: string, outcome = 'not-sent'): Error => Object.assign(new Error(code), { code, outcome });
  function settle(id: number, error?: Error, result?: unknown) {
    const value = pending.get(id);
    if (!value) return;
    pending.delete(id);
    clearTimeout(value.timer);
    if (error) value.reject(error); else value.resolve(result);
  }
  function disconnect() {
    ready = false;
    generation = randomUUID();
    authorization = 'unknown';
    const socket = ws;
    ws = undefined;
    requests.clear();
    for (const [id, value] of pending) settle(id, fail('UPSTREAM_UNAVAILABLE', value.mutation ? 'unknown' : 'query'));
    socket?.terminate();
    notify({ type: 'connection', status: status() });
  }
  async function send(packet: unknown, mutation: boolean) {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw fail('UPSTREAM_UNAVAILABLE');
    const encoded = JSON.stringify(packet);
    if (bytes(packet) > 2097152 || ws.bufferedAmount + Buffer.byteLength(encoded) > 2097152) throw fail('CAPACITY_EXHAUSTED');
    await new Promise<void>((resolve, reject) => ws!.send(encoded, error => error ? reject(fail('UPSTREAM_UNAVAILABLE', mutation ? 'unknown' : 'query')) : resolve()));
  }
  function rejection(reason: ServerRequestRejection) {
    if (reason === 'unsupported-method') return { code: -32601, message: 'Method not found' };
    if (reason === 'invalid-params') return { code: -32602, message: 'Invalid params' };
    if (reason === 'request-too-large') return { code: -32000, message: 'Server request exceeds the Brai request limit' };
    if (reason === 'too-many-pending') return { code: -32001, message: 'Too many pending server requests' };
    return { code: -32002, message: 'Brai cannot safely present this server request' };
  }
  function rejectUnsupported(id: string | number, method: string, params: any, reason: ServerRequestRejection) {
    const safeParams = {
      ...(typeof params?.threadId === 'string' ? { threadId: params.threadId } : {}),
      ...(typeof params?.turnId === 'string' ? { turnId: params.turnId } : {}),
    };
    void send({ id, error: rejection(reason) }, false)
      .then(() => notify({ type: 'request', id, method, params: safeParams, supported: false, reason }))
      .catch(() => { if (ws) disconnect(); });
  }
  /** Проверяет native params/result; тайм-аут мутации означает unknown. */
  async function call(method: string, params: any, options: { mutation?: boolean; timeoutMs?: number } = {}) {
    const definition = methods.get(method), mutation = options.mutation === true;
    if (!definition || !definition.params(params)) throw fail('INVALID_ARGUMENT');
    if (pending.size >= limits.pending) throw fail('CAPACITY_EXHAUSTED');
    const id = ++nextId;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => settle(id, fail('TIMEOUT', mutation ? 'unknown' : 'query')), options.timeoutMs ?? (mutation ? 12000 : 10000));
      pending.set(id, { method, mutation, resolve, reject, timer });
      void send({ id, method, params }, mutation).catch(error => settle(id, error));
    });
  }
  function receive(data: WebSocket.RawData) {
    let packet: any;
    try { packet = JSON.parse(data.toString()); } catch { disconnect(); return; }
    if (!packet || typeof packet !== 'object') { disconnect(); return; }
    if (typeof packet.method === 'string') {
      if (Object.hasOwn(packet, 'id')) {
        if (typeof packet.id !== 'string' && typeof packet.id !== 'number') { disconnect(); return; }
        // AIDEV-NOTE: Brai не регистрирует dynamicTools. Их выполняет объявивший их клиент
        // (например, Codex app); наш отказ мог бы выиграть гонку ответов и сорвать вызов.
        if (packet.method === 'item/tool/call') return;
        const definition = definitions.get(packet.method);
        const reason = !definition ? 'unsupported-method'
          : bytes(packet.params) > limits.request ? 'request-too-large'
            : !definition.params(packet.params) ? 'invalid-params'
              : requests.size >= limits.pending && !requests.has(packet.id) ? 'too-many-pending'
                : undefined;
        if (reason) { rejectUnsupported(packet.id, packet.method, packet.params, reason); return; }
        requests.set(packet.id, definition!.answer);
        notify({ type: 'request', id: packet.id, method: packet.method, params: packet.params, supported: true });
      } else {
        const validate = notifications.get(packet.method);
        if (!validate) return;
        if (!validate(packet.params)) { disconnect(); return; }
        if (packet.method === 'serverRequest/resolved') requests.delete(packet.params.requestId);
        if (packet.method === 'account/updated') authorization = packet.params.authMode ? 'ready' : 'required';
        notify({ type: 'notification', method: packet.method, params: packet.params });
      }
      return;
    }
    const value = pending.get(packet.id);
    if (!value) return;
    if (packet.error) settle(packet.id, Object.assign(fail('UPSTREAM_UNAVAILABLE', value.mutation ? 'unknown' : 'query'), { upstreamCode: Number.isSafeInteger(packet.error.code) ? packet.error.code : undefined }));
    else if (!methods.get(value.method)!.result(packet.result)) settle(packet.id, fail('UPSTREAM_UNAVAILABLE', value.mutation ? 'unknown' : 'query'));
    else settle(packet.id, undefined, packet.result);
  }
  /** Инициализирует новое поколение и безопасно проверяет авторизацию. */
  function connect(): Promise<void> {
    if (ready || closed) return Promise.resolve();
    if (connection) return connection;
    connection = (async () => {
      if (!/^ws\+unix:\/.+:\/$/.test(options.socketUrl)) throw fail('INVALID_ARGUMENT');
      generation = randomUUID();
      // AIDEV-NOTE: История page10 может содержать десять image сообщений; исходящий предел остаётся 2 MiB.
      const socket = new WebSocket(options.socketUrl, { maxPayload: 16777216 });
      ws = socket;
      socket.on('message', data => { if (ws === socket) receive(data); });
      socket.on('close', () => { if (ws === socket) disconnect(); });
      socket.on('error', () => { if (ws === socket) disconnect(); });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { socket.terminate(); reject(fail('TIMEOUT')); }, 10000);
          socket.once('open', () => { clearTimeout(timer); resolve(); });
          socket.once('error', () => { clearTimeout(timer); reject(fail('UPSTREAM_UNAVAILABLE')); });
        });
        await call('initialize', { clientInfo: { name: 'brai_agent', version: '3.0.0' }, capabilities: { experimentalApi: true } });
        await send({ method: 'initialized', params: {} }, false);
        const account = await call('account/read', { refreshToken: false });
        authorization = account.account ? 'ready' : 'required';
        ready = true;
        notify({ type: 'connection', status: status() });
      } catch (error) { if (ws === socket) disconnect(); throw error; }
    })().finally(() => { connection = undefined; });
    return connection;
  }
  /** Отвечает исходному RPC ID после native schema validation, без повторов. */
  async function respond(id: string | number, answer: unknown) {
    if (!requests.get(id)?.(answer)) throw fail('INVALID_ARGUMENT');
    await send({ id, result: answer }, true);
  }
  async function reject(id: string | number, reason: ServerRequestRejection) {
    if (!requests.has(id)) throw fail('STALE_REQUEST');
    try { await send({ id, error: rejection(reason) }, false); }
    catch (error) { if (ws) disconnect(); throw error; }
    requests.delete(id);
  }
  return { call, connect, respond, reject, status, invalidate: disconnect, validateAnswer: (id: string | number, answer: unknown) => Boolean(requests.get(id)?.(answer)), subscribe(listener: (event: Observation) => void) { listeners.add(listener); return () => listeners.delete(listener); }, async close() { closed = true; disconnect(); } };
}
