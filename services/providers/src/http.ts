// ABOUTME: Выполняет одну ограниченную HTTP-отправку штатному LiteLLM Proxy.
// ABOUTME: Не получает ключ TypeSafe, не обращается к провайдеру напрямую.
import { Failure, LIMITS, type DecidePort } from "./core.js";
import type { EgressGuard } from "./egress.js";
import { validDecideUpstream } from "./v1-schema.js";
import { canonical } from "./operations.js";
import type { DecideV1Port, DecideRequest, DecideUpstream } from "./operations.js";
import { validUpstream } from "./schema.js";
import { chatWire, consumeSse, createChatAssembler, type ChatPort } from "./chat.js";
/** Возвращает порт /v1/systemone; baseUrl задаёт доверенная конфигурация запуска. */
function transport(baseUrl: string, guard: EgressGuard | undefined, v1: boolean, apiKey?: string) {
  const url = new URL("/v1/systemone", baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("INVALID_PROXY_URL");
  return async (request: Parameters<DecidePort>[0] | DecideRequest, signal: AbortSignal) => {
    const dispatch = guard?.allocate(request, signal);
    try {
      const response = await fetch(url, {method: "POST", redirect: "error", signal, headers: {"content-type": "application/json", ...(apiKey ? {authorization:`Bearer ${apiKey}`} : {})}, body: JSON.stringify({model: request.model, state: request.state, questions: request.questions, num_retries: 0, ...(dispatch ? {api_base: dispatch.apiBase} : {})})});
      if (!response.ok) {
        await response.body?.cancel();
        throw new Failure(response.status === 401 || response.status === 403 ? "UPSTREAM_ACCESS" : response.status === 429 ? "UPSTREAM_RATE_LIMIT" : "UPSTREAM_FAILURE", response.status >= 500 ? "unknown" : "failed");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Failure("UPSTREAM_PROTOCOL", "unknown");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > (v1 ? 65536 : LIMITS.responseBytes)) { await reader.cancel(); throw new Failure("UPSTREAM_PROTOCOL", "unknown"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const data: unknown = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(Buffer.concat(chunks)));
      if (!(v1 ? validDecideUpstream(data) : validUpstream(data))) throw new Failure("UPSTREAM_PROTOCOL", "unknown");
      if (dispatch) {
        const rawUsage = dispatch.usage();
        if (v1) {
          const raw=dispatch.raw(),normalized=data as DecideUpstream;
          if(!raw || raw.model!==normalized.model || canonical(raw.answers)!==canonical(normalized.answers)) throw new Failure("UPSTREAM_PROTOCOL","unknown");
        }
        if (rawUsage === undefined) throw new Failure("UPSTREAM_PROTOCOL", "unknown");
        (data as DecideUpstream).usage = rawUsage;
      }
      return data;
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw new Failure("OUTCOME_UNKNOWN", "unknown");
    } finally { await dispatch?.release(); }
  };
}

/** Порт v0 сохраняет закрытую форму noul. */
export function liteLLMPort(baseUrl:string,guard?:EgressGuard,apiKey?:string):DecidePort {return transport(baseUrl,guard,false,apiKey) as DecidePort;}
/** Полный decide v1 использует тот же одноразовый transport без fallback. */
export function liteLLMDecidePort(baseUrl:string,guard?:EgressGuard,apiKey?:string):DecideV1Port {return transport(baseUrl,guard,true,apiKey) as DecideV1Port;}

/** Одна streaming отправка stock Proxy; raw egress остаётся источником usage и opaque provider state. */
export function liteLLMChatPort(baseUrl:string,guard:EgressGuard,apiKey?:string):ChatPort {
  const url=new URL("/v1/chat/completions",baseUrl);
  if(!["http:","https:"].includes(url.protocol)||url.username||url.password)throw new Error("INVALID_PROXY_URL");
  return async(input,messages,signal,emit)=>{
    const dispatch=guard.allocate(input,signal,messages);
    try{
      const response=await fetch(url,{method:"POST",redirect:"error",signal,headers:{"content-type":"application/json",...(apiKey?{authorization:`Bearer ${apiKey}`}:{})},body:JSON.stringify({...chatWire(input,messages),num_retries:0,max_retries:0,api_base:dispatch.apiBase})});
      if(!response.ok){await response.body?.cancel();throw new Failure(response.status===401||response.status===403?"UPSTREAM_ACCESS":response.status===429?"UPSTREAM_RATE_LIMIT":"UPSTREAM_FAILURE",response.status>=500?"unknown":"failed");}
      if(!response.body)throw new Failure("UPSTREAM_PROTOCOL","unknown");
      const assembler=createChatAssembler(input,event=>{if(event.type!=="usage"&&event.type!=="tool_call.ready")emit(event);});
      await consumeSse(response.body,assembler.push);const normalized=assembler.finish(),raw=dispatch.chat();
      if(!raw||raw.actualModel!==normalized.actualModel||raw.text!==normalized.text||canonical(raw.toolCalls)!==canonical(normalized.toolCalls)||raw.finishReason!==normalized.finishReason)throw new Failure("UPSTREAM_PROTOCOL","unknown");
      for(const call of raw.toolCalls)emit({type:"tool_call.ready",call});
      if(raw.usage!==null)emit({type:"usage",usage:raw.usage});
      return raw;
    }catch(error){if(error instanceof Failure)throw error;throw new Failure("OUTCOME_UNKNOWN","unknown");}
    finally{await dispatch.release();}
  };
}
