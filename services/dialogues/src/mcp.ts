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
export async function startMcp(store:ReturnType<typeof createStore>,cfg:McpConfig,log:(entry:Record<string,unknown>)=>void=entry=>console.error(JSON.stringify(entry))) {
  if(!["127.0.0.1","::1","0.0.0.0"].includes(cfg.host)||!cfg.owner||!cfg.hosts.length||!cfg.origins.length||!/^[A-Za-z0-9_-]{32,128}$/.test(cfg.token))throw new Error("INVALID_MCP_CONFIG");
  const sessions=new Map<string,Session>(),pending=new Set<Session>();
  const safeId=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_.:/-]{1,256}$/.test(v)?v:undefined;
  function rejected(name:string,raw:any,diagnostic:Record<string,any>,started:number){
    const action=['input','update','finish','poll','page','read','history','snapshot','import','summary','repair'].includes(raw?.action)?raw.action:undefined;
    try{log({service:'dialogues',event:'request_rejected',tool:['dialogues_exchange','dialogues_context_ack'].includes(name)?name:'unknown',
      action,request_id:safeId(raw?.arguments?.request_id??raw?.request_id),code:diagnostic.code,
      field:diagnostic.unknown_property?(diagnostic.parent_field?diagnostic.parent_field+'.':'')+'<unknown>':diagnostic.field,applied:diagnostic.applied,duration_ms:Date.now()-started});}catch{/* Журнал не меняет исход операции. */}
  }
  async function make():Promise<Session> {
    const server=new Server({name:"brai-dialogues",version:"0.2.0"},{capabilities:{tools:{listChanged:false}},instructions:agentInstructions});
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,enableJsonResponse:true,enableDnsRebindingProtection:true,allowedHosts:cfg.hosts,allowedOrigins:cfg.origins});
    const s={server,transport,touched:Date.now()};pending.add(s);
    transport.onclose=()=>{if(transport.sessionId)sessions.delete(transport.sessionId);pending.delete(s);};
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:toolDefinitions as Tool[]}));
    server.setRequestHandler(CallToolRequestSchema,async req=>{
      const started=Date.now();
      try {
        const result=await invoke(store,cfg.owner,req.params.name,req.params.arguments??{});
        if(Buffer.byteLength(JSON.stringify(result))>65_024)throw new DialoguesFault("RESPONSE_TOO_LARGE");
        if(result.status==='rejected')rejected(req.params.name,req.params.arguments,{code:result.code,applied:false},started);
        return {content:[],structuredContent:result};
      } catch(error) {
        const code=error instanceof DialoguesFault?error.code:"INTERNAL";
        const next_action=code==="VERSION_CONFLICT"?"Прочитайте текущий ход и повторите с новой версией и request_id":code==="PENDING_RESULTS"?"Завершите ожидающие результаты или укажите честное основание невыполнения":code==="LEGACY_TURN_OPEN"?"Для восстановления прежнего хода проверьте историю и сохраните подтверждённый финал через exchange import; затем повторите ввод":code==="FINAL_RECONCILIATION_REQUIRED"?"Сверьте фактический финал клиента и восстановите статус":code==="INVALID_ARGUMENT"?"Исправьте field по expected и allowed; сразу повторите с новым request_id, сохранив ID сообщения и исходный текст":"Проверьте данные и состояние перед повтором";
        const outcomeUnknown=code==="INTERNAL"||code==="RESPONSE_TOO_LARGE";
        const diagnostic={code,...(outcomeUnknown?{next_action:"Исход операции неизвестен: сначала проверьте состояние и исходный ID"}:{applied:false,next_action}),...(error instanceof DialoguesFault?error.details:{})};
        const request_id=safeId((req.params.arguments as any)?.arguments?.request_id??(req.params.arguments as any)?.request_id);
        rejected(req.params.name,req.params.arguments,diagnostic,started);
        let text=JSON.stringify({...diagnostic,request_id});
        if(Buffer.byteLength(text)>16_384)text=JSON.stringify({code,...(outcomeUnknown?{}:{applied:false}),next_action:"Диагностика сокращена; прочитайте состояние и исправьте аргументы",diagnostic_truncated:true});
        return {isError:true,content:[{type:"text",text}]};
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
