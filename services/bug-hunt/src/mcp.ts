// ABOUTME: Предоставляет справку и три пользовательских инструмента через stateless Streamable HTTP.
// ABOUTME: Аутентификация выполняется заново для каждого запроса; review модели не предоставляется.
import {createServer} from "node:http";
import {readFileSync} from "node:fs";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StreamableHTTPServerTransport} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {CallToolRequestSchema,ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import {Fault,failure,limits,schemas,type Operation,type Principal} from "./contracts.js";
import type {Config} from "./config.js";
import type {WorkContext,createGate} from "./load.js";

const agentGuide=JSON.parse(readFileSync(new URL("../contracts/agent-guide.json",import.meta.url),"utf8"));
export const agentInstructions:string=agentGuide.reminder;
export const toolDefinitions=[
 {name:"bug_hunt_help",description:"Как зарегистрировать наблюдение: правила и пример.",inputSchema:agentGuide.inputSchema,annotations:{readOnlyHint:true,idempotentHint:true}},
 {name:"bug_hunt_report",description:"Зарегистрировать наблюдение о сбое; сначала прочитай bug_hunt_help.",inputSchema:schemas.report},
 {name:"bug_hunt_get",description:"Прочитать доступную карточку и ограниченную страницу ручных решений. Чужая и отсутствующая карточки неразличимы.",inputSchema:schemas.get},
 {name:"bug_hunt_list",description:"Прочитать свою страницу наблюдений с фиксированными фильтрами.",inputSchema:schemas.list},
];
type Execute=(op:Operation,p:Principal,input:unknown,ctx:WorkContext)=>Promise<unknown>;
/** Запускает stateless listener с закрытой проверкой credential и ограниченными ресурсами. */
export async function startMcp(config:Config["mcp"],gate:ReturnType<typeof createGate>,authenticate:(authorization:string|undefined)=>Promise<Principal>,execute:Execute){
 let connections=0;
 const http=createServer(async(req,res)=>{
  if(req.url!=="/mcp"||req.method!=="POST"){res.writeHead(req.url==="/mcp"?405:404).end();return;}
  if(connections>=config.maxConnections){res.writeHead(503).end();return;}
  connections++;
  let server:Server|undefined;
  let transport:StreamableHTTPServerTransport|undefined;
  const finish=()=>{connections--;void transport?.close().catch(()=>{});void server?.close().catch(()=>{});};
  res.once("close",finish);
  try{
   await gate.run(async ctx=>{
    const p=await authenticate(req.headers.authorization);
    const declared=Number(req.headers["content-length"]??0);
    if(declared>limits.requestBytes+4096)throw new Fault("REQUEST_TOO_LARGE");
    const chunks:Buffer[]=[];let size=0;
    const readTimer=setTimeout(()=>req.destroy(),Math.max(1,ctx.deadlineAt-Date.now()));
    try{for await(const chunk of req){size+=chunk.length;if(size>limits.requestBytes+4096)throw new Fault("REQUEST_TOO_LARGE");chunks.push(chunk);}}finally{clearTimeout(readTimer);}
    let body;try{body=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new Fault("INVALID_ARGUMENT");}
    if(!body||typeof body!=="object"||Array.isArray(body))throw new Fault("INVALID_ARGUMENT");
    server=new Server({name:"brai-bug-hunt",version:"1.0.0"},{capabilities:{tools:{}},instructions:agentInstructions});
    transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true,enableDnsRebindingProtection:true,allowedHosts:config.allowedHosts,allowedOrigins:config.allowedOrigins});
    server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:toolDefinitions}));
    server.setRequestHandler(CallToolRequestSchema,async request=>{
     const found=toolDefinitions.find(t=>t.name===request.params.name);
     if(!found)return {isError:true,content:[{type:"text",text:JSON.stringify(failure(new Fault("FORBIDDEN")))}]};
     if(found.name==="bug_hunt_help"){
      if(Object.keys(request.params.arguments??{}).length)return {isError:true,content:[{type:"text",text:JSON.stringify(failure(new Fault("INVALID_ARGUMENT")))}]};
      return {content:[{type:"text",text:agentGuide.help}]};
     }
     const op=found.name.slice("bug_hunt_".length) as Operation;
     try {
      const value=await execute(op,p,request.params.arguments??{},ctx);
      const result={content:[],structuredContent:value as Record<string,unknown>};
      if(Buffer.byteLength(JSON.stringify({jsonrpc:"2.0",id:body.id,result}))>limits.responseBytes)throw new Fault("RESULT_TOO_LARGE");
      return result;
     }catch(error){return {isError:true,content:[{type:"text",text:JSON.stringify(failure(error,op==="report"))}]};}
    });
    await server.connect(transport);
    await transport.handleRequest(req,res,body);
   },true);
  }catch(error){
   if(!res.headersSent){const dto=failure(error,true);res.writeHead(({UNAUTHENTICATED:401,FORBIDDEN:403,INVALID_ARGUMENT:400,REQUEST_TOO_LARGE:413,RESULT_TOO_LARGE:413,DEADLINE_EXCEEDED:504} as Record<string,number>)[dto.code]??503,{"content-type":"application/json"}).end(JSON.stringify(dto));}
  }
 });
 // Ограничивает также sockets до получения заголовков или аутентификации.
 http.maxConnections=config.maxConnections;
 http.requestTimeout=10000;http.headersTimeout=10000;http.keepAliveTimeout=1000;
 await new Promise<void>((resolve,reject)=>{http.once("error",reject);http.listen(config.port,config.host,()=>{http.removeListener("error",reject);resolve();});});
 const address=http.address();if(!address||typeof address==="string")throw new Error("MCP_LISTEN_FAILED");
 return {http,url:"http://"+(config.host.includes(":")?"["+config.host+"]":config.host)+":"+address.port+"/mcp",
  async close(){http.closeAllConnections();await new Promise<void>(resolve=>http.close(()=>resolve()));}};
}
