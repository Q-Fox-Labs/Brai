// ABOUTME: Подключает Hermes к готовым MCP и фиксированным NATS API Brai.
// ABOUTME: Не повторяет операции автоматически и не выдаёт модели человеческие полномочия.
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connect, ServiceErrorHeader, ServiceErrorCodeHeader } from 'nats';
import { compileInput, natsTools, elementsNames, historyNames, transcriptionNames } from './catalog.mjs';
import { planningReadTool, readPlanningPacket } from './planning-read.mjs';

const MAX_REQUEST_BYTES = 65_536, MAX_RESPONSE_BYTES = 1_048_576;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** Создаёт безопасную ошибку порта без адресов, credentials или содержимого входа. */
export function fault(code, details = {}) { return Object.assign(new Error(code), { code, ...details }); }

/** Извлекает owner DTO; upstream MCP ошибки сохраняют только безопасный код. */
export function unwrap(result) {
  if (result.isError) {
    let code = 'UPSTREAM_ERROR';
    for (const item of result.content ?? []) {
      if (item.type !== 'text') continue;
      try { const parsed = JSON.parse(item.text); if (/^[A-Z][A-Z0-9_]{0,80}$/.test(parsed.code ?? parsed.errorCode)) code = parsed.code ?? parsed.errorCode; }
      catch { if (/^[A-Z][A-Z0-9_]{0,80}$/.test(item.text)) code = item.text; }
    }
    throw fault(code);
  }
  if (object(result.structuredContent)) return result.structuredContent;
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (text) { try { return JSON.parse(text); } catch {} }
  throw fault('INVALID_UPSTREAM_RESPONSE');
}

/** Reconnect only for the next explicit call; never replay a request with unknown effects. */
export async function connectMcpEndpoint(endpoint, { timeout = 12_000, callTimeout = 300_000 } = {}) {
  let current, opening, closed = false;
  const clients = new Set();
  async function client() {
    if (closed) throw fault('CANCELLED');
    if (current) return current;
    if (!opening) opening = (async () => {
      const next = new Client({ name: 'brai-hermes-owner', version: '1.0.0' });
      clients.add(next);
      try {
        await next.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
          requestInit: { headers: endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {} },
        }), { timeout });
        if (closed) throw fault('CANCELLED');
        current = next;
        return next;
      } catch (error) {
        await next.close().catch(() => {}); clients.delete(next); throw error;
      } finally { opening = undefined; }
    })();
    return opening;
  }
  async function invoke(method, ...args) {
    const selected = await client();
    try { return await selected[method](...args); }
    catch (error) {
      // Owner business failures are unwrapped later. Only broken protocol/transport invalidates this generation.
      if ((typeof error.code === 'number' && error.code >= 400 && error.code <= 599)
          || typeof error.code !== 'string' || uncertain(error)) {
        if (current === selected) current = undefined;
        // A delayed failure from an older generation cannot close the replacement client.
        await selected.close().catch(() => {}); clients.delete(selected);
      }
      throw error;
    }
  }
  await client();
  return {
    list: () => invoke('listTools', {}, { timeout }),
    call: (name, args, signal) => invoke('callTool', { name, arguments: args }, undefined, { signal, timeout: callTimeout }),
    async close() { closed = true; await opening?.catch(() => {}); await Promise.allSettled([...clients].map(value => value.close())); clients.clear(); current = undefined; },
  };
}

/** Подключает реальные клиенты; publisher запускается независимо от основного Agent. */
export async function connectPorts(config) {
  const clients = [], timeout = config.requestTimeoutMs ?? 12_000;
  let nc;
  try {
    const endpoints = {};
    for (const name of ['elements', 'history', 'transcription']) {
      const endpoint = config[name];
      const endpointClient = await connectMcpEndpoint(endpoint, { timeout, callTimeout: config.longRequestTimeoutMs ?? 300_000 });
      clients.push(endpointClient);
      endpoints[name] = endpointClient;
    }
    const publisher = new Client({ name: 'brai-hermes-files', version: '1.0.0' });
    clients.push(publisher);
    await publisher.connect(new StdioClientTransport({ command: process.execPath,
      args: [config.publisher.entrypoint ?? fileURLToPath(new URL('../agent/dist/publisher-mcp.js', import.meta.url))],
      env: { PATH: process.env.PATH ?? '', BRAI_AGENT_PUBLISHER_CONFIG: config.publisher.configPath, BRAI_AGENT_OWNER_ID: config.ownerId }, stderr: 'inherit',
    }), { timeout });
    endpoints.publisher = publisher;
    nc = await connect({ servers: config.nats.servers, user: config.nats.user, pass: config.nats.password,
      inboxPrefix: config.nats.inboxPrefix ?? '_INBOX.brai_hermes', name: 'brai-hermes-tools', timeout: 5000 });
    const js = nc.jetstream();
    return {
      async list(name) { return (await (name === 'publisher' ? endpoints[name].listTools({}, { timeout }) : endpoints[name].list())).tools; },
      async mcp(name, tool, args, signal) {
        return unwrap(await (name === 'publisher'
          ? endpoints[name].callTool({ name: tool, arguments: args }, undefined, { signal, timeout: 1_800_000 })
          : endpoints[name].call(tool, args, signal)));
      },
      async request(subject, payload, signal, requestTimeout = timeout) {
        signal?.throwIfAborted();
        const data = Buffer.from(JSON.stringify(payload));
        if (data.length > MAX_REQUEST_BYTES) throw fault('REQUEST_TOO_LARGE');
        const reply = await nc.request(subject, data, { timeout: requestTimeout });
        signal?.throwIfAborted();
        const code = reply.headers?.get(ServiceErrorHeader), status = reply.headers?.get(ServiceErrorCodeHeader);
        if (Boolean(code) !== Boolean(status) || status && !/^[45][0-9]{2}$/.test(status)) throw fault('INVALID_UPSTREAM_RESPONSE');
        if (code) throw fault(/^[A-Z][A-Z0-9_]{0,80}$/.test(code) ? code : 'UPSTREAM_ERROR');
        if (reply.data.length > MAX_RESPONSE_BYTES) throw fault('RESULT_TOO_LARGE');
        try { return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(reply.data)); }
        catch { throw fault('INVALID_UPSTREAM_RESPONSE'); }
      },
      async publish(subject, payload, signal) {
        signal?.throwIfAborted();
        const data = Buffer.from(JSON.stringify(payload));
        if (data.length > MAX_REQUEST_BYTES) throw fault('REQUEST_TOO_LARGE');
        // AIDEV-NOTE: Msg-Id не ставится: изменённый payload с прежним commandId обязан дойти до owner ledger.
        await js.publish(subject, data, { timeout });
        signal?.throwIfAborted();
      },
      async close() { await Promise.allSettled(clients.map(client => client.close())); await nc.close(); },
    };
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.close())); await nc?.close(); throw error;
  }
}

function uncertain(error) {
  return typeof error.code !== 'string' || ['TIMEOUT', '503', 'CANCELLED', 'ECONNRESET', 'CONNECTION_CLOSED', 'DEADLINE_EXCEEDED', 'INVALID_UPSTREAM_RESPONSE'].includes(error.code) || error.name === 'AbortError';
}
function hasOwner(value) { return ['ownerId', 'owner_id', 'userId', 'user_id', 'principal', 'permissions'].some(key => Object.hasOwn(value, key)); }

/** Собирает owner-bound каталог; подставные порты позволяют проверить запреты без живых соседей. */
export async function createBraiTools(config, ports) {
  const remote = new Map(), tools = [];
  for (const [endpoint, allow] of [['elements', elementsNames], ['history', historyNames], ['transcription', transcriptionNames], ['publisher', new Set(['publish_file', 'fetch_file'])]]) {
    for (const tool of await ports.list(endpoint)) {
      if (!allow.has(tool.name)) continue;
      const visible = structuredClone(tool);
      if (visible.name === 'elements_move_claim') {
        visible.inputSchema.properties.executor_kind = { const: 'agent' };
        delete visible.inputSchema.properties.executor_id;
      }
      remote.set(tool.name, { endpoint, tool: visible, validate: compileInput(visible.inputSchema) });
      tools.push(visible);
    }
  }
  for (const definition of natsTools) tools.push({ name: definition.name, description: definition.description, inputSchema: definition.inputSchema });
  const humanRequest = { name: 'elements_request_human_action', description: 'Прочитать Action для отправки подтверждения через brai_telegram_request_confirmation. Этот вызов не начинает и не подтверждает человеческую попытку.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['moveId'], properties: { moveId: { type: 'string', format: 'uuid' } } } };
  const validateHumanRequest = compileInput(humanRequest.inputSchema);
  tools.push(humanRequest);
  const validatePlanningRead = compileInput(planningReadTool.inputSchema);
  if (remote.has('elements_planning_packet')) tools.push(planningReadTool);
  let active = 0;
  async function elementsCall(name, args, signal) { return ports.mcp('elements', name, args, signal); }
  async function graph(signal) {
    const value = await elementsCall('elements_graph_get', {}, signal);
    if (!Array.isArray(value.moves) || !Array.isArray(value.attempts) || !Array.isArray(value.elements)) throw fault('INVALID_UPSTREAM_RESPONSE');
    if ((value.revisions ?? []).some(revision => revision.owner_id !== config.ownerId)) throw fault('OWNER_MISMATCH');
    return value;
  }
  return {
    tools, elementsCall, graph,
    /** Вызывает только объявленный инструмент; максимум восемь текущих вызовов, очереди нет. */
    async call(name, args = {}, signal) {
      if (!object(args) || hasOwner(args)) throw fault('INVALID_ARGUMENT');
      if (Buffer.byteLength(JSON.stringify(args)) > MAX_REQUEST_BYTES) throw fault('REQUEST_TOO_LARGE');
      if (active >= 8) throw fault('OVERLOADED');
      active++;
      let mutation = false;
      try {
        signal?.throwIfAborted();
        if (name === planningReadTool.name && remote.has('elements_planning_packet')) {
          if (!validatePlanningRead(args)) throw fault('INVALID_ARGUMENT');
          const packet = await elementsCall('elements_planning_packet', { attempt_id: args.attempt_id }, signal);
          return readPlanningPacket(packet, args, fault);
        }
        if (name === humanRequest.name) {
          if (!validateHumanRequest(args)) throw fault('INVALID_ARGUMENT');
          const value = await graph(signal), move = value.moves.find(move => move.id === args.moveId);
          if (!move) throw fault('NOT_FOUND');
          if (move.kind !== 'action') throw fault('FORBIDDEN');
          const target = value.elements.find(element => element.id === move.targetId);
          if (!target) throw fault('INVALID_UPSTREAM_RESPONSE');
          return { moveId: move.id, revisionId: target.revision, targetId: target.id, title: move.title, nextTool: 'brai_telegram_request_confirmation' };
        }
        const upstream = remote.get(name);
        if (upstream) {
          if (!upstream.validate(args)) throw fault('INVALID_ARGUMENT');
          if (name === 'elements_element_activate' && args.feedback !== undefined) throw fault('FORBIDDEN');
          if (name === 'elements_move_claim' && args.executor_kind !== 'agent') throw fault('FORBIDDEN');
          if (['elements_move_complete', 'elements_move_fail'].includes(name)) {
            const value = await graph(signal), attempt = value.attempts.find(attempt => attempt.id === args.attempt_id);
            const move = value.moves.find(move => move.id === attempt?.moveId);
            if (!move) throw fault('NOT_FOUND');
            if (move.kind !== 'operation' || move.executor === 'human') throw fault('FORBIDDEN');
          }
          mutation = name === 'publish_file' || /(?:_create|_revise|_reclassify|_expand_repeat|_link|_activate|_claim|_complete|_fail|_submit|_cancel|_set|_bind|_build|_apply)$/.test(name);
          return await ports.mcp(upstream.endpoint, name, args, signal);
        }
        const definition = natsTools.find(tool => tool.name === name);
        if (!definition || !definition.validateInput(args)) throw fault('INVALID_ARGUMENT');
        mutation = definition.mutation;
        const payload = { ...args };
        // Read-only global catalog/status не имеют owner в owner schema.
        if (definition.validateRequest({ ...payload, [definition.ownerKey]: config.ownerId })) payload[definition.ownerKey] = config.ownerId;
        if (!definition.validateRequest(payload)) throw fault('INVALID_ARGUMENT');
        if (definition.command) {
          await ports.publish(definition.subject, payload, signal);
          return { commandId: args.commandId, status: 'stored', outcome: 'unknown', nextTool: 'timer_command_get' };
        }
        const timeout = args.deadlineAt ? Math.min(config.longRequestTimeoutMs ?? 300_000, Math.max(1, Date.parse(args.deadlineAt) - Date.now())) : undefined;
        const value = await ports.request(definition.subject, payload, signal, timeout);
        if (!definition.validateResponse(value)) throw fault('INVALID_UPSTREAM_RESPONSE');
        if (value.userId !== undefined && value.userId !== config.ownerId) throw fault('OWNER_MISMATCH');
        if (value.ownerId !== undefined && value.ownerId !== config.ownerId) throw fault('OWNER_MISMATCH');
        return value;
      } catch (error) {
        if (mutation && uncertain(error)) throw fault('OUTCOME_UNKNOWN', { requestId: args.requestId ?? args.commandId ?? args.idempotency_key ?? args.attempt_id ?? args.revision_id ?? null });
        if (error.code && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code)) throw error;
        throw fault(signal?.aborted ? 'CANCELLED' : 'UPSTREAM_UNAVAILABLE');
      } finally { active--; }
    },
    async close() { await ports.close(); },
  };
}

/** Открывает собственные подключения Hermes, не завися от main Agent. */
export async function startBraiTools(config) {
  const ports = await connectPorts(config);
  try { return await createBraiTools(config, ports); } catch (error) { await ports.close(); throw error; }
}
