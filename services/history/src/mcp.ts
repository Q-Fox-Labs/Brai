// ABOUTME: Предоставляет внутренний MCP по официальному Streamable HTTP SDK.
// ABOUTME: Использует owner-схемы и общий gate ядра, не закрывая ресурсы процесса.
import { createServer, type Server as HttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
import { limits, toolInputDefinitions, toolOutputDefinitions, type HistoryErrorCode, type ToolName, validateToolOutput } from "./contracts.js";
import { HistoryFault, type HistoryHandlers, type OperationContext } from "./domain.js";
import type { LoadGate } from "./load.js";

const resources = [
  { uri: "brai://history/CONTRACT.md", name: "History service contract", mimeType: "text/markdown" },
  { uri: "brai://history/schemas/common.schema.json", name: "History common DTO schemas", mimeType: "application/schema+json" },
] as const;

const descriptions: Record<ToolName, string> = {
  history_categories_list: "Постранично возвращает текущие категории истории.",
  history_types_list: "Постранично возвращает типы истории с необязательным фильтром категории.",
  history_type_get: "Возвращает тип истории по ID.",
  history_append: "Добавляет неизменяемое событие. source и actor_id заявлены вызывающей стороной.",
  history_get: "Возвращает событие по source и ID из любой области.",
  history_search: "Ищет события всех областей по фиксированным фильтрам и курсору.",
  history_category_create: "Создаёт категорию и её событие аудита атомарно.",
  history_category_update: "Меняет имя и описание категории и записывает аудит.",
  history_type_create: "Создаёт тип и его событие аудита атомарно.",
  history_type_update: "Меняет имя и описание типа и записывает аудит.",
};

const operations: Record<ToolName, (handlers: HistoryHandlers, args: unknown, context: OperationContext) => Promise<unknown>> = {
  history_categories_list: (h, a, c) => h.categoriesList(a, c),
  history_types_list: (h, a, c) => h.typesList(a, c),
  history_type_get: (h, a, c) => h.typeGet(a, c),
  history_append: (h, a, c) => h.appendEvent(a, c),
  history_get: (h, a, c) => h.getEvent(a, c),
  history_search: (h, a, c) => h.searchEvents(a, c),
  history_category_create: (h, a, c) => h.categoryCreate(a, c),
  history_category_update: (h, a, c) => h.categoryUpdate(a, c),
  history_type_create: (h, a, c) => h.typeCreate(a, c),
  history_type_update: (h, a, c) => h.typeUpdate(a, c),
};

type JsonSchema = Record<string, unknown>;
type OwnerSchemas = Record<string, JsonSchema>;

function loadOwnerSchemas(): Record<string, OwnerSchemas> {
  return Object.fromEntries(["common", "messages", "tools"].map(name => [
    `${name}.schema.json`,
    JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8")) as OwnerSchemas,
  ]));
}

function pointer(root: unknown, fragment: string): unknown {
  if (!fragment || fragment === "#") return root;
  if (!fragment.startsWith("#/")) throw new Error("UNSUPPORTED_SCHEMA_POINTER");
  return fragment.slice(2).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, key) => {
      if (!value || typeof value !== "object" || !(key in value)) throw new Error("SCHEMA_REFERENCE_NOT_FOUND");
      return (value as Record<string, unknown>)[key];
    }, root);
}

/** Раскрывает локальные ссылки на схемы-владельцы перед публикацией MCP-схемы. */
function resolveSchema(rootName: string, definition: string, sources: Record<string, OwnerSchemas>): JsonSchema {
  const resolving = new Set<string>();
  const visit = (value: unknown, current: string): unknown => {
    if (Array.isArray(value)) return value.map(item => visit(item, current));
    if (!value || typeof value !== "object") return value;
    const schema = value as Record<string, unknown>;
    if (typeof schema.$ref === "string") {
      const [file, fragment = ""] = schema.$ref.split("#", 2);
      const targetFile = file || current;
      const target = sources[targetFile];
      if (!target) throw new Error("EXTERNAL_SCHEMA_REFERENCE");
      const key = `${targetFile}#${fragment}`;
      if (resolving.has(key)) throw new Error("CYCLIC_SCHEMA_REFERENCE");
      resolving.add(key);
      const expanded = visit(pointer(target, fragment ? `#${fragment}` : "#"), targetFile);
      resolving.delete(key);
      const siblings = Object.fromEntries(Object.entries(schema).filter(([name]) => name !== "$ref").map(([name, child]) => [name, visit(child, current)]));
      if (!Object.keys(siblings).length) return expanded;
      if (!expanded || typeof expanded !== "object" || Array.isArray(expanded)) throw new Error("INVALID_SCHEMA_REF_SIBLING");
      return { ...expanded as object, ...siblings };
    }
    return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$id" && key !== "$schema").map(([key, child]) => [key, visit(child, current)]));
  };
  const owner = sources[rootName];
  if (!owner) throw new Error("SCHEMA_OWNER_NOT_FOUND");
  return visit(owner.definitions[definition], rootName) as JsonSchema;
}

const ownerSchemas = loadOwnerSchemas();
const toolNames = Object.keys(toolInputDefinitions) as ToolName[];
const tools: Tool[] = toolNames.map(name => ({
  name,
  description: descriptions[name],
  inputSchema: resolveSchema("tools.schema.json", toolInputDefinitions[name], ownerSchemas) as Tool["inputSchema"],
  outputSchema: resolveSchema("tools.schema.json", toolOutputDefinitions[name], ownerSchemas) as Tool["outputSchema"],
}));

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  touched: number;
  activeHttpRequests: number;
  calls: Map<string, { controller: AbortController; deadlineAt: number }>;
}

/** Управляет только MCP listener и его сессиями; ядро и пулы принадлежат процессу. */
export interface McpRuntime {
  /** HTTP listener, предоставленный для наблюдения в тестах и приёмке. */
  http: HttpServer;
  /** Loopback или доверенный внутренний URL Streamable HTTP endpoint. */
  url: string;
  /** Прекращает приём MCP-запросов, отменяет их и закрывает сессии. */
  close(): Promise<void>;
}

/** Пишет только случайный request ID, имя инструмента, длительность и код результата. */
function logTool(fields: { requestId: string; tool: ToolName; durationMs: number; result: string }): void {
  console.log(JSON.stringify({ service: "service_history", adapter: "mcp", request_id: fields.requestId, tool: fields.tool, duration_ms: fields.durationMs, result: fields.result }));
}

function send(res: import("node:http").ServerResponse, status: number, body = ""): void {
  res.writeHead(status, { "content-length": Buffer.byteLength(body), "connection": "close" }).end(body);
}

function rejectOversizeRequest(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  res.once("finish", () => req.destroy());
  send(res, 413);
  req.pause();
}

function jsonRpcId(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const id = (body as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" ? JSON.stringify(id) : undefined;
}

function successResponseBudget(requestId: string | number): number {
  const emptyEnvelope = JSON.stringify({ jsonrpc: "2.0", id: requestId, result: { content: [], structuredContent: {} } });
  const envelopeOverhead = Buffer.byteLength(emptyEnvelope, "utf8") - 2;
  return limits.maxResponseBytes - envelopeOverhead;
}

function faultCode(error: unknown): HistoryErrorCode {
  return error instanceof HistoryFault ? error.code : "INTERNAL";
}

async function makeSession(handlers: HistoryHandlers, gate: LoadGate, config: Config, getShutdownSignal: () => AbortSignal, sessions: Map<string, Session>, releasePending: () => void): Promise<Session> {
  const server = new McpServer({ name: "brai-history", version: "1.0.0" }, { capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } } });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: config.mcpAllowedHosts,
    allowedOrigins: config.mcpAllowedOrigins,
    onsessioninitialized: id => {
      sessions.set(id, session);
      releasePending();
    },
  });
  const session: Session = { server, transport, touched: Date.now(), activeHttpRequests: 0, calls: new Map() };
  transport.onclose = () => {
    for (const call of session.calls.values()) call.controller.abort();
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => boundedResponse(extra.requestId, { tools }));
  server.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => boundedResponse(extra.requestId, { resources: [...resources] }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    const resource = resources.find(candidate => candidate.uri === request.params.uri);
    if (!resource) throw new Error("RESOURCE_NOT_FOUND");
    const source = resource.uri.endsWith("CONTRACT.md")
      ? new URL("../CONTRACT.md", import.meta.url)
      : new URL("../schemas/common.schema.json", import.meta.url);
    return boundedResponse(extra.requestId, { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: readFileSync(source, "utf8") }] });
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const requestedName = request.params.name;
    if (!Object.hasOwn(operations, requestedName)) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
    const name = requestedName as ToolName;
    const operation = operations[name];
    const httpCall = session.calls.get(JSON.stringify(extra.requestId));
    const httpSignal = httpCall?.controller.signal;
    const signal = AbortSignal.any([extra.signal, ...(httpSignal ? [httpSignal] : []), getShutdownSignal()]);
    const requestId = randomUUID();
    const startedAt = performance.now();
    try {
      const responseBudgetBytes = successResponseBudget(extra.requestId);
      const value = await gate.run(context => operation(handlers, request.params.arguments ?? {}, context), {
        signal,
        responseBudgetBytes,
        ...(httpCall ? { deadlineAt: httpCall.deadlineAt } : {}),
      });
      if (!validateToolOutput(name, value)) {
        throw new HistoryFault("INTERNAL");
      }
      const result = { content: [], structuredContent: value };
      const bounded = boundedResponse(extra.requestId, result);
      logTool({ requestId, tool: name, durationMs: Math.round(performance.now() - startedAt), result: "OK" });
      return bounded;
    } catch (error) {
      const code = faultCode(error);
      const errorValue = { code, message: code, retryable: error instanceof HistoryFault && error.retryable };
      // Клиент SDK проверяет structuredContent по success-схеме и для isError.
      // Поэтому owner error DTO передаётся JSON-текстом, не нарушая схему результата.
      const result = boundedResponse(extra.requestId, { isError: true, content: [{ type: "text" as const, text: JSON.stringify(errorValue) }] });
      logTool({ requestId, tool: name, durationMs: Math.round(performance.now() - startedAt), result: code });
      return result;
    }
  });
  await server.connect(transport);
  return session;
}

function boundedResponse<T extends object>(requestId: string | number, result: T): T {
  const bytes = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: requestId, result }), "utf8");
  if (bytes > limits.maxResponseBytes) throw new HistoryFault("RESULT_TOO_LARGE");
  return result;
}

/** Запускает внутренний MCP listener на тех же операциях и gate, что NATS. */
export async function startMcp(config: Config, handlers: HistoryHandlers, gate: LoadGate): Promise<McpRuntime> {
  const sessions = new Map<string, Session>();
  const pendingInitializations = new Set<symbol>();
  const shutdown = new AbortController();
  let stopping = false;
  const http = createServer(async (req, res) => {
    const requestDeadlineAt = performance.now() + limits.deadlineMs;
    if (stopping) { send(res, 503); return; }
    if (req.url !== "/mcp") { send(res, 404); return; }
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (!host || !config.mcpAllowedHosts.includes(host) || (origin !== undefined && !config.mcpAllowedOrigins.includes(origin))) {
      send(res, 403);
      return;
    }
    const sessionHeader = req.headers["mcp-session-id"];
    if (Array.isArray(sessionHeader)) { send(res, 400); return; }
    let session = sessionHeader ? sessions.get(sessionHeader) : undefined;
    if (sessionHeader && !session) { send(res, 404); return; }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      res.writeHead(405, { allow: "GET, POST, DELETE", "content-length": "0" }).end();
      return;
    }
    if (!session && req.method !== "POST") { send(res, 400); return; }

    let reservation: symbol | undefined;
    let reservationReleased = false;
    const releasePending = () => {
      if (!reservation || reservationReleased) return;
      reservationReleased = true;
      pendingInitializations.delete(reservation);
    };
    if (!session) {
      if (sessions.size + pendingInitializations.size >= config.mcpMaxSessions) { send(res, 503); return; }
      reservation = Symbol("mcp initialization");
      pendingInitializations.add(reservation);
      try {
        session = await makeSession(handlers, gate, config, () => shutdown.signal, sessions, releasePending);
      } catch {
        releasePending();
        send(res, 503);
        return;
      }
    }

    const requestController = new AbortController();
    const disconnect = () => {
      if (!res.writableEnded) requestController.abort();
    };
    res.once("close", disconnect);
    req.once("aborted", disconnect);
    const countedHttpRequest = req.method === "POST" || req.method === "DELETE";
    if (countedHttpRequest) session.activeHttpRequests++;
    session.touched = Date.now();
    let callId: string | undefined;
    let ownsCallId = false;
    let body: unknown;
    try {
      if (req.method === "POST") {
        const bodyTimer = setTimeout(() => {
          if (res.writableEnded) return;
          send(res, 408);
          requestController.abort();
          req.destroy();
        }, Math.max(1, requestDeadlineAt - performance.now()));
        bodyTimer.unref();
        const declaredLength = Number(req.headers["content-length"] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > limits.maxRequestBytes) {
          clearTimeout(bodyTimer);
          rejectOversizeRequest(req, res);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        try {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > limits.maxRequestBytes) {
              clearTimeout(bodyTimer);
              rejectOversizeRequest(req, res);
              return;
            }
            chunks.push(Buffer.from(chunk));
          }
        } finally {
          clearTimeout(bodyTimer);
        }
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          body = JSON.parse(text);
        } catch {
          send(res, 400);
          return;
        }
        if (Array.isArray(body)) { send(res, 400); return; }
        callId = jsonRpcId(body);
        if (!session.transport.sessionId && (!body || typeof body !== "object" || (body as { method?: unknown }).method !== "initialize")) {
          send(res, 400);
          return;
        }
        if (callId && session.calls.has(callId)) { send(res, 409); return; }
        if (callId) {
          session.calls.set(callId, { controller: requestController, deadlineAt: requestDeadlineAt });
          ownsCallId = true;
        }
      }
      await session.transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) send(res, 400);
      else if (!res.writableEnded) res.end();
    } finally {
      releasePending();
      if (callId && ownsCallId) session.calls.delete(callId);
      if (countedHttpRequest) session.activeHttpRequests--;
      session.touched = Date.now();
      res.removeListener("close", disconnect);
      req.removeListener("aborted", disconnect);
      if (!session.transport.sessionId) await session.server.close().catch(() => {});
    }
  });

  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) {
      if (session.activeHttpRequests === 0 && Date.now() - session.touched >= config.mcpSessionIdleMs) {
        sessions.delete(id);
        void session.server.close().catch(() => {});
      }
    }
  }, Math.min(config.mcpSessionIdleMs, 30_000));
  cleanup.unref();

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.mcpPort, config.mcpHost, () => { http.removeListener("error", reject); resolve(); });
  }).catch(error => {
    clearInterval(cleanup);
    for (const session of sessions.values()) void session.server.close().catch(() => {});
    sessions.clear();
    throw error;
  });

  const address = http.address();
  if (!address || typeof address === "string") throw new Error("MCP_LISTEN_FAILED");
  const urlHost = config.mcpHost.includes(":") && !config.mcpHost.startsWith("[") ? `[${config.mcpHost}]` : config.mcpHost;
  return {
    http,
    url: `http://${urlHost}:${address.port}/mcp`,
    async close() {
      if (stopping) return;
      stopping = true;
      shutdown.abort();
      clearInterval(cleanup);
      for (const session of sessions.values()) {
        for (const call of session.calls.values()) call.controller.abort();
      }
      await Promise.all([...sessions.values()].map(session => session.server.close().catch(() => {})));
      sessions.clear();
      const closed = new Promise<void>(resolve => http.close(() => resolve()));
      http.closeAllConnections();
      await closed;
    },
  };
}
