// ABOUTME: Публикует единственный endpoint providers v0 через NATS Services.
// ABOUTME: Владелец caller доверенный; прямой DTO не является авторизацией.
import type { NatsConnection } from "nats";
import { Failure, LIMITS, createDecider, type DecidePort } from "./core.js";
import { validRequest, validResponse } from "./schema.js";
export const SUBJECT = "brai.providers.v0.invoke.decide";
/** Регистрирует сервис; stop/drain принадлежат месту сборки. Нет платных health calls. */
export async function registerProviders(nc: NatsConnection, port: DecidePort) {
  const decide = createDecider(port);
  const service = await nc.services.add({name: "brai_providers", version: "0.0.1", description: "Isolated synchronous decide v0", queue: "brai_providers"});
  service.addEndpoint("decide", {subject: SUBJECT, handler: async (_error, message) => {
    try {
      if (message.data.byteLength > LIMITS.requestBytes) throw new Failure("INVALID_REQUEST", "not_sent");
      let input: unknown;
      try { input = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(message.data)); } catch { throw new Failure("INVALID_REQUEST", "not_sent"); }
      if (!validRequest(input)) throw new Failure("INVALID_REQUEST", "not_sent");
      const result = await decide(input);
      if (!validResponse(result)) throw new Failure("UPSTREAM_PROTOCOL", "unknown");
      message.respond(JSON.stringify(result));
    } catch (error) {
      const safe = error instanceof Failure ? error : new Failure("OUTCOME_UNKNOWN", "unknown");
      message.respondError(500, safe.code, new TextEncoder().encode(JSON.stringify({code: safe.code, outcome: safe.outcome})));
    }
  }});
  return service;
}
