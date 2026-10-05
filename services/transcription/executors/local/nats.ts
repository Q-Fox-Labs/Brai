// ABOUTME: Открывает отдельное NATS подключение local executor к owner local-ai.
// ABOUTME: Подключение не повторяет invocation и не использует общие NATS credentials.
import { connect, type NatsConnection } from 'nats';
import type { LocalExecutorConfig } from './config.js';

export type LocalAiConnection = Pick<NatsConnection, 'request' | 'close' | 'isClosed' | 'isDraining'>;

/** Создаёт ленивый provider; ошибки connect остаются до-dispatch состоянием для адаптера. */
export function createLocalAiConnectionProvider(config: LocalExecutorConfig) {
  let connection: NatsConnection | undefined;
  let connecting: Promise<NatsConnection> | undefined;
  let closed = false;

  async function getConnection(): Promise<LocalAiConnection | undefined> {
    if (!config.nats || closed) return undefined;
    if (connection && !connection.isClosed() && !connection.isDraining()) return connection;
    connection = undefined;
    if (!connecting) {
      const nats = config.nats;
      const options = {
        servers: nats.servers,
        inboxPrefix: nats.inboxPrefix,
        timeout: config.controlTimeoutMs,
        maxReconnectAttempts: 0,
        name: 'brai_transcription_local',
        ...(nats.user !== undefined ? { user: nats.user, pass: nats.password } : {}),
        ...(nats.token !== undefined ? { token: nats.token } : {}),
      };
      connecting = connect(options).then((value) => {
        connection = value;
        return value;
      }).finally(() => { connecting = undefined; });
    }
    try {
      const value = await connecting;
      return closed ? undefined : value;
    } catch { return undefined; }
  }

  return {
    configured: config.nats !== undefined,
    getConnection,
    async close(): Promise<void> {
      closed = true;
      const pending = connecting;
      if (pending) {
        try { connection = await pending; } catch { /* Failed connect has no open connection. */ }
      }
      if (connection && !connection.isClosed()) await connection.close().catch(() => {});
      connection = undefined;
    },
  };
}
