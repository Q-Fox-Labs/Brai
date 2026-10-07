// ABOUTME: Отправляет один ограниченный metadata fact через Core NATS.
// ABOUTME: Пропуски учитываются в памяти; доставка не влияет на результат и готовность.
import type { NatsConnection } from 'nats';
import { validateMetadataEvent } from '../../../contracts/index.mjs';
import type { HistoryFactPort } from '../../ports.js';
import type { LocalAiHistoryMetadataEvent } from '../../types.js';

const SUBJECT = 'brai.history.v1.append.local_ai';
const MAX_FACT_BYTES = 4096;
const MAX_PENDING_BYTES = 65536;

type CoreConnection = Pick<NatsConnection, 'publish' | 'isClosed' | 'isDraining'> & {
  // AIDEV-NOTE: Закреплённый nats 2.29.3 не имеет публичного pending-byte API.
  // Отсутствие этого SDK поля закрывает публикацию, а не допускает неограниченный буфер.
  protocol?: { connected: boolean; outbound: { size(): number } };
};

/** Публикует без reply/flush; при разрыве или заполнении SDK буфера считает пропуск. */
export function createHistoryFactPublisher(nats: CoreConnection): HistoryFactPort & {
  diagnostics(): { published: number; skipped: number };
} {
  let published = 0;
  let skipped = 0;
  return {
    publish(event: LocalAiHistoryMetadataEvent): void {
      try {
        if (!validateMetadataEvent(event)) { skipped++; return; }
        const payload = Buffer.from(JSON.stringify(event));
        const protocol = nats.protocol;
        if (payload.length > MAX_FACT_BYTES || nats.isClosed() || nats.isDraining()
          || !protocol?.connected || protocol.outbound.size() + payload.length + SUBJECT.length + 64 > MAX_PENDING_BYTES) {
          skipped++; return;
        }
        nats.publish(SUBJECT, payload);
        published++;
      } catch { skipped++; }
    },
    diagnostics: () => ({ published, skipped }),
  };
}
