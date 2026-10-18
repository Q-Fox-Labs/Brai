// ABOUTME: Ограничивает передачу LiteLLM → TypeSafe одной внешней HTTP-отправкой.
// ABOUTME: Одноразовый nonce живёт только во время вызова; payload и ключи не журналируются.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Failure, LIMITS, type Request } from "./core.js";
import { validUpstream } from "./schema.js";
type Usage = {input_tokens: number; output_tokens: number} | null;
type Entry = {claimed: boolean; request: Request; controller: AbortController; usage?: Usage; pending?: Promise<void>};
/** Читает ограниченные байты; прерывает источник при переполнении. */
async function readBody(source: AsyncIterable<Uint8Array>, limit: number) {
  const chunks: Uint8Array[]=[];let length=0;
  for await (const chunk of source) { length+=chunk.byteLength; if(length>limit) throw new Error("BODY_LIMIT");chunks.push(chunk); }
  return Buffer.concat(chunks);
}
/** Запускает приватный listener; фиксированный upstream меняется только в управляемом тесте. */
export async function createEgressGuard(options: {host: string; port: number; upstream?: string}) {
  const upstream = options.upstream ?? "https://api.typesafe.ai/v1/systemone";
  const active = new Map<string,Entry>();
  const server=createServer((req,res)=>{
    const reject=()=>{res.writeHead(409,{"content-type":"application/json"});res.end('{"error":"DISPATCH_REJECTED"}');};
    const match=/^\/dispatch\/([a-f0-9-]{36})\/v1\/systemone$/.exec(req.url ?? "");
    const entry=match ? active.get(match[1]) : undefined;
    if(req.method!=="POST" || !entry || entry.claimed || entry.controller.signal.aborted || Date.now()>=Date.parse(entry.request.deadlineAt)) {req.resume();reject();return;}
    // AIDEV-NOTE: Claim синхронный, до чтения тела и любого внешнего эффекта.
    entry.claimed=true;
    const stop=()=>{req.destroy();res.destroy();};
    entry.controller.signal.addEventListener("abort",stop,{once:true});
    entry.pending=(async()=>{
      try {
        const body=await readBody(req,LIMITS.requestBytes);
        const data=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body));
        const key=Object.keys(entry.request.questions)[0];
        if(data.model!==entry.request.model || data.state!==entry.request.state || Object.keys(data).sort().join()!=="model,questions,state" || Object.keys(data.questions ?? {}).join()!==key || Object.keys(data.questions[key]).sort().join()!=="instructions,type" || data.questions[key].type!=="noul" || data.questions[key].instructions!==entry.request.questions[key].instructions) throw new Error("DISPATCH_BODY");
        const authorization=req.headers.authorization;
        if(!authorization?.startsWith("Bearer ")) throw new Error("DISPATCH_AUTH");
        const response=await fetch(upstream,{method:"POST",redirect:"error",signal:entry.controller.signal,headers:{"content-type":"application/json",authorization},body});
        if(!response.ok) {await response.body?.cancel();res.writeHead(response.status,{"content-type":"application/json"});res.end('{"error":"UPSTREAM_REJECTED"}');return;}
        if(!response.body) throw new Error("UPSTREAM_PROTOCOL");
        const bytes=await readBody(response.body,LIMITS.responseBytes);
        const raw:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
        if(!validUpstream(raw)) throw new Error("UPSTREAM_PROTOCOL");
        entry.usage=raw.usage ?? null;
        res.writeHead(200,{"content-type":"application/json"});res.end(bytes);
      } catch {if(!res.destroyed){res.writeHead(502,{"content-type":"application/json"});res.end('{"error":"UPSTREAM_UNKNOWN"}');}}
      finally {entry.controller.signal.removeEventListener("abort",stop);}
    })();
  });
  server.requestTimeout=LIMITS.deadlineMs;server.headersTimeout=5000;server.maxConnections=8;
  server.listen(options.port,options.host);await once(server,"listening");
  const address=server.address();if(!address || typeof address==="string") throw new Error("EGRESS_BIND");
  const origin=`http://${options.host}:${address.port}`;
  return {
    /** Регистрирует случайную capability, не являющуюся caller requestId или дедупликацией v0. */
    allocate(request: Request, signal: AbortSignal) {
      if(active.size>=LIMITS.concurrency) throw new Failure("OVERLOADED","not_sent");
      const nonce=randomUUID(),controller=new AbortController();
      const entry:Entry={claimed:false,request,controller};
      const abort=()=>controller.abort();signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
      active.set(nonce,entry);
      return {
        apiBase:`${origin}/dispatch/${nonce}`,
        usage:()=>entry.usage,
        async release() {controller.abort();await entry.pending;active.delete(nonce);signal.removeEventListener("abort",abort);}
      };
    },
    /** Закрывает только собственный listener и его активные HTTP-операции. */
    async close() {for(const entry of active.values())entry.controller.abort();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e ? reject(e) : resolve()));}
  };
}
export type EgressGuard = Awaited<ReturnType<typeof createEgressGuard>>;
