// ABOUTME: Предоставляет MCP-инструменты Elements через Streamable HTTP.
// ABOUTME: Владелец MCP фиксируется конфигурацией и не берётся из аргументов модели.
import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import type { ElementsHandlers } from "./domain.js";
import type { LoadGate } from "./load.js";

export const toolNames = ["elements_structure_create", "elements_element_create", "elements_element_revise", "elements_move_create", "elements_move_link", "elements_element_activate", "elements_graph_get", "elements_timeline_get", "elements_moves_available", "elements_move_claim", "elements_move_complete", "elements_move_fail", "elements_planning_packet", "elements_planning_bind", "elements_planning_build", "elements_planning_apply"] as const;
type ToolName = typeof toolNames[number];
const operation: Record<ToolName, keyof ElementsHandlers> = {elements_planning_packet: "planningPacket", elements_planning_bind: "planningBind", elements_planning_build: "planningBuild", elements_planning_apply: "planningApply",  elements_structure_create: "structureCreate", elements_element_create: "elementCreate", elements_element_revise: "elementRevise", elements_move_create: "moveCreate", elements_move_link: "moveLink", elements_element_activate: "elementActivate", elements_graph_get: "graphGet", elements_timeline_get: "timelineGet", elements_moves_available: "movesAvailable", elements_move_claim: "moveClaim", elements_move_complete: "moveComplete", elements_move_fail: "moveFail" };
const descriptions: Record<ToolName, string> = {elements_planning_packet: "Прочитать пакет существующей попытки постановки: входы и точная версия правил.", elements_planning_bind: "Зафиксировать независимые критерии до первого кандидата.", elements_planning_build: "Собрать предметный кандидат принятым сборщиком 9.2.", elements_planning_apply: "Проверить независимую рецензию 1.3 и атомарно применить план; не подтверждает Игрока.",  elements_structure_create: "Создать Elements и Moves атомарно по указанным схемам. Для связей внутри batch задайте UUID id новых записей и используйте их в element_id/target_element_id/previous_move_id; родители и предшественники создаются раньше. Существующие записи требуют их реальных UUID. Element требует kind; подтверждение плана — Move kind=action,purpose=confirm. executor_kind/stage/status при создании не передаются.", elements_element_create: "Создать Element.", elements_element_revise: "Создать неизменяемую ревизию Element.", elements_move_create: "Создать Action или Operation с JSON Schema результата.", elements_move_link: "Вставить доработку и повторное рассмотрение после замечаний Игрока.", elements_element_activate: "Активировать Element либо явно отменить ненужное продолжение.", elements_graph_get: "Получить карту Elements и Moves.", elements_timeline_get: "Получить ленту попыток выполнения.", elements_moves_available: "Получить доступные Moves.", elements_move_claim: "Начать попытку выполнения Move.", elements_move_complete: "Принять и проверить результат попытки.", elements_move_fail: "Завершить попытку с ошибкой для повторного запуска." };
const uuid = { type: "string", format: "uuid" };
const elementCreateInput: Tool["inputSchema"] = { type: "object", additionalProperties: false, properties: { id: uuid, revision: uuid, initial_resources: { type: "array", items: { type: "object" } }, fields: { type: "object" }, kind: { enum: ["level", "mission", "quest", "goal", "task"] }, parent_id: { anyOf: [uuid, { type: "null" }] }, title: { type: "string" }, description: { type: "string" }, result_spec: { type: "object" } }, required: ["kind", "title"] };
const moveCreateInput: Tool["inputSchema"] = { type: "object", additionalProperties: false, properties: { id: uuid, element_id: uuid, target_element_id: uuid, previous_move_id: { anyOf: [uuid, { type: "null" }] }, purpose: { enum: ["work","plan","start","accept","finish","confirm","review","final"] }, conditions: { type: "object" }, fields: { type: "object" }, kind: { enum: ["action", "operation"] }, title: { type: "string" }, instructions: { type: "string" }, result_schema: { type: "object" } }, required: ["element_id", "kind", "title", "instructions", "result_schema"] };
export const toolInputs: Record<ToolName, Tool["inputSchema"]> = {
  elements_planning_packet: {"type": "object", "additionalProperties": false, "properties": {"attempt_id": {"type": "string", "format": "uuid"}}, "required": ["attempt_id"]},
  elements_planning_bind: {"type": "object", "additionalProperties": false, "properties": {"attempt_id": {"type": "string", "format": "uuid"}, "baseline": {"type": "object"}}, "required": ["attempt_id", "baseline"]},
  elements_planning_build: {"type": "object", "additionalProperties": false, "properties": {"attempt_id": {"type": "string", "format": "uuid"}, "candidate": {"type": "object"}}, "required": ["attempt_id", "candidate"]},
  elements_planning_apply: {"type": "object", "additionalProperties": false, "properties": {"attempt_id": {"type": "string", "format": "uuid"}, "candidate_sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"}, "review": {"type": "object"}}, "required": ["attempt_id", "candidate_sha256", "review"]},
  elements_structure_create: { type: "object", additionalProperties: false, properties: { elements: { type: "array", items: elementCreateInput }, moves: { type: "array", items: moveCreateInput }, links: { type: "array", items: { type: "object" } } }, required: ["elements", "moves"] },
  elements_element_create: elementCreateInput,
  elements_element_revise: { type: "object", additionalProperties: false, properties: { fields: { type: "object" }, revision_id: uuid, element_id: uuid, title: { type: "string" }, description: { type: "string" }, result_spec: { type: "object" } }, required: ["element_id", "revision_id", "title"] },
  elements_move_create: moveCreateInput,
  elements_move_link: { type: "object", additionalProperties: false, properties: { after_move_id: uuid, before_move_id: uuid, moves: { type: "array", minItems: 2, maxItems: 2, items: { type: "object" } } }, required: ["after_move_id", "before_move_id", "moves"] },
  elements_element_activate: { type: "object", additionalProperties: false, properties: { element_id: uuid, cancel: { type: "boolean" }, revision_id: uuid, feedback: { type: "object", additionalProperties: false, required: ["id","content","source"], properties: { id: uuid, content: { type: "string", minLength: 1, maxLength: 16000 }, source: { type: "object" } } } }, required: ["element_id"] },
  elements_graph_get: { type: "object", additionalProperties: false, properties: { root_id: uuid, depth: { type: "integer", minimum: 0, maximum: 20 } } },
  elements_timeline_get: { type: "object", additionalProperties: false, properties: { element_id: uuid, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" } } },
  elements_moves_available: { type: "object", additionalProperties: false, properties: { element_id: uuid, limit: { type: "integer", minimum: 1, maximum: 100 } } },
  elements_move_claim: { type: "object", additionalProperties: false, properties: { move_id: uuid, attempt_id: uuid, idempotency_key: { type: "string" }, executor_kind: { enum: ["human", "agent", "system"] }, executor_id: { type: ["string", "null"] }, input_resource_ids: { type: "array", uniqueItems: true, maxItems: 500, items: uuid }, target_input_resource_ids: { type: "array", uniqueItems: true, maxItems: 500, items: uuid } }, required: ["move_id", "idempotency_key", "executor_kind", "input_resource_ids"] },
  elements_move_complete: { type: "object", additionalProperties: false, properties: { attempt_id: uuid, result: {} }, required: ["attempt_id", "result"] },
  elements_move_fail: { type: "object", additionalProperties: false, properties: { attempt_id: uuid, error_code: { type: "string" } }, required: ["attempt_id", "error_code"] },
};
function safe(error: unknown): { code: string; message: string } { const code = error instanceof Error ? error.message : "INTERNAL"; return { code: /^[A-Z_]+$/.test(code) ? code : "INTERNAL", message: /^[A-Z_]+$/.test(code) ? code : "INTERNAL" }; }
interface Session { server: McpServer; transport: StreamableHTTPServerTransport; touched: number }
export interface McpRuntime { http: HttpServer; url: string; close(): Promise<void> }
/** Запускает MCP listener с короткими сессиями и безопасными ответами ошибок. */
export async function startMcp(config: Config, handlers: ElementsHandlers, gate: LoadGate): Promise<McpRuntime> {
  const sessions = new Map<string, Session>(); const pending = new Set<Session>();
  async function make(): Promise<Session> {
    const server = new McpServer({ name: "brai-elements", version: "1.0.0" }, { capabilities: { tools: { listChanged: false } } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts: config.mcpAllowedHosts, allowedOrigins: config.mcpAllowedOrigins });
    const session = { server, transport, touched: Date.now() }; pending.add(session);
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); pending.delete(session); };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolNames.map(name => ({ name, description: descriptions[name], inputSchema: toolInputs[name] })) }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const name = request.params.name as ToolName; if (!toolNames.includes(name)) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
      const args = { ...(request.params.arguments ?? {}), user_id: config.mcpOwnerId };
      try { const fn = handlers[operation[name]] as unknown as (value: unknown, context?: any) => Promise<unknown>; const value = await gate.run(context => fn(args, context), { actorId: config.mcpOwnerId }); return { content: [], structuredContent: value }; }
      catch (error) { const failure = safe(error); return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: failure.code, message: failure.message, retryable: ["BUSY", "DATABASE_UNAVAILABLE", "DEADLINE_EXCEEDED"].includes(failure.code) }) }] }; }
    });
    await server.connect(transport);
    return session;
  }
  const http = createServer(async (req, res) => {
    if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
    const id = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
    let session = id ? sessions.get(id) : undefined;
    if (!session && req.method === "POST") { session = await make(); await session.transport.handleRequest(req, res); if (session.transport.sessionId) { pending.delete(session); sessions.set(session.transport.sessionId, session); } return; }
    if (!session) { res.writeHead(404).end(); return; }
    session.touched = Date.now(); await session.transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(config.mcpPort, config.mcpHost, () => { http.removeListener("error", reject); resolve(); }); });
  const address = http.address(); if (!address || typeof address === "string") throw new Error("MCP_LISTEN_FAILED");
  const urlHost = config.mcpHost.includes(":") && !config.mcpHost.startsWith("[") ? `[${config.mcpHost}]` : config.mcpHost;
  const cleanup = setInterval(() => { for (const [id, session] of sessions) if (Date.now() - session.touched > 30 * 60_000) { void session.transport.close(); sessions.delete(id); } }, 60_000); cleanup.unref();
  return { http, url: `http://${urlHost}:${address.port}/mcp`, async close() { clearInterval(cleanup); for (const session of sessions.values()) await session.transport.close().catch(() => {}); await new Promise<void>(resolve => http.close(() => resolve())); } };
}
