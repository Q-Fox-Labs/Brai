// ABOUTME: Соединяет локальный Codex stdio с защищённым owner-bound MCP целей.
// ABOUTME: Токен читается из отдельного файла и не попадает в сообщения или журнал.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { agentInstructions } from "./api.js";

try {
  const url = new URL(process.env.GOALS_MCP_URL ?? "");
  if (url.protocol !== "http:" || !["127.0.0.1","localhost","[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") throw new Error("INVALID_ENDPOINT");
  const token = readFileSync(process.env.GOALS_MCP_TOKEN_FILE ?? "","utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("INVALID_TOKEN");
  const client = new Client({name:"brai-goals-local-proxy",version:"0.1.0"});
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:"Bearer " + token}}}),{timeout:5_000});
  const server = new Server({name:"brai-goals",version:"0.1.0"},{capabilities:{tools:{listChanged:false}},instructions:agentInstructions});
  server.setRequestHandler(ListToolsRequestSchema,async () => client.listTools());
  server.setRequestHandler(CallToolRequestSchema,async request => client.callTool(request.params));
  server.onclose = () => {void client.close();};
  process.stdin.once("end",() => {void server.close().finally(() => client.close());});
  await server.connect(new StdioServerTransport());
} catch {
  console.error("GOALS_MCP_PROXY_UNAVAILABLE");
  process.exitCode = 1;
}
