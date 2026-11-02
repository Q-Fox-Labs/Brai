// ABOUTME: Подключает локальный Codex к защищённому owner-bound MCP Диалогов.
// ABOUTME: После неизвестного изменения не повторяет запись автоматически.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport,StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema,ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { agentInstructions } from "./api.js";
try {
  const url=new URL(process.env.DIALOGUES_MCP_URL??"");
  if(url.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=="/mcp")throw new Error("INVALID_ENDPOINT");
  const token=readFileSync(process.env.DIALOGUES_MCP_TOKEN_FILE??"","utf8").trim();
  if(!/^[A-Za-z0-9_-]{32,128}$/.test(token))throw new Error("INVALID_TOKEN");
  async function connect(){
    const c=new Client({name:"brai-dialogues-proxy",version:"0.1.0"});
    try {await c.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:"Bearer "+token}}}),{timeout:5000});return c;}
    catch(e){await c.close().catch(()=>{});throw e;}
  }
  let client=await connect(),reconnecting:Promise<void>|null=null;
  const stale=(e:unknown)=>e instanceof StreamableHTTPError&&e.code===404;
  async function reconnect(previous:Client){
    if(client!==previous)return;
    if(!reconnecting)reconnecting=(async()=>{const next=await connect();client=next;await previous.close().catch(()=>{});})().finally(()=>{reconnecting=null;});
    await reconnecting;
  }
  const server=new Server({name:"brai-dialogues",version:"0.1.0"},{capabilities:{tools:{listChanged:false}},instructions:agentInstructions});
  server.setRequestHandler(ListToolsRequestSchema,async()=>{
    const c=client;
    try{return await c.listTools();}catch(e){if(!stale(e))throw e;await reconnect(c);return client.listTools();}
  });
  server.setRequestHandler(CallToolRequestSchema,async req=>{
    const c=client;
    try{return await c.callTool(req.params);}
    catch(e){
      if(["dialogues_context_get","dialogues_message_get"].includes(req.params.name)){
        if(!stale(e))throw e;await reconnect(c);return client.callTool(req.params);
      }
      if(stale(e))await reconnect(c).catch(()=>{});
      return {isError:true,content:[{type:"text" as const,text:"Исход записи не подтверждён. Сначала прочитайте сообщение по исходному ID либо актуальную версию саммари. Автоматического повтора записи не было."}]};
    }
  });
  server.onclose=()=>{void client.close();};
  process.stdin.once("end",()=>{void server.close().finally(()=>client.close());});
  await server.connect(new StdioServerTransport());
} catch {console.error("DIALOGUES_MCP_PROXY_UNAVAILABLE");process.exitCode=1;}
