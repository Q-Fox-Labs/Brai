// ABOUTME: Публикует безопасные уведомления в существующий JetStream alerts.
// ABOUTME: Собственная связь восстанавливается; только PubAck разрешает удаление из outbox.
import { connect, type NatsConnection } from 'nats';
import { assertDto } from '#transcription-contracts';
import type { NatsSettings } from '../config.js';

/** Ленивая связь использует identity coordinator и свой inbox без управления брокером. */
export function createAlertsPublisher(settings: NatsSettings, timeout: number) {
  let nc: NatsConnection | undefined;
  let connecting: Promise<NatsConnection> | undefined;
  let stopping = false;
  async function connection(): Promise<NatsConnection> {
    if (stopping) throw new Error('ALERTS_PUBLISH_UNAVAILABLE');
    if (nc && !nc.isClosed()) return nc;
    if (!connecting) connecting = connect({ ...settings, timeout, reconnect: true, maxReconnectAttempts: -1,
      reconnectTimeWait: 1000, name: 'transcription_alerts' }).finally(() => { connecting = undefined; });
    nc = await connecting;
    return nc;
  }
  return {
    /** Возвращает после хранения в ожидаемом stream; timeout разрешает прежний immutable повтор. */
    async publish(event: unknown): Promise<void> {
      const valid = assertDto('AlertEvent', event) as any;
      const bytes = Buffer.from(JSON.stringify(valid));
      if (bytes.byteLength > 8192) throw new Error('ALERTS_EVENT_INVALID');
      const active = await connection();
      const ack = await active.jetstream({ timeout }).publish('brai.alerts.v1.ingest', bytes,
        { timeout, msgID: 'transcription/' + valid.id, expect: { streamName: 'BRAI_ALERTS_INGEST_V1' } });
      if (ack.stream !== 'BRAI_ALERTS_INGEST_V1') throw new Error('ALERTS_PUBLISH_UNAVAILABLE');
    },
    /** Закрывает только свою связь и запрещает новые публикации. */
    async close(): Promise<void> {
      stopping = true;
      await connecting?.then(value => { nc = value; }).catch(() => {});
      await nc?.close();
    },
  };
}
