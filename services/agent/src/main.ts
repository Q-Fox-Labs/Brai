// ABOUTME: Собирает Codex, application, projection и NATS в один запуск agent.
// ABOUTME: Lifecycle закрывает только ресурсы, созданные этим экземпляром.

import { fileURLToPath } from "node:url";
import type { NatsConnection } from "nats";
import { createApplication } from "./application.js";
import type { AgentConfig } from "./config.js";
import { createCodex } from "./codex.js";
import type { CodexPort } from "./ports.js";
import { createProjection } from "./projection.js";
import { connectNats, createNats } from "./nats.js";

export type AgentRuntime = {
  instanceId: string;
  status(): Record<string, unknown>;
  close(): Promise<void>;
};

/** Установленные фабрики нужны тестам; production всегда использует реальные модули. */
export type RuntimeFactories = {
  codex?: (options: { socketUrl: string }) => CodexPort;
  nats?: (config: AgentConfig["nats"]) => Promise<NatsConnection>;
};

/** Запускает собственные подключения, затем публикует готовый NATS service. */
export async function startAgent(config: AgentConfig, options: { factories?: RuntimeFactories; onError?: (error: unknown) => void } = {}): Promise<AgentRuntime> {
  const codex = options.factories?.codex?.(config.codex) ?? createCodex(config.codex);
  let nc: NatsConnection | undefined;
  const projection = createProjection();
  const ownedSubscriptions = new Map<string, string>();
  let observedGeneration: string | null = codex.status().generation;
  const pruneOldSubscriptions = (generation: string | null) => {
    if (!generation || generation === observedGeneration) return;
    observedGeneration = generation;
    for (const [key, ownedGeneration] of ownedSubscriptions)
      if (ownedGeneration !== generation) ownedSubscriptions.delete(key);
  };
  const subscriptionKey = (session: { projectId: string; threadId: string }) => `${session.projectId}\0${session.threadId}`;
  let reconnectAttempts = 0;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let reconnectPromise: Promise<void> | undefined;
  let reconnectEnabled = false;
  const cancelReconnectTimer = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };
  const scheduleReconnect = (delayMs: number) => {
    if (!reconnectEnabled || reconnectTimer || reconnectPromise || codex.status().connection === "connected") return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (!reconnectEnabled || codex.status().connection === "connected") return;
      reconnectPromise = (async () => {
        try {
          await codex.connect();
          reconnectAttempts = 0;
        } catch {
          reconnectAttempts = Math.min(reconnectAttempts + 1, 6);
        }
      })().finally(() => {
        reconnectPromise = undefined;
        if (reconnectEnabled && codex.status().connection !== "connected")
          scheduleReconnect(reconnectAttempts ? Math.min(1000 * (2 ** (reconnectAttempts - 1)), 30000) : 1000);
      });
    }, delayMs);
    reconnectTimer.unref();
  };
  const application = createApplication({
    codex,
    projects: config.projects,
    ...(config.allowedModels === undefined ? {} : { allowedModels: config.allowedModels }),
    ...(config.newThread === undefined ? {} : { newThread: config.newThread }),
    onSubscription: (session, generation) => { ownedSubscriptions.set(subscriptionKey(session), generation); },
    onEvict: async (session, generation) => {
      const key = subscriptionKey(session);
      const ownedGeneration = ownedSubscriptions.get(key);
      if (!ownedGeneration) return "released";
      if (ownedGeneration !== generation) return "unresolved";
      if (codex.status().generation !== generation) {
        if (ownedSubscriptions.get(key) === generation) ownedSubscriptions.delete(key);
        return "released";
      }
      try {
        const result = await codex.call("thread/unsubscribe", { threadId: session.threadId }, { mutation: true, timeoutMs: 3000 }) as { status?: unknown };
        if (result.status !== "notLoaded" && result.status !== "notSubscribed" && result.status !== "unsubscribed") return "unresolved";
        if (ownedSubscriptions.get(key) === generation) ownedSubscriptions.delete(key);
        return "released";
      } catch {
        // One unresolved cleanup owns the slot; the transport never retries it.
        return "unresolved";
      }
    },
    onObservation: (event, session, owner, change) => {
      pruneOldSubscriptions(codex.status().generation);
      projection.onObservation(event, session, owner, change);
      if (event.type === "connection") {
        if (event.status.connection === "connected") {
          cancelReconnectTimer();
          reconnectAttempts = 0;
        } else if (event.status.connection === "disconnected") scheduleReconnect(1000);
      }
    },
    onResync: (session, owner) => projection.onResync(session, owner),
  });
  let transport: Awaited<ReturnType<typeof createNats>> | undefined;
  let closed = false;
  try {
    await codex.connect();
    nc = await (options.factories?.nats?.(config.nats) ?? connectNats(config.nats));
    transport = await createNats({ nc, application, projection, onError: options.onError });
    reconnectEnabled = true;
    if (codex.status().connection !== "connected") scheduleReconnect(1000);
  } catch (error) {
    try { transport && await transport.close(); } catch { /* Continue closing every owned resource. */ }
    try { application.close(); } catch { /* Continue closing every owned resource. */ }
    try { projection.close(); } catch { /* Continue closing every owned resource. */ }
    try { await codex.close(); } catch { /* Startup error remains the reported failure. */ }
    try { if (nc && !nc.isClosed()) await nc.close(); } catch { /* Startup error remains the reported failure. */ }
    throw error;
  }
  const instanceId = transport.instanceId;
  let closePromise: Promise<void> | undefined;
  return {
    instanceId,
    status() {
      return transport!.status();
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      reconnectEnabled = false;
      cancelReconnectTimer();
      closePromise = (async () => {
      let firstError: unknown;
      const run = async (action: () => void | Promise<void>) => {
        try { await action(); } catch (error) { firstError ??= error; }
      };
      await run(() => transport!.close());
      await run(() => application.close());
      if (reconnectPromise) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          reconnectPromise,
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 25000); timer.unref(); }),
        ]);
        if (timer) clearTimeout(timer);
      }
      const currentGeneration = codex.status().generation;
      const cleanup = [...ownedSubscriptions].filter(([, generation]) => generation === currentGeneration);
      await Promise.all(cleanup.map(async ([key, generation]) => {
        const [, threadId] = key.split("\0");
        try {
          const result = await codex.call("thread/unsubscribe", { threadId }, { mutation: true, timeoutMs: 3000 }) as { status?: unknown };
          if ((result.status === "notLoaded" || result.status === "notSubscribed" || result.status === "unsubscribed") && ownedSubscriptions.get(key) === generation) ownedSubscriptions.delete(key);
        } catch { /* Shutdown is final; never retry an unconfirmed unsubscribe. */ }
      }));
      ownedSubscriptions.clear();
      await run(() => projection.close());
      await run(() => codex.close());
      await run(async () => { if (nc && !nc.isClosed()) await nc.close(); });
      if (firstError) throw firstError;
      })();
      return closePromise;
    },
  };
}

function safeFailure(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; name?: unknown };
    if (typeof value.code === "string" && /^[A-Z0-9_-]{1,64}$/.test(value.code)) return value.code;
    if (typeof value.name === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.name)) return value.name;
  }
  return "STARTUP_FAILED";
}

async function runCli(): Promise<void> {
  const { loadConfig } = await import("./config.js");
  const config = await loadConfig();
  const runtime = await startAgent(config, { onError: (error) => console.error(JSON.stringify({ event: "agent.transport_error", code: safeFailure(error) })) });
  const initialStatus = runtime.status();
  console.log(JSON.stringify({ event: initialStatus.ready === true ? "agent.ready" : "agent.started", instanceId: runtime.instanceId }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void runtime.close().catch((error) => {
      console.error(JSON.stringify({ event: "agent.shutdown_error", code: safeFailure(error) }));
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runCli().catch((error) => {
    console.error(JSON.stringify({ event: "agent.startup_error", code: safeFailure(error) }));
    process.exitCode = 1;
  });
}
