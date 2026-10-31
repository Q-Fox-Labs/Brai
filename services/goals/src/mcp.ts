// ABOUTME: Предоставляет операции целей через локальный Streamable HTTP MCP.
// ABOUTME: Владелец задаётся оператором и не принимается из аргументов модели.
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { agentInstructions, invoke, operations } from "./api.js";
import { GoalsFault, type createDomain } from "./domain.js";

type Session = { server: Server; transport: StreamableHTTPServerTransport; touched: number };
const id = { type: "string", format: "uuid" };
const entity = { type: "string", enum: ["goals", "focus", "entries", "resources", "needs", "allocations"] };
const str = { type: ["string", "null"] };
const bool = { type: "boolean" };
const shape: Record<string, Record<string, unknown>> = {
 goals_goal_put: {title:str,meaning:str,achievement:str,due_on:str,status:str,next_step:str,executor:str,archived:bool},
 goals_focus_put: {goal_id:str,reason:str},
 goals_entry_put: {goal_id:str,kind:str,content:str,occurred_on:str,pinned:bool},
 goals_resource_put: {title:str,purpose:str,kind:str,category:str,state:str,amount:str,unit:str,currency:str,expires_on:str},
 goals_need_put: {goal_id:str,title:str,kind:str,amount:str,unit:str,currency:str,state:str},
 goals_allocation_put: {need_id:str,resource_id:str,amount:str,active:bool},
};
const descriptions: Record<string, string> = {
 goals_overview: "Прочитать цели, фокус, записи и ресурсы владельца.",
 goals_list: "Прочитать список записей одного типа.",
 goals_get: "Прочитать одну запись владельца.",
 goals_history: "Прочитать историю изменений конкретной записи.",
 goals_restore: "Восстановить сохранённую версию новой правкой с проверкой текущей версии.",
 goals_delete: "Удалить запись с сохранением истории; активные резервы сначала нужно снять.",
 goals_goal_put: "Создать или изменить цель. Завершение только по словам пользователя.",
 goals_focus_put: "Выбрать или очистить фокус только по явным словам пользователя.",
 goals_entry_put: "Сохранить датированный фактический результат или мысль.",
 goals_resource_put: "Сохранить ресурс или отдельное обязательство. Не выдумывать остаток.",
 goals_need_put: "Сохранить потребность цели.",
 goals_allocation_put: "Выделить ресурс потребности или снять резерв. Резерв не является оплатой.",
};
function schema(name: string): Tool["inputSchema"] {
  if (name === "goals_overview") return {type:"object",additionalProperties:false,properties:{}};
  if (name === "goals_list") return {type:"object",additionalProperties:false,properties:{entity},required:["entity"]};
  if (name === "goals_get" || name === "goals_history") return {type:"object",additionalProperties:false,properties:{entity,id},required:["entity","id"]};
  if (name === "goals_delete") return {type:"object",additionalProperties:false,properties:{entity,id,request_id:id,expected_version:{type:"string"},source:{type:"string"}},required:["entity","id","request_id","expected_version","source"]};
  if (name === "goals_restore") return {type:"object",additionalProperties:false,properties:{entity,id,request_id:id,expected_version:{type:"string"},target_version:{type:"string"},source:{type:"string"}},required:["entity","id","request_id","expected_version","target_version","source"]};
  return {type:"object",additionalProperties:false,properties:{
    id,request_id:id,expected_version:{type:["string","null"]},source:{type:"string"},
    data:{type:"object",additionalProperties:false,properties:shape[name]},
  },required:["id","request_id","expected_version","source","data"]};
}

/** Запускает owner-bound listener; вызывающий закрывает его при завершении. */
export async function startMcp(domain: ReturnType<typeof createDomain>, cfg: {host:string;port:number;owner:string;hosts:string[];origins:string[];token:string}) {
  if (!["127.0.0.1","::1","0.0.0.0"].includes(cfg.host) || !cfg.owner || !cfg.hosts.length || !cfg.origins.length || !/^[A-Za-z0-9_-]{32,128}$/.test(cfg.token)) throw new Error("INVALID_GOALS_MCP_CONFIG");
  const sessions = new Map<string, Session>();
  const pending = new Set<Session>();
  async function make(): Promise<Session> {
    const server = new Server({name:"brai-goals",version:"0.1.0"},{capabilities:{tools:{listChanged:false}},instructions:agentInstructions});
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,enableJsonResponse:true,enableDnsRebindingProtection:true,allowedHosts:cfg.hosts,allowedOrigins:cfg.origins});
    const session = {server,transport,touched:Date.now()}; pending.add(session);
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); pending.delete(session); };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:operations.map(name => ({name,description:descriptions[name],inputSchema:schema(name)}))}));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const name = request.params.name;
      if (!operations.includes(name)) throw new McpError(ErrorCode.InvalidParams,"Unknown tool");
      try {
        const result = await invoke(domain,cfg.owner,"agent",name,request.params.arguments ?? {});
        return {content:[],structuredContent:result as Record<string,unknown>};
      } catch (error) {
        const code = error instanceof GoalsFault ? error.code : "INTERNAL";
        return {isError:true,content:[{type:"text",text:JSON.stringify({code,message:code,retryable:false})}]};
      }
    });
    await server.connect(transport); return session;
  }
  const http = createServer(async (req,res) => {
    try {
      if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from("Bearer " + cfg.token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied,expected)) {res.writeHead(401).end();return;}
      const id = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
      let session = id ? sessions.get(id) : undefined;
      if (id && !session) { res.writeHead(404).end(); return; }
      if (!session && req.method === "POST") {
        if (sessions.size + pending.size >= 32) { res.writeHead(503).end(); return; }
        session = await make();
        try {await session.transport.handleRequest(req,res);}
        finally {
          pending.delete(session);
          if (session.transport.sessionId) sessions.set(session.transport.sessionId,session);
          else await session.transport.close();
        }
        return;
      }
      if (!session) { res.writeHead(404).end(); return; }
      session.touched = Date.now(); await session.transport.handleRequest(req,res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve,reject) => {http.once("error",reject);http.listen(cfg.port,cfg.host,() => {http.removeListener("error",reject);resolve();});});
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("MCP_LISTEN_FAILED");
  const cleaner = setInterval(() => {for (const [key,session] of sessions) if (Date.now()-session.touched > 30*60_000) {void session.transport.close();sessions.delete(key);}},60_000);
  cleaner.unref();
  return {url:`http://${cfg.host.includes(":") ? "["+cfg.host+"]" : cfg.host}:${address.port}/mcp`, async close() {
    clearInterval(cleaner);
    for (const session of [...sessions.values(),...pending]) await session.transport.close().catch(() => {});
    await new Promise<void>(resolve => http.close(() => resolve()));
  }};
}
