// ABOUTME: Предоставляет MCP-инструменты GameCore через Streamable HTTP.
// ABOUTME: Владелец MCP фиксируется конфигурацией и не берётся из аргументов модели.
import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import type { GameCoreHandlers } from "./domain.js";
import type { LoadGate } from "./load.js";
import { PlanningFault } from './planning.js';

export const toolNames = ["game_core_structure_create", "game_core_element_create", "game_core_element_revise", "game_core_element_reclassify", "game_core_move_create", "game_core_move_link", "game_core_element_activate", "game_core_graph_get", "game_core_timeline_get", "game_core_moves_available", "game_core_move_claim", "game_core_move_complete", "game_core_move_fail", "game_core_planning_packet", "game_core_planning_bind", "game_core_planning_build", "game_core_planning_apply", "game_core_planning_expand_repeat"] as const;
type ToolName = typeof toolNames[number];
const operation: Record<ToolName, keyof GameCoreHandlers> = {game_core_planning_packet: "planningPacket", game_core_planning_bind: "planningBind", game_core_planning_build: "planningBuild", game_core_planning_apply: "planningApply", game_core_element_reclassify: "elementReclassify", game_core_planning_expand_repeat: "planningExpandRepeat",  game_core_structure_create: "structureCreate", game_core_element_create: "elementCreate", game_core_element_revise: "elementRevise", game_core_move_create: "moveCreate", game_core_move_link: "moveLink", game_core_element_activate: "elementActivate", game_core_graph_get: "graphGet", game_core_timeline_get: "timelineGet", game_core_moves_available: "movesAvailable", game_core_move_claim: "moveClaim", game_core_move_complete: "moveComplete", game_core_move_fail: "moveFail" };
const descriptions: Record<ToolName, string> = {game_core_planning_packet: "Прочитать пакет текущей постановки: входы, фактический уровень и точная версия правил.", game_core_planning_bind: "Зафиксировать независимые критерии до первого кандидата. baseline.inputs содержит SHA256 каждого файла пакета; requirements[].source_file указывает файл, а quote — его точную непустую цитату. При INVALID_ARGUMENT читайте diagnostic.phase/reason и исправляйте отклонённые критерии по тому же пакету; после успешного bind критерии неизменны.", game_core_planning_build: "Собрать предметный кандидат принятым сборщиком 9.2. При OUTCOME_UNKNOWN сохраните attempt_id и исходный кандидат; перед любым повтором прочитайте game_core_timeline_get и сверьте result.planning.candidate/candidate_sha256/applied этой точной попытки, затем текущую ревизию через game_core_graph_get.", game_core_planning_apply: "Проверить независимую рецензию 1.3 и атомарно применить план; не подтверждает Игрока.", game_core_element_reclassify: "Уточнить уровень только начального корневого черновика до постановки; передайте основание классификации.", game_core_planning_expand_repeat: "Раскрыть подтверждённый повтор по фактическому ресурсу в конкретные Элементы с сохранением связи.",  game_core_structure_create: "Создать GameCore и Moves атомарно по указанным схемам. Для связей внутри batch задайте UUID id новых записей и используйте их в element_id/target_element_id/previous_move_id; родители и предшественники создаются раньше. Существующие записи требуют их реальных UUID. Element требует kind; подтверждение плана — Move kind=action,purpose=confirm. executor_kind/stage/status при создании не передаются.", game_core_element_create: "Создать Element.", game_core_element_revise: "Создать неизменяемую ревизию Element.", game_core_move_create: "Создать Action или Operation с JSON Schema результата.", game_core_move_link: "Вставить доработку и повторное рассмотрение после замечаний Игрока.", game_core_element_activate: "Активировать Element либо явно отменить ненужное продолжение.", game_core_graph_get: "Получить карту GameCore и Moves.", game_core_timeline_get: "Получить ленту попыток выполнения с полным result. Для сверки неизвестного исхода planning build/apply найдите точный attempt_id и result.planning.candidate/candidate_sha256/applied; отсутствие результата нельзя заменять повтором мутации без сверки состояния.", game_core_moves_available: "Получить доступные Moves.", game_core_move_claim: "Начать попытку выполнения Move.", game_core_move_complete: "Принять и проверить результат попытки.", game_core_move_fail: "Завершить попытку с ошибкой для повторного запуска." };
const uuid = { type: "string", format: "uuid" };
const elementCreateInput: Tool["inputSchema"] = { type: "object", additionalProperties: false, properties: { id: uuid, revision: uuid, initial_resources: { type: "array", items: { type: "object" } }, fields: { type: "object" }, kind: { enum: ["level", "mission", "quest", "goal", "task"] }, parent_id: { anyOf: [uuid, { type: "null" }] }, title: { type: "string" }, description: { type: "string" }, result_spec: { type: "object" } }, required: ["kind", "title"] };
const moveCreateInput: Tool["inputSchema"] = { type: "object", additionalProperties: false, properties: { id: uuid, element_id: uuid, target_element_id: uuid, previous_move_id: { anyOf: [uuid, { type: "null" }] }, purpose: { enum: ["work","plan","start","accept","finish","confirm","review","final"] }, conditions: { type: "object" }, fields: { type: "object" }, kind: { enum: ["action", "operation"] }, title: { type: "string" }, instructions: { type: "string" }, result_schema: { type: "object" } }, required: ["element_id", "kind", "title", "instructions", "result_schema"] };
export const toolInputs: Record<ToolName, Tool["inputSchema"]> = {
  game_core_planning_packet: {"type": "object", "additionalProperties": false, "properties": {"attempt_id": {"type": "string", "format": "uuid"}}, "required": ["attempt_id"]},
  game_core_planning_bind: {"type": "object", "additionalProperties": false, "properties": {"attempt_id": {"type": "string", "format": "uuid"}, "baseline": {"type": "object"}}, "required": ["attempt_id", "baseline"]},
  game_core_planning_build: {"type": "object", "additionalProperties": false, "properties": {"attempt_id": {"type": "string", "format": "uuid"}, "candidate": {"type": "object"}}, "required": ["attempt_id", "candidate"]},
  game_core_planning_apply: {"type": "object", "additionalProperties": false, "properties": {"attempt_id": {"type": "string", "format": "uuid"}, "candidate_sha256": {"type": "string", "pattern": "^[0-9a-f]{64}$"}, "review": {"type": "object"}}, "required": ["attempt_id", "candidate_sha256", "review"]},
  game_core_element_reclassify: {type: "object", additionalProperties: false, properties: {element_id: uuid, expected_revision_id: uuid, target_kind: {enum: ["task", "goal", "quest"]}, idempotency_key: {type: "string", minLength: 1, maxLength: 200}, reason: {type: "string", minLength: 1, maxLength: 4000}}, required: ["element_id", "expected_revision_id", "target_kind", "idempotency_key", "reason"]},
  game_core_planning_expand_repeat: {type: "object", additionalProperties: false, properties: {move_id: uuid, revision_id: uuid, resource_id: uuid, items: {type: "array", minItems: 1, maxItems: 500, items: {type: "object", additionalProperties: false, properties: {id: uuid, label: {type: "string", minLength: 1, maxLength: 1000}}, required: ["id", "label"]}}, idempotency_key: {type: "string", minLength: 1, maxLength: 200}}, required: ["move_id", "revision_id", "resource_id", "items", "idempotency_key"]},
  game_core_structure_create: { type: "object", additionalProperties: false, properties: { elements: { type: "array", items: elementCreateInput }, moves: { type: "array", items: moveCreateInput }, links: { type: "array", items: { type: "object" } } }, required: ["elements", "moves"] },
  game_core_element_create: elementCreateInput,
  game_core_element_revise: { type: "object", additionalProperties: false, properties: { fields: { type: "object" }, revision_id: uuid, element_id: uuid, title: { type: "string" }, description: { type: "string" }, result_spec: { type: "object" } }, required: ["element_id", "revision_id", "title"] },
  game_core_move_create: moveCreateInput,
  game_core_move_link: { type: "object", additionalProperties: false, properties: { after_move_id: uuid, before_move_id: uuid, moves: { type: "array", minItems: 2, maxItems: 2, items: { type: "object" } } }, required: ["after_move_id", "before_move_id", "moves"] },
  game_core_element_activate: { type: "object", additionalProperties: false, properties: { element_id: uuid, cancel: { type: "boolean" }, revision_id: uuid, feedback: { type: "object", additionalProperties: false, required: ["id","content","source"], properties: { id: uuid, content: { type: "string", minLength: 1, maxLength: 16000 }, source: { type: "object" } } } }, required: ["element_id"] },
  game_core_graph_get: { type: "object", additionalProperties: false, properties: { root_id: uuid, depth: { type: "integer", minimum: 0, maximum: 20 } } },
  game_core_timeline_get: { type: "object", additionalProperties: false, properties: { element_id: uuid, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" } } },
  game_core_moves_available: { type: "object", additionalProperties: false, properties: { element_id: uuid, limit: { type: "integer", minimum: 1, maximum: 100 } } },
  game_core_move_claim: { type: "object", additionalProperties: false, properties: { move_id: uuid, attempt_id: uuid, idempotency_key: { type: "string" }, executor_kind: { enum: ["human", "agent", "system"] }, executor_id: { type: ["string", "null"] }, input_resource_ids: { type: "array", uniqueItems: true, maxItems: 500, items: uuid }, target_input_resource_ids: { type: "array", uniqueItems: true, maxItems: 500, items: uuid } }, required: ["move_id", "idempotency_key", "executor_kind", "input_resource_ids"] },
  game_core_move_complete: { type: "object", additionalProperties: false, properties: { attempt_id: uuid, result: {} }, required: ["attempt_id", "result"] },
  game_core_move_fail: { type: "object", additionalProperties: false, properties: { attempt_id: uuid, error_code: { type: "string" } }, required: ["attempt_id", "error_code"] },
};
function safe(error: unknown): { code: string; message: string } { const code = error instanceof Error ? error.message : "INTERNAL"; return { code: /^[A-Z_]+$/.test(code) ? code : "INTERNAL", message: /^[A-Z_]+$/.test(code) ? code : "INTERNAL" }; }
interface Session { server: McpServer; transport: StreamableHTTPServerTransport; touched: number }
export interface McpRuntime { http: HttpServer; url: string; close(): Promise<void> }
/** Запускает MCP listener с короткими сессиями и безопасными ответами ошибок. */
export async function startMcp(config: Config, handlers: GameCoreHandlers, gate: LoadGate): Promise<McpRuntime> {
  const sessions = new Map<string, Session>(); const pending = new Set<Session>();
  async function make(): Promise<Session> {
    const server = new McpServer({ name: "brai-game-core", version: "1.0.0" }, { capabilities: { tools: { listChanged: false } } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts: config.mcpAllowedHosts, allowedOrigins: config.mcpAllowedOrigins });
    const session = { server, transport, touched: Date.now() }; pending.add(session);
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); pending.delete(session); };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolNames.map(name => ({ name, description: descriptions[name], inputSchema: toolInputs[name] })) }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const name = request.params.name as ToolName; if (!toolNames.includes(name)) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
      const args = { ...(request.params.arguments ?? {}), user_id: config.mcpOwnerId };
      try { const fn = handlers[operation[name]] as unknown as (value: unknown, context?: any) => Promise<unknown>; const value = await gate.run(context => fn(args, context), { actorId: config.mcpOwnerId }); return { content: [], structuredContent: value }; }
      catch (error) { const failure = safe(error); return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: failure.code, message: failure.message, retryable: ["BUSY", "DATABASE_UNAVAILABLE", "DEADLINE_EXCEEDED"].includes(failure.code), ...(error instanceof PlanningFault ? { diagnostic: error.diagnostic } : {}) }) }] }; }
    });
    await server.connect(transport);
    return session;
  }
  const http = createServer(async (req, res) => {
    if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
    const id = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
    let session = id ? sessions.get(id) : undefined;
    // A restarted/expired owner session must not create an uninitialized replacement for a tool call.
    if (id && !session) { res.writeHead(404).end(); return; }
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
