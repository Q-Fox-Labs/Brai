// ABOUTME: Запускает один Core NATS подписчик событий agent на процесс web.
// ABOUTME: Использует общее NATS соединение; ensure ждёт subscribe текущего соединения.
import { natsConnection } from "./gateway";
import { AgentHub } from "./agent-hub";
import { validateEventEnvelope, subjects, limits } from "@brai/agent/contracts";
import type { EventEnvelope } from "@brai/agent/contracts";

const key = Symbol.for("brai.web.agent-runtime.v1");
type AgentRuntime = { hub: AgentHub; ensure: () => Promise<void> };
const globals = globalThis as typeof globalThis & { [key]?: AgentRuntime };

/** Возвращает общий process-local hub и удостоверяется, что Core NATS уже подписан. */
export function agentRuntime(): AgentRuntime {
  if (globals[key]) return globals[key];
  const hub = new AgentHub();
  let current: Awaited<ReturnType<typeof natsConnection>> | undefined;
  const watched = new WeakSet<object>();
  const state: AgentRuntime = {
    hub,
    async ensure() {
      const nc = await natsConnection();
      if (current === nc) return;
      const subscription = nc.subscribe(subjects.event);
      hub.disconnect();
      current = nc;
      if (!watched.has(nc)) {
        watched.add(nc);
        void (async () => { for await (const status of nc.status()) {
          if (status.type === "disconnect" || status.type === "reconnect" || status.type === "error") hub.disconnect();
        } })();
      }
      void (async () => {
        try {
          for await (const message of subscription) {
            try {
              if (message.data.byteLength > limits.natsSseFrameBytes) throw new Error("EVENT_TOO_LARGE");
              const value: unknown = JSON.parse(Buffer.from(message.data).toString("utf8"));
              if (!validateEventEnvelope(value)) throw new Error("BAD_EVENT");
              hub.broadcast(value as EventEnvelope);
            } catch { hub.disconnect(); console.error(JSON.stringify({ operation: "web_agent_events", error: "BAD_EVENT" })); }
          }
        } catch { hub.disconnect(); }
        finally { if (current === nc) current = undefined; }
      })();
    },
  };
  globals[key] = state;
  return state;
}

/** Закрывает потоки после подтверждённого выхода пользователя без запуска NATS. */
export function invalidateAgentSession(sessionId: string): void { globals[key]?.hub.invalidate(sessionId); }
