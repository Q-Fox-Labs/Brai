// ABOUTME: Подключает только Agent artifacts к отдельно настроенному NATS.
// ABOUTME: Без отдельного URL использует прежнее соединение, не меняя Auth, timer и history.
import { connect, type NatsConnection } from "nats";
import { GatewayError, natsConnection } from "./gateway";
let connection: Promise<NatsConnection> | undefined;

/** Возвращает отдельное соединение artifacts либо локальный legacy transport; не повторяет RPC. */
export async function agentArtifactsConnection(): Promise<NatsConnection> {
  if (!process.env.AGENT_ARTIFACTS_NATS_URL) return natsConnection();
  if (!connection) {
    connection = connect({ servers: process.env.AGENT_ARTIFACTS_NATS_URL,
      user: process.env.AGENT_ARTIFACTS_NATS_USER, pass: process.env.AGENT_ARTIFACTS_NATS_PASSWORD,
      inboxPrefix: process.env.AGENT_ARTIFACTS_NATS_INBOX_PREFIX || "_INBOX.brai_web_agent_artifacts",
      name: "brai_web_agent_artifacts", timeout: 2000, maxReconnectAttempts: -1 });
    void connection.catch(() => { connection = undefined; });
  }
  const nc = await connection;
  if (nc.isClosed()) { connection = undefined; throw new GatewayError(503, "UNAVAILABLE"); }
  return nc;
}
