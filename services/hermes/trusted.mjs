// ABOUTME: Предоставляет private JSON-RPC stdio для файлов и Telegram подтверждений.
// ABOUTME: Запускается доверенным плагином отдельно от MCP модели; владельца не принимает.
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { loadConfig } from './config.mjs';
import { startBraiTools } from './runtime.mjs';
import { createHumanActions } from './human-actions.mjs';

const MAX_BYTES = 65_536;
const error = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

/** Исполняет один JSON-RPC документ, включая batch/notifications; ошибки не раскрывают входы. */
export function createTrustedDispatcher(runtime) {
  const human = createHumanActions(runtime);
  const methods = {
    'files.publish': args => runtime.call('publish_file', args),
    'files.fetch': args => runtime.call('fetch_file', args),
    'actions.read': args => human.read(args),
    'actions.prepare': args => human.prepare(args),
    'actions.complete': args => human.complete(args),
    'actions.cancel': args => human.cancel(args),
  };
  async function dispatch(request) {
    const object = request && typeof request === 'object' && !Array.isArray(request);
    const validId = object && (!Object.hasOwn(request, 'id') || request.id === null || typeof request.id === 'string' || typeof request.id === 'number' && Number.isFinite(request.id));
    if (!object || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !validId ||
      Object.keys(request).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) return error(validId && Object.hasOwn(request, 'id') ? request.id : null, -32600, 'Invalid Request');
    const notification = !Object.hasOwn(request, 'id');
    let response;
    if (!Object.hasOwn(methods, request.method)) response = error(request.id, -32601, 'Method not found');
    else if (request.params !== undefined && (!request.params || typeof request.params !== 'object' || Array.isArray(request.params))) response = error(request.id, -32602, 'Invalid params');
    else {
      try { response = { jsonrpc: '2.0', id: request.id, result: await methods[request.method](request.params ?? {}) }; }
      catch (failure) {
        const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(failure.code) ? failure.code : 'UPSTREAM_UNAVAILABLE';
        response = error(request.id, code === 'INVALID_ARGUMENT' ? -32602 : -32000, code, { code });
      }
    }
    return notification ? undefined : response;
  }
  return async text => {
    let value; try { value = JSON.parse(text); } catch { return error(null, -32700, 'Parse error'); }
    if (!Array.isArray(value)) return dispatch(value);
    if (!value.length) return error(null, -32600, 'Invalid Request');
    const responses = [];
    for (const request of value) { const response = await dispatch(request); if (response) responses.push(response); }
    return responses.length ? responses : undefined;
  };
}

/** Читает ограниченные JSON-RPC строки последовательно с обратным давлением на stdin/stdout. */
export async function serveTrusted(runtime, input = process.stdin, output = process.stdout) {
  const dispatch = createTrustedDispatcher(runtime);
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    let bytes = Buffer.concat([pending, Buffer.from(chunk)]), newline;
    while ((newline = bytes.indexOf(10)) !== -1) {
      const line = bytes.subarray(0, newline); bytes = bytes.subarray(newline + 1);
      if (line.length > MAX_BYTES) throw new Error('RPC_LINE_TOO_LARGE');
      const response = await dispatch(new TextDecoder('utf8', { fatal: true }).decode(line));
      if (response) {
        const encoded = JSON.stringify(response) + '\n';
        if (Buffer.byteLength(encoded) > 1_048_576) throw new Error('RPC_RESULT_TOO_LARGE');
        if (!output.write(encoded)) await once(output, 'drain');
      }
    }
    if (bytes.length > MAX_BYTES) throw new Error('RPC_LINE_TOO_LARGE');
    pending = Buffer.from(bytes);
  }
  if (pending.length) throw new Error('RPC_INCOMPLETE_LINE');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let runtime;
  try {
    runtime = await startBraiTools(await loadConfig());
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { process.stdin.destroy(); void runtime.close(); });
    await serveTrusted(runtime);
  } catch { console.error('HERMES_TRUSTED_FAILED'); process.exitCode = 1; }
  finally { await runtime?.close(); }
}
