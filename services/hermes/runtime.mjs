// ABOUTME: Подключает Hermes к готовым MCP и фиксированным NATS API Brai.
// ABOUTME: Восстанавливает безопасные чтения; записи не повторяет и human полномочий модели не выдаёт.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { connect, ServiceErrorHeader, ServiceErrorCodeHeader } from 'nats';
import { compileInput, natsTools, gameCoreNames, historyNames, transcriptionNames } from './catalog.mjs';
import { planningReadTool, readPlanningPacket } from './planning-read.mjs';
import { fileMetadataTools, fileMetadata } from './files/metadata.mjs';
import { fileConfiguration } from './files/configuration.mjs';
import { needsLegacyArtifactReviewCheck } from './confirmation.mjs';

const MAX_REQUEST_BYTES = 65_536, MAX_RESPONSE_BYTES = 1_048_576;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** Создаёт безопасную ошибку порта без адресов, credentials или содержимого входа. */
export function fault(code, details = {}) { return Object.assign(new Error(code), { code, ...details }); }

/** Принимает только ограниченную диагностику планирования, без произвольных полей владельца. */
export function planningDiagnostic(value) {
  if (!object(value) || Object.keys(value).length !== 2 ||
      !['input', 'bind', 'build', 'review', 'expand'].includes(value.phase) ||
      typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500) return undefined;
  return { phase: value.phase, reason: value.reason };
}

/** Извлекает owner DTO; только GameCore planning может передать безопасную диагностику отказа. */
export function unwrap(result, { planning = false } = {}) {
  if (result.isError) {
    let code = 'UPSTREAM_ERROR', diagnostic;
    for (const item of result.content ?? []) {
      if (item.type !== 'text') continue;
      try {
        const parsed = JSON.parse(item.text);
        if (/^[A-Z][A-Z0-9_]{0,80}$/.test(parsed.code ?? parsed.errorCode)) {
          code = parsed.code ?? parsed.errorCode;
          diagnostic = planning && code === 'INVALID_ARGUMENT' ? planningDiagnostic(parsed.diagnostic) : undefined;
        }
      } catch {
        if (/^[A-Z][A-Z0-9_]{0,80}$/.test(item.text)) { code = item.text; diagnostic = undefined; }
      }
    }
    throw fault(code, diagnostic ? { diagnostic } : {});
  }
  if (object(result.structuredContent)) return result.structuredContent;
  const text = result.content?.find(item => item.type === 'text')?.text;
  if (text) { try { return JSON.parse(text); } catch {} }
  throw fault('INVALID_UPSTREAM_RESPONSE');
}

// AIDEV-NOTE: Только явный список чтений; новое имя инструмента никогда не получает повтор автоматически.
const repeatableMcpTools = new Set(['game_core_graph_get', 'game_core_timeline_get', 'game_core_moves_available',
  'game_core_planning_packet', 'history_categories_list', 'history_types_list', 'history_type_get',
  'transcription_request_get', 'transcription_models_list', 'transcription_settings_get', 'transcription_result_get', 'fetch_file']);

/** Лениво подключает один MCP. После транспортного отказа чтение повторяется максимум раз; запись никогда. */
export async function connectMcpEndpoint(endpoint, { timeout = 12_000, callTimeout = 300_000, createTransport, endpointName = 'mcp' } = {}) {
  let current, opening, closed = false;
  const clients = new Set(), disconnectedClients = new WeakSet();
  const transport = createTransport ?? (() => new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {} },
  }));
  async function client(deadline) {
    if (closed) throw fault('CANCELLED');
    if (current) return current;
    if (!opening) opening = (async () => {
      const next = new Client({ name: 'brai-hermes-owner', version: '1.0.0' });
      next.onclose = () => { disconnectedClients.add(next); clients.delete(next); if (current === next) current = undefined; };
      clients.add(next);
      try {
        await next.connect(transport(), { timeout: Math.max(1, Math.min(timeout, deadline - Date.now())) });
        if (closed) throw fault('CANCELLED');
        current = next;
        return next;
      } catch (error) {
        await next.close().catch(() => {}); clients.delete(next); throw error;
      } finally { opening = undefined; }
    })();
    return opening;
  }
  async function invoke(method, args, signal, limit, repeatable) {
    const deadline = Date.now() + limit;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let selected;
      try {
        selected = await client(deadline);
        signal?.throwIfAborted();
        if (Date.now() >= deadline) throw fault('DEADLINE_EXCEEDED');
        const options = { signal, timeout: Math.max(1, deadline - Date.now()) };
        return method === 'listTools' ? await selected.listTools({}, options)
          : await selected.callTool(args, undefined, options);
      } catch (error) {
        const disconnected = selected && disconnectedClients.has(selected);
        if (selected && (typeof error.code !== 'string' || uncertain(error))) {
          if (current === selected) current = undefined;
          // AIDEV-NOTE: Поздняя ошибка старого поколения не закрывает новое подключение.
          await selected.close().catch(() => {}); clients.delete(selected);
        }
        // Ответы владельца isError распаковываются снаружи и не повторяются.
        const recoverable = error.code === 400 || error.code === 404 || error.code >= 500 && error.code <= 599
          || error.code === undefined && error.name !== 'AbortError' || disconnected;
        const retry = repeatable && !attempt && recoverable && !signal?.aborted && !closed && Date.now() < deadline;
        const httpStatus = Number.isInteger(error.code) && error.code >= 400 && error.code <= 599 ? error.code : undefined;
        if (httpStatus || recoverable) console.error(JSON.stringify({ event: 'hermes_mcp_transport_failure', endpoint: endpointName,
          phase: selected ? 'request' : 'connect', ...(httpStatus ? { httpStatus } : {}), retry: Boolean(retry) }));
        if (!retry) throw error;
      }
    }
  }
  return {
    list: () => invoke('listTools', {}, undefined, timeout, true),
    call: (name, args, signal) => invoke('callTool', { name, arguments: args }, signal, callTimeout, repeatableMcpTools.has(name)),
    async close() { closed = true; await opening?.catch(() => {}); await Promise.allSettled([...clients].map(value => value.close())); clients.clear(); current = undefined; },
  };
}

/** Создаёт независимые ленивые порты: отказ одного соседа не препятствует запуску остальных. */
export async function connectPorts(config) {
  const clients = [], timeout = config.requestTimeoutMs ?? 12_000;
  let nc, natsOpening, closed = false;
  async function natsConnection() {
    if (closed) throw fault('CANCELLED');
    if (nc && !nc.isClosed()) return nc;
    if (!natsOpening) natsOpening = (async () => {
      try {
        const next = await connect({ servers: config.nats.servers, user: config.nats.user, pass: config.nats.password,
          inboxPrefix: config.nats.inboxPrefix ?? '_INBOX.brai_hermes', name: 'brai-hermes-tools', timeout: 5000 });
        if (closed) { await next.close(); throw fault('CANCELLED'); }
        return nc = next;
      } finally { natsOpening = undefined; }
    })();
    return natsOpening;
  }
  try {
    const endpoints = {};
    for (const name of ['gameCore', 'history', 'transcription']) {
      const endpoint = config[name];
      const endpointClient = await connectMcpEndpoint(endpoint, { timeout, callTimeout: config.longRequestTimeoutMs ?? 300_000, endpointName: name });
      clients.push(endpointClient);
      endpoints[name] = endpointClient;
    }
    const publisher = await connectMcpEndpoint({}, { timeout, callTimeout: 1_800_000, endpointName: 'publisher',
      createTransport: () => new StdioClientTransport({ command: process.execPath,
        args: [config.publisher.entrypoint ?? fileURLToPath(new URL('../agent/dist/publisher-mcp.js', import.meta.url))],
        env: { PATH: process.env.PATH ?? '', BRAI_AGENT_PUBLISHER_CONFIG: config.publisher.configPath, BRAI_AGENT_OWNER_ID: config.ownerId }, stderr: 'inherit',
      }) });
    clients.push(publisher);
    endpoints.publisher = publisher;
    return {
      async list(name) { return (await endpoints[name].list()).tools; },
      async mcp(name, tool, args, signal) {
        return unwrap(await endpoints[name].call(tool, args, signal), { planning: name === 'gameCore' && tool.startsWith('game_core_planning_') });
      },
      async request(subject, payload, signal, requestTimeout = timeout) {
        signal?.throwIfAborted();
        const data = Buffer.from(JSON.stringify(payload));
        if (data.length > MAX_REQUEST_BYTES) throw fault('REQUEST_TOO_LARGE');
        const connection = await natsConnection();
        signal?.throwIfAborted();
        const reply = await connection.request(subject, data, { timeout: requestTimeout });
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
        const connection = await natsConnection();
        signal?.throwIfAborted();
        await connection.jetstream().publish(subject, data, { timeout });
        signal?.throwIfAborted();
      },
      async close() { closed = true; await Promise.allSettled(clients.map(client => client.close())); await natsOpening?.catch(() => {}); await nc?.close(); },
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
  const voiceDefinition = natsTools.find(tool => tool.name === 'local_ai_invoke_synthesize');
  const voiceInputSchema = { type: 'object', additionalProperties: false,
    properties: { text: voiceDefinition.inputSchema.properties.text }, required: ['text'] };
  const validateVoiceInput = compileInput(voiceInputSchema);
  const endpointTools = new Map([['gameCore', gameCoreNames], ['history', historyNames], ['transcription', transcriptionNames], ['publisher', new Set(['publish_file', 'fetch_file'])]]);
  const discovered = new Set(), discovering = new Map(), unavailable = new Set();
  for (const definition of natsTools) tools.push(definition === voiceDefinition
    ? { name: definition.name, description: 'Синтезировать текст настроенным локальным голосом. Срок и идентификаторы задаёт мост; при неизвестном исходе автоматического повтора нет.', inputSchema: voiceInputSchema }
    : { name: definition.name, description: definition.description, inputSchema: definition.inputSchema });
  const metadata = new Map(fileMetadataTools.map(tool => [tool.name, compileInput(tool.inputSchema)]));
  tools.push(...fileMetadataTools);
  const humanRequest = { name: 'game_core_request_human_action', description: 'Прочитать Action и следующий допустимый шаг. Для старого результата сначала проверь, поручал ли пользователь отдельное принятие. Этот вызов не начинает человеческую попытку.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['moveId'], properties: { moveId: { type: 'string', format: 'uuid' } } } };
  const validateHumanRequest = compileInput(humanRequest.inputSchema);
  tools.push(humanRequest);
  const validatePlanningRead = compileInput(planningReadTool.inputSchema);
  async function discoverEndpoint(endpoint) {
    if (discovered.has(endpoint)) return;
    if (!discovering.has(endpoint)) discovering.set(endpoint, (async () => {
      let listed;
      try { listed = await ports.list(endpoint); }
      catch {
        if (!unavailable.has(endpoint)) console.error(JSON.stringify({ event: 'hermes_endpoint_discovery_unavailable', endpoint }));
        unavailable.add(endpoint); return;
      }
      for (const tool of listed) {
        if (!endpointTools.get(endpoint).has(tool.name)) continue;
        const visible = structuredClone(tool);
        if (visible.name === 'game_core_move_claim') {
          visible.inputSchema.properties.executor_kind = { const: 'agent' };
          delete visible.inputSchema.properties.executor_id;
        }
        remote.set(tool.name, { endpoint, tool: visible, validate: compileInput(visible.inputSchema) });
        tools.push(visible);
      }
      if (endpoint === 'gameCore' && remote.has('game_core_planning_packet')) tools.push(planningReadTool);
      discovered.add(endpoint); unavailable.delete(endpoint);
    })().finally(() => discovering.delete(endpoint)));
    await discovering.get(endpoint);
  }
  async function listTools() {
    await Promise.all([...endpointTools.keys()].map(discoverEndpoint));
    return tools;
  }
  await listTools();
  let active = 0;
  async function gameCoreCall(name, args, signal) { return ports.mcp('gameCore', name, args, signal); }
  async function graph(signal) {
    const value = await gameCoreCall('game_core_graph_get', {}, signal);
    if (!Array.isArray(value.moves) || !Array.isArray(value.attempts) || !Array.isArray(value.elements)) throw fault('INVALID_UPSTREAM_RESPONSE');
    if ((value.revisions ?? []).some(revision => revision.owner_id !== config.ownerId)) throw fault('OWNER_MISMATCH');
    return value;
  }
  return {
    tools, listTools, unavailableEndpoints: () => [...unavailable], gameCoreCall, graph,
    filesConfiguration: () => fileConfiguration(config, fault),
    /** Один вызов Local AI с доверенной моделью и сроком от часов моста. */
    async synthesizeVoice(args, signal) {
      if (!validateVoiceInput(args) || !config.tts?.model) throw fault('INVALID_ARGUMENT');
      return this.call('local_ai_invoke_synthesize', { requestId: randomUUID(), operationId: randomUUID(),
        model: config.tts.model, deadlineAt: new Date(Date.now() + 180_000).toISOString(), text: args.text, voice: 'eugene' }, signal);
    },
    /** Вызывает только объявленный инструмент; максимум восемь текущих вызовов, очереди нет. */
    async call(name, args = {}, signal) {
      if (!object(args) || hasOwner(args)) throw fault('INVALID_ARGUMENT');
      if (Buffer.byteLength(JSON.stringify(args)) > MAX_REQUEST_BYTES) throw fault('REQUEST_TOO_LARGE');
      if (active >= 8) throw fault('OVERLOADED');
      active++;
      let mutation = false;
      try {
        signal?.throwIfAborted();
        // Точный запрос ранее известного инструмента может восстановить только его endpoint; остальные вызовы его не ждут.
        if (!remote.has(name)) {
          const endpoint = name === planningReadTool.name ? 'gameCore' : [...endpointTools].find(([, names]) => names.has(name))?.[0];
          if (endpoint && !discovered.has(endpoint)) {
            await discoverEndpoint(endpoint);
            if (!discovered.has(endpoint)) throw fault('UPSTREAM_UNAVAILABLE');
          }
        }
        if (name === planningReadTool.name && remote.has('game_core_planning_packet')) {
          if (!validatePlanningRead(args)) throw fault('INVALID_ARGUMENT');
          const packet = await gameCoreCall('game_core_planning_packet', { attempt_id: args.attempt_id }, signal);
          return readPlanningPacket(packet, args, fault);
        }
        if (name === humanRequest.name) {
          if (!validateHumanRequest(args)) throw fault('INVALID_ARGUMENT');
          const value = await graph(signal), move = value.moves.find(move => move.id === args.moveId);
          if (!move) throw fault('NOT_FOUND');
          if (move.kind !== 'action') throw fault('FORBIDDEN');
          const target = value.elements.find(element => element.id === move.targetId);
          if (!target) throw fault('INVALID_UPSTREAM_RESPONSE');
          if (needsLegacyArtifactReviewCheck(value, move, target)) return { moveId: move.id, revisionId: target.revision,
            targetId: target.id, title: move.title, nextTool: 'game_core_result_review_skip',
            instruction: 'Проверь исходное поручение: если отдельное принятие не требовалось, пропусти старое рассмотрение и заверши результат. Если оно было явно поручено, уточни или перепланируй с явным признаком принятия.' };
          return { moveId: move.id, revisionId: target.revision, targetId: target.id, title: move.title, nextTool: 'brai_telegram_request_confirmation' };
        }
        if (metadata.has(name)) {
          if (!metadata.get(name)(args)) throw fault('INVALID_ARGUMENT');
          return await fileMetadata(name, args, config.ownerId, ports.request.bind(ports), fault, signal);
        }
        const upstream = remote.get(name);
        if (upstream) {
          if (!upstream.validate(args)) throw fault('INVALID_ARGUMENT');
          if (name === 'game_core_element_activate' && args.feedback !== undefined) throw fault('FORBIDDEN');
          if (name === 'game_core_move_claim' && args.executor_kind !== 'agent') throw fault('FORBIDDEN');
          if (['game_core_move_complete', 'game_core_move_fail'].includes(name)) {
            const value = await graph(signal), attempt = value.attempts.find(attempt => attempt.id === args.attempt_id);
            const move = value.moves.find(move => move.id === attempt?.moveId);
            if (!move) throw fault('NOT_FOUND');
            if (move.kind !== 'operation' || move.executor === 'human') throw fault('FORBIDDEN');
          }
          mutation = name === 'publish_file' || /(?:_create|_revise|_reclassify|_expand_repeat|_link|_activate|_claim|_complete|_fail|_submit|_cancel|_set|_bind|_build|_apply|_skip)$/.test(name);
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
