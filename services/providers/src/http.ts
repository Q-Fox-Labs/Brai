// ABOUTME: Выполняет одну ограниченную HTTP-отправку штатному LiteLLM Proxy.
// ABOUTME: Не получает ключ TypeSafe, не обращается к провайдеру напрямую.
import { Failure, LIMITS, type DecidePort } from "./core.js";
import type { EgressGuard } from "./egress.js";
import { validDecideUpstream } from "./v1-schema.js";
import { canonical } from "./operations.js";
import type { DecideV1Port, DecideRequest, DecideUpstream } from "./operations.js";
import { validUpstream } from "./schema.js";
/** Возвращает порт /v1/systemone; baseUrl задаёт доверенная конфигурация запуска. */
function transport(baseUrl: string, guard: EgressGuard | undefined, v1: boolean) {
  const url = new URL("/v1/systemone", baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("INVALID_PROXY_URL");
  return async (request: Parameters<DecidePort>[0] | DecideRequest, signal: AbortSignal) => {
    const dispatch = guard?.allocate(request, signal);
    try {
      const response = await fetch(url, {method: "POST", redirect: "error", signal, headers: {"content-type": "application/json"}, body: JSON.stringify({model: request.model, state: request.state, questions: request.questions, num_retries: 0, ...(dispatch ? {api_base: dispatch.apiBase} : {})})});
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
export function liteLLMPort(baseUrl:string,guard?:EgressGuard):DecidePort {return transport(baseUrl,guard,false) as DecidePort;}
/** Полный decide v1 использует тот же одноразовый transport без fallback. */
export function liteLLMDecidePort(baseUrl:string,guard?:EgressGuard):DecideV1Port {return transport(baseUrl,guard,true) as DecideV1Port;}
