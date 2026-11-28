// ABOUTME: Предоставляет переносимый MCP stdio вход существующих инструментов Brai для Hermes.
// ABOUTME: Человеческие подтверждения доступны только отдельной доверенной программе.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.mjs';
import { fault, startBraiTools, planningDiagnostic } from './runtime.mjs';

const renameTopic = {
  name: 'telegram_rename_current_topic',
  description: 'Rename the current Telegram topic on explicit user request. Put an exact user-supplied name in title. If the user asks to invent a name, put a short description of the topic in text to use the Dialogues generator. Supply one field.',
  inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 128 },
    text: { type: 'string', minLength: 1 } }, oneOf: [{ required: ['title'] }, { required: ['text'] }], additionalProperties: false },
};

async function renameCurrentTopic(path, ticket, signal) {
  if (!path || typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
    throw fault('TOPIC_RENAME_CONTEXT_REQUIRED');
  }
  const result = await new Promise((resolve, reject) => {
    const connection = createConnection({ path, signal });
    let body = '';
    connection.setEncoding('utf8');
    connection.once('connect', () => connection.write(ticket + '\n'));
    connection.on('data', chunk => { body += chunk; });
    connection.once('error', reject);
    connection.once('close', () => {
      try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
    });
  });
  if (result?.ok === true && typeof result.title === 'string') return result;
  throw fault(result?.code ?? 'TOPIC_RENAME_UNCONFIRMED');
}

/** Подключает MCP к собранным портам; stdout занят только MCP. */
export async function serveTools(runtime, transport = new StdioServerTransport(), renameSocket) {
  const server = new Server({ name: 'brai-hermes', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = runtime.listTools ? await runtime.listTools() : runtime.tools;
    return { tools: renameSocket ? [...tools, renameTopic] : tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const args = request.params.arguments ?? {};
      let value;
      if (request.params.name === renameTopic.name) value = await renameCurrentTopic(renameSocket, args._topicTicket, extra.signal);
      else if (request.params.name === 'local_ai_invoke_synthesize') {
        if (Object.hasOwn(args, 'operationId')) throw fault('INVALID_ARGUMENT');
        value = await runtime.synthesizeVoice(args, extra.signal);
      }
      else value = await runtime.call(request.params.name, args, extra.signal);
      if(['dialogues_exchange','dialogues_context_ack'].includes(request.params.name)&&Array.isArray(value?.content))return value;
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code) ? error.code : 'UPSTREAM_UNAVAILABLE';
      const diagnostic = code === 'INVALID_ARGUMENT' && request.params.name.startsWith('game_core_planning_') ? planningDiagnostic(error.diagnostic) : undefined;
      const message = code === 'VOICE_TEXT_REQUIRES_CYRILLIC' ? 'Запишите английские слова и числа кириллицей, раскройте символы словами и повторите синтез.' : code;
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, ...(diagnostic ? { diagnostic } : {}), ...(code === 'OUTCOME_UNKNOWN' ? { requestId: error.requestId } : {}) }) }] };
    }
  });
  let closing, recoveryTimer, recoveryDelay = 30_000, stopped = false;
  // AIDEV-NOTE: Native Hermes обновляет registry по list_changed; stdio keepalive каталог не перечитывает.
  function scheduleRecovery() {
    if (stopped || recoveryTimer || !runtime.unavailableEndpoints?.().length) return;
    recoveryTimer = setTimeout(async () => {
      recoveryTimer = undefined;
      if (stopped || !runtime.unavailableEndpoints?.().length) return;
      const before = JSON.stringify(runtime.tools);
      try {
        await runtime.listTools();
        if (!stopped && JSON.stringify(runtime.tools) !== before) await server.sendToolListChanged();
      } catch { console.error('HERMES_DISCOVERY_REFRESH_FAILED'); }
      recoveryDelay = Math.min(300_000, recoveryDelay * 2);
      scheduleRecovery();
    }, recoveryDelay);
    recoveryTimer.unref?.();
  }
  server.oninitialized = scheduleRecovery;
  const close = () => closing ??= (async () => {
    stopped = true;
    clearTimeout(recoveryTimer);
    await runtime.close(); await server.close();
  })();
  server.onclose = () => { void close(); };
  try { await server.connect(transport); } catch (error) { await close(); throw error; }
  return { server, close };
}

// Стабильная ссылка выпуска и import.meta.url должны указывать на один файл.
let isMain = false;
try { isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); } catch {}
if (isMain) {
  try {
    const runtime = await serveTools(await startBraiTools(await loadConfig()), undefined, process.env.BRAI_TELEGRAM_RENAME_SOCKET);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void runtime.close(); });
  } catch { console.error('HERMES_TOOLS_STARTUP_FAILED'); process.exitCode = 1; }
}
