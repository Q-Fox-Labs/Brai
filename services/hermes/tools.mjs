// ABOUTME: Предоставляет переносимый MCP stdio вход существующих инструментов Brai для Hermes.
// ABOUTME: Человеческие подтверждения доступны только отдельной доверенной программе.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.mjs';
import { startBraiTools, planningDiagnostic } from './runtime.mjs';

/** Подключает MCP к собранным портам; stdout занят только MCP. */
export async function serveTools(runtime, transport = new StdioServerTransport()) {
  const server = new Server({ name: 'brai-hermes', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: runtime.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const args = request.params.arguments ?? {};
      const value = request.params.name === 'local_ai_invoke_synthesize'
        ? await runtime.synthesizeVoice(args, extra.signal) : await runtime.call(request.params.name, args, extra.signal);
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      const code = /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code) ? error.code : 'UPSTREAM_UNAVAILABLE';
      const diagnostic = code === 'INVALID_ARGUMENT' && request.params.name.startsWith('game_core_planning_') ? planningDiagnostic(error.diagnostic) : undefined;
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message: code, ...(diagnostic ? { diagnostic } : {}), ...(code === 'OUTCOME_UNKNOWN' ? { requestId: error.requestId } : {}) }) }] };
    }
  });
  let closing;
  const close = () => closing ??= (async () => { await runtime.close(); await server.close(); })();
  server.onclose = () => { void close(); };
  try { await server.connect(transport); } catch (error) { await close(); throw error; }
  return { server, close };
}

// Стабильная ссылка выпуска и import.meta.url должны указывать на один файл.
let isMain = false;
try { isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); } catch {}
if (isMain) {
  try {
    const runtime = await serveTools(await startBraiTools(await loadConfig()));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void runtime.close(); });
  } catch { console.error('HERMES_TOOLS_STARTUP_FAILED'); process.exitCode = 1; }
}
