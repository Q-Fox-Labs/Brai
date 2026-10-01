// ABOUTME: Проверяет фактическую готовность работающего agent через его status endpoint.
// ABOUTME: Одного ответа NATS PING недостаточно; health также требует Codex readiness.

import { fileURLToPath } from "node:url";
import { ServiceErrorCodeHeader, ServiceErrorHeader } from "nats";
import { limits, subjects, validateDto } from "../contracts/index.mjs";
import { connectNats } from "./nats.js";
import { loadConfig } from "./config.js";

/** Возвращает успешный код только для DTO статуса с ready=true. */
export async function checkHealth(): Promise<boolean> {
  const config = await loadConfig();
  const nc = await connectNats(config.nats);
  try {
    const response = await nc.request(subjects.status, Buffer.from("{}"), { timeout: limits.readTimeoutMs });
    if (response.headers?.has(ServiceErrorHeader) || response.headers?.has(ServiceErrorCodeHeader)) return false;
    let status: unknown;
    try { status = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.data)); } catch { return false; }
    return validateDto("StatusResponse", status) && (status as { ready: boolean }).ready === true;
  } finally {
    if (!nc.isClosed()) await nc.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void checkHealth().then((ready) => {
    console.log(ready ? "agent ready" : "agent unavailable");
    if (!ready) process.exitCode = 1;
  }, () => {
    console.error("agent unavailable");
    process.exitCode = 1;
  });
}
