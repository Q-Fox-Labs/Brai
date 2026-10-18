// ABOUTME: Ограничивает передачу LiteLLM → TypeSafe одной внешней HTTP-отправкой.
// ABOUTME: Одноразовый nonce живёт только во время вызова; payload и ключи не журналируются.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Failure, LIMITS, type Request } from "./core.js";
import { validDecideUpstream } from "./v1-schema.js";
import { canonical, type DecideRequest, type DecideUpstream } from "./operations.js";
import { validUpstream } from "./schema.js";
import { chatWire, createChatAssembler, createSseParser, type ChatRequest, type ChatCompletion, type Message } from "./chat.js";
import { imageWire, rawImage, type ImageRequest, type ImageCompletion } from "./image.js";
type Usage = {input_tokens: number; output_tokens: number} | null;
type Entry = {claimed: boolean; request: Request | DecideRequest | ChatRequest | ImageRequest; messages?:Message[]; controller: AbortController; usage?: Usage; raw?: DecideUpstream; chat?:ChatCompletion; image?:ImageCompletion; pending?: Promise<void>};
/** Читает ограниченные байты; прерывает источник при переполнении. */
async function readBody(source: AsyncIterable<Uint8Array>, limit: number) {
  const chunks: Uint8Array[]=[];let length=0;
  for await (const chunk of source) { length+=chunk.byteLength; if(length>limit) throw new Error("BODY_LIMIT");chunks.push(chunk); }
  return Buffer.concat(chunks);
}
/** Запускает приватный listener; фиксированный upstream меняется только в управляемом тесте. */
export async function createEgressGuard(options: {host: string; port: number; upstream?: string; chatUpstream?:string}) {
  const upstream = options.upstream ?? "https://api.typesafe.ai/v1/systemone";
  const chatUpstream=options.chatUpstream ?? "https://openrouter.ai/api/v1/chat/completions";
  const active = new Map<string,Entry>();
  let dispatches=0,upstreamStatus:number|null=null;
  const server=createServer((req,res)=>{
    const reject=()=>{res.writeHead(409,{"content-type":"application/json"});res.end('{"error":"DISPATCH_REJECTED"}');};
    const match=/^\/dispatch\/([a-f0-9-]{36})\/v1\/(systemone|chat\/completions)$/.exec(req.url ?? "");
    const entry=match ? active.get(match[1]) : undefined;
    if(req.method!=="POST" || !entry || (match![2]==="chat/completions")!== (!!entry.messages || "prompt" in entry.request) || entry.claimed || entry.controller.signal.aborted || Date.now()>=Date.parse(entry.request.deadlineAt)) {req.resume();reject();return;}
    // AIDEV-NOTE: Claim синхронный, до чтения тела и любого внешнего эффекта.
    entry.claimed=true;
    const stop=()=>{req.destroy();res.destroy();};
    entry.controller.signal.addEventListener("abort",stop,{once:true});
    entry.pending=(async()=>{
      try {
        const body=await readBody(req,"operationId" in entry.request ? 65536 : LIMITS.requestBytes);
        const data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body));
        if("prompt" in entry.request){if(canonical(data)!==canonical(imageWire(entry.request)))throw new Error("DISPATCH_BODY");}
        else if(entry.messages){
          // AIDEV-NOTE: Stock OpenRouter добавляет только usage.include. Все остальные поля обязаны совпасть.
          const {usage,...wire}=data;
          if(usage!==undefined&&canonical(usage)!==canonical({include:true}) || canonical(wire)!==canonical(chatWire(entry.request as ChatRequest,entry.messages)))throw new Error("DISPATCH_BODY");
        }else{const input=entry.request as Request|DecideRequest;if(canonical(data)!==canonical({model:input.model,state:input.state,questions:input.questions}))throw new Error("DISPATCH_BODY");}
        const authorization=req.headers.authorization;
        if(!authorization?.startsWith("Bearer ")) throw new Error("DISPATCH_AUTH");
        dispatches++;
        const response=await fetch(entry.messages || "prompt" in entry.request?chatUpstream:upstream,{method:"POST",redirect:"error",signal:entry.controller.signal,headers:{"content-type":"application/json",authorization},body});
        upstreamStatus=response.status;
        if(!response.ok) {await response.body?.cancel();res.writeHead(response.status,{"content-type":"application/json"});res.end('{"error":"UPSTREAM_REJECTED"}');return;}
        if(!response.body) throw new Error("UPSTREAM_PROTOCOL");
        if(entry.messages){
          const assembler=createChatAssembler(entry.request as ChatRequest),parser=createSseParser(assembler.push);
          res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});
          const disconnected=()=>entry.controller.abort();res.once("close",disconnected);
          try{
            for await(const chunk of response.body){parser.push(chunk);if(!res.write(chunk))await once(res,"drain",{signal:entry.controller.signal});}
            parser.end();entry.chat=assembler.finish();
            res.removeListener("close",disconnected);res.end();
          }finally{res.removeListener("close",disconnected);}
          return;
        }
        if("prompt" in entry.request){const bytes=await readBody(response.body,23068672);entry.image=rawImage(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));res.writeHead(200,{"content-type":"application/json"});res.end(bytes);return;}
        const bytes=await readBody(response.body,"operationId" in entry.request ? 65536 : LIMITS.responseBytes);
        const raw:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
        if(!("operationId" in entry.request ? validDecideUpstream(raw) : validUpstream(raw))) throw new Error("UPSTREAM_PROTOCOL");
        entry.usage=(raw as {usage?:Usage}).usage ?? null;
        entry.raw=raw as DecideUpstream;
        res.writeHead(200,{"content-type":"application/json"});res.end(bytes);
      } catch {if(res.headersSent)res.destroy();else if(!res.destroyed){res.writeHead(502,{"content-type":"application/json"});res.end('{"error":"UPSTREAM_UNKNOWN"}');}}
      finally {entry.controller.signal.removeEventListener("abort",stop);}
    })();
  });
  server.requestTimeout=180000;server.headersTimeout=5000;server.maxConnections=8;
  server.listen(options.port,options.host);await once(server,"listening");
  const address=server.address();if(!address || typeof address==="string") throw new Error("EGRESS_BIND");
  const origin=`http://${options.host}:${address.port}`;
  return {
    /** Счётчик отправок без owner, payload, URL capability или credentials. */
    stats:()=>({dispatches,upstreamStatus}),
    /** Регистрирует случайную capability, не являющуюся caller requestId или дедупликацией v0. */
    allocate(request: Request | DecideRequest | ChatRequest | ImageRequest, signal: AbortSignal, messages?:Message[]) {
      if(active.size>=LIMITS.concurrency) throw new Failure("OVERLOADED","not_sent");
      const nonce=randomUUID(),controller=new AbortController();
      const entry:Entry={claimed:false,request,controller,messages};
      const abort=()=>controller.abort();signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
      active.set(nonce,entry);
      return {
        apiBase:`${origin}/dispatch/${nonce}${messages || "prompt" in request?"/v1":""}`,
        usage:()=>entry.usage,
        raw:()=>entry.raw,
        chat:()=>entry.chat,
        image:()=>entry.image,
        async release() {controller.abort();await entry.pending;active.delete(nonce);signal.removeEventListener("abort",abort);}
      };
    },
    /** Закрывает только собственный listener и его активные HTTP-операции. */
    async close() {for(const entry of active.values())entry.controller.abort();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e ? reject(e) : resolve()));}
  };
}
export type EgressGuard = Awaited<ReturnType<typeof createEgressGuard>>;
