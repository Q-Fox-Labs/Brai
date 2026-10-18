// ABOUTME: Соединяет NATS, ядро providers и HTTP-порт LiteLLM.
// ABOUTME: Runtime не устанавливает пакеты, не делает health вызов модели и не печатает payload.
import { connect } from "nats";
import { registerProviders } from "./nats.js";
import { createEgressGuard } from "./egress.js";
import { liteLLMPort } from "./http.js";
const { NATS_URL, LITELLM_URL } = process.env;
if (!NATS_URL || !LITELLM_URL) throw new Error("MISSING_RUNTIME_CONFIGURATION");
const guard = await createEgressGuard({host: "127.0.0.1", port: Number(process.env.PROVIDERS_EGRESS_PORT ?? "18401")});
const nc = await connect({servers: NATS_URL, maxReconnectAttempts: 0, reconnect: false, maxPingOut: 2, timeout: 3000});
const service = await registerProviders(nc, liteLLMPort(LITELLM_URL, guard));
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void service.stop().then(() => nc.drain()).finally(() => guard.close()); });
console.log(JSON.stringify({service: "brai_providers", version: "0.0.1", status: "ready"}));
