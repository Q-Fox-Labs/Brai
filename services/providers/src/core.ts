// ABOUTME: Ограничивает синхронное решение v0 и проверяет ответ порта модели.
// ABOUTME: Не знает HTTP/NATS и никогда не повторяет вычисление.
export const MODEL = "jev-1.13.0";
export const LIMITS = Object.freeze({ requestBytes: 32768, responseBytes: 16384, concurrency: 2, deadlineMs: 30000 });
export type Request = { requestId: string; ownerId: string; provider: "typesafe"; model: string; state: string; questions: Record<string, {type: "noul"; instructions: string}>; deadlineAt: string };
export type Upstream = { model: string; answers: Record<string, {type: "noul"; noul: number}>; usage?: {input_tokens: number; output_tokens: number} | null };
export type Response = { requestId: string; provider: "typesafe"; requestedModel: string; actualModel: string; answers: Upstream["answers"]; usage: {inputTokens: number; outputTokens: number} | null };
export type DecidePort = (request: Request, signal: AbortSignal) => Promise<Upstream>;
/** Безопасный код на границе; unknown никогда не разрешает автоматический повтор. */
export class Failure extends Error {
  constructor(readonly code: string, readonly outcome: "not_sent" | "failed" | "unknown") { super(code); }
}
/** Создаёт независимое ядро с двумя слотами, без очереди и без дедупликации. */
export function createDecider(port: DecidePort, now = Date.now) {
  let active = 0;
  return async (request: Request): Promise<Response> => {
    if (request.model !== MODEL) throw new Failure("MODEL_NOT_ALLOWED", "not_sent");
    const remaining = Math.min(Date.parse(request.deadlineAt) - now(), LIMITS.deadlineMs);
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Failure("DEADLINE_EXCEEDED", "not_sent");
    if (active >= LIMITS.concurrency) throw new Failure("OVERLOADED", "not_sent");
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const result = await port(request, controller.signal);
      if (controller.signal.aborted || now() >= Date.parse(request.deadlineAt)) throw new Failure("OUTCOME_UNKNOWN", "unknown");
      if (result.model !== MODEL || Object.keys(result.answers).length !== 1 || !Object.hasOwn(result.answers, Object.keys(request.questions)[0])) throw new Failure("UPSTREAM_PROTOCOL", "unknown");
      return {requestId: request.requestId, provider: "typesafe", requestedModel: request.model, actualModel: result.model, answers: result.answers, usage: result.usage == null ? null : {inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens}};
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw new Failure("OUTCOME_UNKNOWN", "unknown");
    } finally {
      clearTimeout(timer);
      // AIDEV-NOTE: Слот освобождается после остановки порта, а не по одному таймеру.
      active--;
    }
  };
}
