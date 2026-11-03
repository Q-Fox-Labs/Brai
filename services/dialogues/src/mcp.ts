// ABOUTME: Предоставляет закрытый owner-bound MCP по Streamable HTTP.
// ABOUTME: Ограничивает тело и сессии; не принимает владельца от клиента.
import { createServer } from "node:http";
import { randomUUID,timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema,ListToolsRequestSchema,type Tool } from "@modelcontextprotocol/sdk/types.js";
import { agentInstructions,toolDefinitions,invoke } from "./api.js";
import { DialoguesFault,limits } from "./domain.js";
import type { createStore } from "./store.js";
type Session={server:Server;transport:StreamableHTTPServerTransport;touched:number};
export type McpConfig={host:string;port:number;owner:string;hosts:string[];origins:string[];token:string};
/** Запускает MCP; тесты могут использовать временный port=0. */
export async function startMcp(store:ReturnType<typeof createStore>,cfg:McpConfig) {
  if(!["127.0.0.1","::1","0.0.0.0"].includes(cfg.host)||!cfg.owner||!cfg.hosts.length||!cfg.origins.length||!/^[A-Za-z0-9_-]{32,128}$/.test(cfg.token))throw new Error("INVALID_MCP_CONFIG");
  const sessions=new Map<string,Session>(),pending=new Set<Session>();
  async function make():Promise<Session> {
    const server=new Server({name:"brai-dialogues",version:"0.2.0"},{capabilities:{tools:{listChanged:false}},instructions:agentInstructions});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,enableJsonResponse:true,enableDnsRebindingProtection:true,allowedHosts:cfg.hosts,allowedOrigins:cfg.origins});
    const s={server,transport,touched:Date.now()};pending.add(s);
    transport.onclose=()=>{if(transport.sessionId)sessions.delete(transport.sessionId);pending.delete(s);};
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:toolDefinitions as Tool[]}));
    server.setRequestHandler(CallToolRequestSchema,async req=>{
      try {
        const result=await invoke(store,cfg.owner,req.params.name,req.params.arguments??{});
        if(Buffer.byteLength(JSON.stringify(result))>65_024)throw new DialoguesFault("RESPONSE_TOO_LARGE");
        return {content:[],structuredContent:result};
      } catch(error) {
        const code=error instanceof DialoguesFault?error.code:"INTERNAL";
        return {isError:true,content:[{type:"text",text:JSON.stringify({code,retryable:false})}]};
      }
    });
    await server.connect(transport);return s;
  }
  const http=createServer(async(req,res)=>{
    try {
      if(req.url==="/health"&&req.method==="GET"){res.writeHead(200,{"content-type":"application/json"}).end('{"ready":true}');return;}
      if(req.url!=="/mcp"){res.writeHead(404).end();return;}
      const supplied=Buffer.from(req.headers.authorization??""),expected=Buffer.from("Bearer "+cfg.token);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){res.writeHead(401).end();return;}
      let body:unknown;
      if(req.method==="POST") {
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>limits.requestBytes){res.writeHead(413).end();return;}chunks.push(b);}
        try {body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}
        catch {res.writeHead(400).end();return;}
      }
      const sid=typeof req.headers["mcp-session-id"]==="string"?req.headers["mcp-session-id"]:undefined;
      let s=sid?sessions.get(sid):undefined;
      if(sid&&!s){res.writeHead(404).end();return;}
      if(!s&&req.method==="POST") {
        if(sessions.size+pending.size>=32){res.writeHead(503).end();return;}
        s=await make();
        try {await s.transport.handleRequest(req,res,body);}
        finally {pending.delete(s);if(s.transport.sessionId)sessions.set(s.transport.sessionId,s);else await s.transport.close();}
        return;
      }
      if(!s){res.writeHead(404).end();return;}
      s.touched=Date.now();await s.transport.handleRequest(req,res,body);
    } catch {if(!res.headersSent)res.writeHead(500);res.end();}
  });
  await new Promise<void>((resolve,reject)=>{http.once("error",reject);http.listen(cfg.port,cfg.host,resolve);});
  const address=http.address();if(!address||typeof address==="string")throw new Error("MCP_LISTENER_FAILED");
  const sweep=setInterval(()=>{for(const s of sessions.values())if(Date.now()-s.touched>900_000)void s.server.close();},60_000);sweep.unref();
  return {url:"http://"+(cfg.host==="::1"?"[::1]":cfg.host)+":"+address.port+"/mcp",async close(){clearInterval(sweep);await Promise.allSettled([...sessions.values(),...pending].map(s=>s.server.close()));http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()));}};
}
