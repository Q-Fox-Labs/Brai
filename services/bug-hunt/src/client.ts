// ABOUTME: Подключает BB, Codex и терминал к одному HTTP MCP Bug Hunt.
// ABOUTME: Использует один клиентский principal и не повторяет операции записи.
import {readFileSync} from "node:fs";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema,ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {limits} from "./contracts.js";

try {
 const url = new URL(process.env.BRAI_BUG_HUNT_MCP_URL??"");
 const local = url.protocol==="http:" && ["127.0.0.1","localhost","[::1]"].includes(url.hostname);
 if ((!local && url.protocol!=="https:") || url.username || url.password || url.search || url.hash || url.pathname!=="/mcp")
  throw new Error("INVALID_MCP_URL");
 const token = readFileSync(process.env.BRAI_BUG_HUNT_MCP_TOKEN_FILE??"","utf8").trim();
 if (!token || /[\r\n]/.test(token)) throw new Error("INVALID_MCP_TOKEN");
 const use = async <T>(request:(client:Client)=>Promise<T>):Promise<T> => {
  const client = new Client({name:"brai-bug-hunt-client",version:"1.0.0"});
  try {
   await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:"Bearer "+token},redirect:"error"}}));
   return await request(client);
  } finally {await client.close();}
 };
 const [, , mode, inputPath] = process.argv;
 if (mode==="stdio") {
  const server = new Server({name:"brai-bug-hunt",version:"1.0.0"},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,request=>use(client=>client.listTools(request.params)));
  server.setRequestHandler(CallToolRequestSchema,request=>use(client=>client.callTool(request.params)));
  process.stdin.once("end",()=>{void server.close();});
  await server.connect(new StdioServerTransport());
 } else if (mode==="list-tools") {
  console.log(JSON.stringify(await use(client=>client.listTools())));
 } else {
  if (!mode?.startsWith("bug_hunt_") || !inputPath) throw new Error("USAGE");
  const data = readFileSync(inputPath);
  if (data.length>limits.requestBytes) throw new Error("REQUEST_TOO_LARGE");
  const result = await use(client=>client.callTool({name:mode,arguments:JSON.parse(data.toString("utf8"))}));
  console.log(JSON.stringify(result.structuredContent??result));
  if (result.isError) process.exitCode=1;
 }
} catch {
 console.error("BUG_HUNT_CLIENT_FAILED");
 process.exitCode=1;
}
