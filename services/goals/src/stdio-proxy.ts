// ABOUTME: Соединяет локальный Codex stdio с защищённым owner-bound MCP целей.
// ABOUTME: Токен хранится отдельно; сессия восстанавливается без повтора изменения.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { agentInstructions } from "./api.js";

try {
  const url = new URL(process.env.GOALS_MCP_URL ?? "");
  if (url.protocol !== "http:" || !["127.0.0.1","localhost","[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") throw new Error("INVALID_ENDPOINT");
  const token = readFileSync(process.env.GOALS_MCP_TOKEN_FILE ?? "","utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("INVALID_TOKEN");
  async function connect() {
    const next = new Client({name:"brai-goals-local-proxy",version:"0.1.0"});
    try {await next.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:"Bearer " + token}}}),{timeout:5_000});return next;}
    catch (error) {await next.close().catch(() => {});throw error;}
  }
  let client = await connect();
  let reconnecting:Promise<void>|null = null;
  const staleSession = (error:unknown) => error instanceof StreamableHTTPError && error.code === 404;
  async function reconnect(stale:Client) {
    if (client !== stale) return;
    if (!reconnecting) reconnecting = (async () => {
      const next = await connect();
      client = next;
      await stale.close().catch(() => {});
    })().finally(() => {reconnecting = null;});
    await reconnecting;
  }
  const reads = new Set(["goals_overview","goals_list","goals_get","goals_history"]);
  const server = new Server({name:"brai-goals",version:"0.1.0"},{capabilities:{tools:{listChanged:false}},instructions:agentInstructions});
  server.setRequestHandler(ListToolsRequestSchema,async () => {
    const current = client;
    try {return await current.listTools();}
    catch (error) {if (!staleSession(error)) throw error;await reconnect(current);return client.listTools();}
  });
  server.setRequestHandler(CallToolRequestSchema,async request => {
    const current = client;
    try {return await current.callTool(request.params);}
    catch (error) {
      if (reads.has(request.params.name)) {
        if (!staleSession(error)) throw error;
        await reconnect(current);return client.callTool(request.params);
      }
      if (staleSession(error)) await reconnect(current).catch(() => {});
      return {isError:true,content:[{type:"text" as const,text:"Не удалось подтвердить результат изменения. Сначала проверьте текущее состояние и историю; изменение не повторялось."}]};
    }
  });
  server.onclose = () => {void client.close();};
  process.stdin.once("end",() => {void server.close().finally(() => client.close());});
  await server.connect(new StdioServerTransport());
} catch {
  console.error("GOALS_MCP_PROXY_UNAVAILABLE");
  process.exitCode = 1;
}
