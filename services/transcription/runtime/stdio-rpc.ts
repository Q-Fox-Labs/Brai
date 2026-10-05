// ABOUTME: Обеспечивает ограниченный JSON-RPC 2.0 канал UTF-8 NDJSON между программами.
// ABOUTME: Не знает прикладные DTO и не повторяет операции после потери ответа.
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

type Id = string | number | null;
type RpcResponse = { jsonrpc: '2.0'; id: Id; result: unknown } | {
  jsonrpc: '2.0'; id: Id; error: { code: number; message: string; data?: { errorCode: string } };
};

/** Проверки передаются владельцем DTO; execute имеет отдельный предел, оставляющий место control. */
export type RpcMethodMap = Readonly<Record<string, {
  validateParams: (value: unknown) => boolean;
  validateResult: (value: unknown) => boolean;
  lane?: 'execute' | 'control';
}>>;
export type RpcHandlers = Readonly<Record<string, (params: any) => unknown | Promise<unknown>>>;
/** frameBytes не включает newline; batch/concurrency обязательны, streams заменяют stdin/stdout при явной сборке. */
export type RpcServerLimits = {
  frameBytes: number;
  batchItems: number;
  concurrentRequests: number;
  concurrentExecute: number;
  applicationErrorCodes?: readonly string[];
  input?: Readable;
  output?: Writable;
};
export type RpcClientLimits = { frameBytes: number; concurrentRequests: number };
export type RpcCallError = Error & {
  code: 'RPC_TIMEOUT' | 'RPC_CLOSED' | 'RPC_PROTOCOL' | 'RPC_OVERLOADED' | 'RPC_REMOTE' | 'RPC_INVALID_ARGUMENT';
  outcome: 'unknown' | 'not_started';
  rpcCode?: number;
  errorCode?: string;
};

function positive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid RPC limits');
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is Id {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function failure(id: Id, code: number, errorCode?: string): RpcResponse {
  const message = code === -32700 ? 'Parse error' : code === -32600 ? 'Invalid Request' :
    code === -32601 ? 'Method not found' : code === -32602 ? 'Invalid params' :
      code === -32603 ? 'Internal error' : 'Server error';
  return { jsonrpc: '2.0', id, error: { code, message, ...(errorCode ? { data: { errorCode } } : {}) } };
}

// AIDEV-NOTE: Ограничение применяется до newline; отброшенный хвост не удерживается в памяти.
async function* frames(input: Readable, frameBytes: number): AsyncGenerator<string | null> {
  const frame = Buffer.allocUnsafe(frameBytes);
  let size = 0;
  let discard = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      if (!discard) {
        const partSize = end - start;
        if (size + partSize > frameBytes) {
          discard = true;
          size = 0;
          yield null;
        } else if (partSize) {
          // Один буфер ограничивает память даже при фрагментации по одному байту.
          bytes.copy(frame, size, start, end);
          size += partSize;
        }
      }
      if (newline < 0) break;
      if (!discard) {
        let decoded: string | null;
        try { decoded = decoder.decode(frame.subarray(0, size)); } catch { decoded = null; }
        size = 0;
        yield decoded;
      }
      discard = false;
      start = newline + 1;
    }
  }
  if (size) yield null; // NDJSON требует завершённую строку даже при EOF.
}

/** Сериализует JSON в ограниченный UTF-8 Buffer без newline; не усекает значения и отклоняет non-JSON данные. */
export function encodeBoundedJson(value: unknown, frameBytes: number): Buffer {
  positive(frameBytes);
  const parts: string[] = [];
  const seen = new Set<object>();
  let size = 0;
  function append(part: string): void {
    size += Buffer.byteLength(part);
    if (size > frameBytes) throw new RangeError('RPC response exceeds frame limit');
    parts.push(part);
  }
  function quoted(value: string): void {
    if (Buffer.byteLength(value) > frameBytes - size) throw new RangeError('RPC frame exceeds limit');
    append(JSON.stringify(value));
  }
  function visit(value: unknown): void {
    if (value === null) { append('null'); return; }
    if (typeof value === 'string') { quoted(value); return; }
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      append(JSON.stringify(value)); return;
    }
    if (typeof value !== 'object' || value === undefined || seen.has(value)) throw new TypeError('Non-JSON RPC value');
    seen.add(value);
    if (Array.isArray(value)) {
      append('[');
      for (let i = 0; i < value.length; i++) { if (i) append(','); visit(value[i]); }
      append(']');
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Non-JSON RPC object');
      append('{');
      let first = true;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        if (!first) append(',');
        first = false;
        quoted(key); append(':'); visit((value as Record<string, unknown>)[key]);
      }
      append('}');
    }
    seen.delete(value);
  }
  visit(value);
  return Buffer.from(parts.join(''));
}

function encode(value: unknown, frameBytes: number): Buffer {
  return Buffer.concat([encodeBoundedJson(value, frameBytes), Buffer.from('\n')]);
}

function writer(output: Writable): (bytes: Buffer, wanted?: () => boolean) => Promise<void> {
  let tail = Promise.resolve();
  return (bytes, wanted = () => true) => {
    const next = tail.then(() => {
      if (!wanted()) return;
      return new Promise<void>((resolve, reject) => {
        if (output.destroyed || output.writableEnded) { reject(new Error('RPC output closed')); return; }
        // write callback ждёт фактического потребления; следующая запись не обходит backpressure.
        output.write(bytes, (error) => error ? reject(error) : resolve());
      });
    });
    tail = next.catch(() => undefined);
    return next;
  };
}

/**
 * Обслуживает канал до EOF и завершения ответов; raw ошибки handlers не попадают в stdout.
 * Большой входной кадр получает parse error до newline, его хвост отбрасывается.
 * Пакет сверх batchItems не выполняется: валидные вызовы получают OVERLOADED с прежним id,
 * уведомления остаются без ответа. Невместимый ответ закрывает канал без усечения id/результата.
 */
export async function serveRpc(methods: RpcMethodMap, handlers: RpcHandlers, limits: RpcServerLimits): Promise<void> {
  for (const limit of [limits.frameBytes, limits.batchItems, limits.concurrentRequests, limits.concurrentExecute]) positive(limit);
  if (limits.concurrentExecute >= limits.concurrentRequests) throw new TypeError('RPC control capacity required');
  const input = limits.input ?? process.stdin;
  const output = limits.output ?? process.stdout;
  const write = writer(output);
  const allowedErrors = new Set(limits.applicationErrorCodes ?? []);
  const running = new Set<Promise<void>>();
  let active = 0;
  let executing = 0;
  let outputFailed = false;
  const outputError = () => { outputFailed = true; input.destroy(); };
  output.on('error', outputError);

  async function request(value: unknown, overloaded = false): Promise<RpcResponse | undefined> {
    if (!object(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' ||
      Object.keys(value).some((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key)) ||
      (Object.hasOwn(value, 'id') && !validId(value.id))) return failure(null, -32600);
    const notification = !Object.hasOwn(value, 'id');
    const id = notification ? null : value.id as Id;
    const reply = (response: RpcResponse) => notification ? undefined : response;
    const method = Object.hasOwn(methods, value.method) ? methods[value.method] : undefined;
    if (!method || !Object.hasOwn(handlers, value.method)) return reply(failure(id, -32601));
    const params = value.params;
    try {
      if ((params !== undefined && !object(params) && !Array.isArray(params)) || !method.validateParams(params)) {
        return reply(failure(id, -32602));
      }
    } catch { return reply(failure(id, -32602)); }
    const execute = method.lane === 'execute';
    if (overloaded || active >= limits.concurrentRequests || (execute && executing >= limits.concurrentExecute)) {
      return reply(failure(id, -32000, 'OVERLOADED'));
    }
    active++;
    if (execute) executing++;
    try {
      const result = await handlers[value.method](params);
      if (!method.validateResult(result)) return reply(failure(id, -32603));
      if (notification) return undefined;
      const response: RpcResponse = { jsonrpc: '2.0', id, result };
      try { encode(response, limits.frameBytes); } catch { return failure(id, -32603); }
      return response;
    } catch (error) {
      const code = object(error) && typeof error.errorCode === 'string' && allowedErrors.has(error.errorCode) ? error.errorCode : undefined;
      return reply(failure(id, code ? -32000 : -32603, code));
    } finally {
      active--;
      if (execute) executing--;
    }
  }

  async function frame(line: string | null): Promise<void> {
    let value: unknown;
    try { if (line === null) throw new Error(); value = JSON.parse(line); }
    catch { await write(encode(failure(null, -32700), limits.frameBytes)); return; }
    let response: RpcResponse | RpcResponse[] | undefined;
    if (Array.isArray(value)) {
      if (!value.length) response = failure(null, -32600);
      else {
        let replies: RpcResponse[];
        if (value.length > limits.batchItems) {
          replies = [];
          let bytes = 2;
          // Большой пакет не порождает Promise на каждый элемент и не выполняет handlers.
          for (const entry of value) {
            const reply = await request(entry, true);
            if (reply !== undefined) {
              bytes += encode(reply, limits.frameBytes).length;
              if (bytes > limits.frameBytes) throw new RangeError('RPC batch response exceeds frame limit');
              replies.push(reply);
            }
          }
        } else {
          const results = await Promise.all(value.map((entry) => request(entry)));
          replies = results.filter((entry): entry is RpcResponse => entry !== undefined);
        }
        response = replies.length ? replies : undefined;
      }
    } else response = await request(value);
    if (response !== undefined) await write(encode(response, limits.frameBytes));
  }

  let failed = false;
  try {
    for await (const line of frames(input, limits.frameBytes)) {
      if (outputFailed) break;
      while (running.size >= limits.concurrentRequests) await Promise.race(running);
      const job = frame(line).catch(() => { failed = true; input.destroy(); }).finally(() => running.delete(job));
      running.add(job);
    }
  } catch { failed = true; }
  await Promise.all(running);
  output.off('error', outputError);
  if (failed || outputFailed) throw new Error('RPC channel failed');
}

function callError(code: RpcCallError['code'], outcome: RpcCallError['outcome']): RpcCallError {
  return Object.assign(new Error(code), { code, outcome });
}

/** Сопоставляет concurrent ответы по строковому id; deadline/exit означают неизвестный исход, без повторов. */
export class RpcClient {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: RpcCallError) => void;
    timer: ReturnType<typeof setTimeout>;
    sent: boolean;
    deadlineAt: number;
  }>();
  private readonly write: ReturnType<typeof writer>;
  private sequence = 0;
  private queuedWrites = 0;
  private closed = false;
  private readonly processExit = () => this.fail('RPC_CLOSED');
  private readonly streamError = () => this.fail('RPC_CLOSED');

  /** input — stdout дочерней программы, output — её stdin; process нужен для раннего обнаружения crash. */
  constructor(private readonly io: { input: Readable; output: Writable; process?: ChildProcess }, private readonly limits: RpcClientLimits) {
    positive(limits.frameBytes); positive(limits.concurrentRequests);
    this.write = writer(io.output);
    io.output.on('error', this.streamError);
    io.input.on('error', this.streamError);
    io.process?.on('exit', this.processExit);
    io.process?.on('error', this.processExit);
    void this.read();
  }

  /** Отправляет один named-params вызов. deadlineAt — конечное время UTC epoch-ms; операция не отменяется по timeout. */
  call<T = unknown>(method: string, params: Record<string, unknown>, options: { deadlineAt: number }): Promise<T> {
    if (this.closed) return Promise.reject(callError('RPC_CLOSED', 'not_started'));
    if (typeof method !== 'string' || !object(params) || !Number.isSafeInteger(options.deadlineAt)) {
      return Promise.reject(callError('RPC_INVALID_ARGUMENT', 'not_started'));
    }
    let delay = options.deadlineAt - Date.now();
    if (delay <= 0) return Promise.reject(callError('RPC_TIMEOUT', 'not_started'));
    if (this.pending.size >= this.limits.concurrentRequests || this.queuedWrites >= this.limits.concurrentRequests) {
      return Promise.reject(callError('RPC_OVERLOADED', 'not_started'));
    }
    const id = String(++this.sequence);
    let bytes: Buffer;
    try { bytes = encode({ jsonrpc: '2.0', id, method, params }, this.limits.frameBytes); }
    catch { return Promise.reject(callError('RPC_INVALID_ARGUMENT', 'not_started')); }
    delay = options.deadlineAt - Date.now();
    if (delay <= 0) return Promise.reject(callError('RPC_TIMEOUT', 'not_started'));
    return new Promise<T>((resolve, reject) => {
      // AIDEV-NOTE: Node ограничивает один таймер; срезы сохраняют исходный deadline без повтора вызова.
      const expire = (): void => {
        const remaining = pending.deadlineAt - Date.now();
        if (remaining > 0) {
          pending.timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
          return;
        }
        this.pending.delete(id);
        reject(callError('RPC_TIMEOUT', pending.sent ? 'unknown' : 'not_started'));
      };
      const pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        sent: false,
        deadlineAt: options.deadlineAt,
        timer: setTimeout(expire, Math.min(delay, 2_147_483_647)),
      };
      this.pending.set(id, pending);
      this.queuedWrites++;
      void this.write(bytes, () => {
        if (!this.pending.has(id) || this.closed) return false;
        // AIDEV-NOTE: Таймер может ещё не выполниться после задержки event loop; просроченный queued вызов не отправляем.
        if (Date.now() >= pending.deadlineAt) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          reject(callError('RPC_TIMEOUT', 'not_started'));
          return false;
        }
        pending.sent = true;
        return true;
      }).catch(() => this.fail('RPC_CLOSED')).finally(() => this.queuedWrites--);
    });
  }

  /** Закрывает свои streams и отклоняет in-flight вызовы; не заявляет остановку уже начатых операций. */
  close(): void {
    this.fail('RPC_CLOSED');
    this.io.output.end();
    this.io.input.destroy();
  }

  private fail(code: 'RPC_CLOSED' | 'RPC_PROTOCOL'): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(callError(code, pending.sent ? 'unknown' : 'not_started'));
    }
    this.pending.clear();
    this.io.process?.off('exit', this.processExit);
    this.io.process?.off('error', this.processExit);
  }

  private async read(): Promise<void> {
    try {
      for await (const line of frames(this.io.input, this.limits.frameBytes)) {
        if (this.closed) return;
        let value: unknown;
        try { if (line === null) throw new Error(); value = JSON.parse(line); }
        catch { this.fail('RPC_PROTOCOL'); return; }
        const values = Array.isArray(value) ? value : [value];
        if (!values.length) { this.fail('RPC_PROTOCOL'); return; }
        for (const response of values) {
          if (!object(response) || response.jsonrpc !== '2.0' || typeof response.id !== 'string' ||
            Object.keys(response).some((key) => !['jsonrpc', 'id', 'result', 'error'].includes(key)) ||
            Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')) { this.fail('RPC_PROTOCOL'); return; }
          if (Object.hasOwn(response, 'error') && (!object(response.error) || !Number.isInteger(response.error.code) ||
            typeof response.error.message !== 'string' || Object.keys(response.error).some((key) => !['code', 'message', 'data'].includes(key)) ||
            (Object.hasOwn(response.error, 'data') && (!object(response.error.data) ||
              Object.keys(response.error.data).some((key) => key !== 'errorCode') || typeof response.error.data.errorCode !== 'string')))) {
            this.fail('RPC_PROTOCOL'); return;
          }
          const pending = this.pending.get(response.id);
          if (!pending) continue; // Поздний ответ истёкшего вызова не запускает повтор и не портит соседние вызовы.
          this.pending.delete(response.id);
          clearTimeout(pending.timer);
          if (Date.now() >= pending.deadlineAt) {
            pending.reject(callError('RPC_TIMEOUT', pending.sent ? 'unknown' : 'not_started'));
            continue;
          }
          if (Object.hasOwn(response, 'error')) {
            const wireError = response.error as { code: number; data?: { errorCode: string } };
            const beforeDispatch = [-32700, -32600, -32601, -32602].includes(wireError.code);
            pending.reject(Object.assign(callError('RPC_REMOTE', beforeDispatch ? 'not_started' : 'unknown'), {
              rpcCode: wireError.code, ...(wireError.data ? { errorCode: wireError.data.errorCode } : {}),
            }));
          } else pending.resolve(response.result);
        }
      }
      this.fail('RPC_CLOSED');
    } catch { this.fail('RPC_CLOSED'); }
  }
}
