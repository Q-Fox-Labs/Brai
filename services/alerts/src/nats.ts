// ABOUTME: Подключает JetStream ingestion и NATS Services к чистым операциям alerts.
// ABOUTME: Ack следует за commit; broker-ресурсы готовит оператор, сигналы не содержат уведомлений.
import { connect, AckPolicy, DeliverPolicy, DiscardPolicy, ReplayPolicy, RetentionPolicy, StorageType, type ConsumerMessages, type NatsConnection, type ServiceMsg, type JsMsg } from 'nats';
import { randomUUID } from 'node:crypto';
import { errorStatus, limits, subjects, type Operation } from '../contracts/index.mjs';
import { AlertsFault, type AlertsHandlers } from './domain.js';
import type { LoadGate } from './load.js';
import type { Config } from './config.js';

export const streamName = 'BRAI_ALERTS_INGEST_V1';
export const durableName = 'alerts_ingest';
export const gameCoreStreamName = 'BRAI_GAME_CORE_EVENTS_V1';
export const gameCoreDurableName = 'alerts_game_core_events';
const gameCoreSubject = 'brai.game-core.v1.events.>';
const pullExpiresMs = 10_000;
/** Подключает выделенную сервисную identity и собственный inbox. */
export function connectNats(cfg: Config): Promise<NatsConnection> {
  return connect({ servers: cfg.natsServers, user: cfg.natsUser, pass: cfg.natsPassword, inboxPrefix: cfg.natsInboxPrefix, maxReconnectAttempts: -1, timeout: 5_000, name: 'service_alerts' });
}
/** Проверяет предсозданный durable, не выполняя изменение конфигурации брокера. */
export async function checkJetStream(nc: NatsConnection): Promise<void> {
  const manager = await nc.jetstreamManager();
  const { config: stream } = await manager.streams.info(streamName);
  if (stream.storage !== StorageType.File || stream.retention !== RetentionPolicy.Workqueue || stream.discard !== DiscardPolicy.New || stream.max_age !== 0 || stream.max_bytes !== 268_435_456 || stream.max_msg_size !== limits.maxRequestBytes || stream.max_msgs !== -1 || stream.max_msgs_per_subject !== -1 || stream.subjects?.length !== 1 || stream.subjects[0] !== subjects.ingest) throw new Error('ALERTS_STREAM_CONFIG_MISMATCH');
  const { config: consumer } = await manager.consumers.info(streamName, durableName);
  // AIDEV-NOTE: Headers-only превращает валидное событие в пустой payload и приводит к TERM до COMMIT.
  if (consumer.durable_name !== durableName || consumer.ack_policy !== AckPolicy.Explicit || consumer.deliver_policy !== DeliverPolicy.All || consumer.replay_policy !== ReplayPolicy.Instant || consumer.filter_subject !== subjects.ingest || consumer.deliver_subject || consumer.headers_only || (consumer.inactive_threshold ?? 0) !== 0 || consumer.backoff?.length || consumer.max_deliver !== -1 || consumer.ack_wait !== 30_000_000_000 || consumer.max_ack_pending !== limits.active || (consumer.max_expires && consumer.max_expires < pullExpiresMs * 1_000_000) || (consumer.pause_until && Date.parse(consumer.pause_until) > Date.now())) throw new Error('ALERTS_CONSUMER_CONFIG_MISMATCH');
}
function decode(data: Uint8Array): unknown {
  if (data.length > limits.maxRequestBytes) throw new AlertsFault('REQUEST_TOO_LARGE');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { throw new AlertsFault('INVALID_ARGUMENT'); }
}
function fault(error: unknown): AlertsFault { return error instanceof AlertsFault ? error : new AlertsFault('INTERNAL'); }
function log(operation: string, result: string, started: number, metadata: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: 'service_alerts', request_id: randomUUID(), operation, result, duration_ms: Math.round(performance.now() - started), ...metadata }));
}
/** Обрабатывает одну доставку; terminal ошибки удаляются из work queue безопасным term. */
export async function ingestMessage(msg: JsMsg, handlers: AlertsHandlers, gate: LoadGate): Promise<void> {
  const started = performance.now();
  const metadata = { stream_sequence: msg.info.streamSequence, delivery_count: msg.info.deliveryCount };
  try {
    const input = decode(msg.data);
    await gate.run(context => handlers.ingest(input, context));
    msg.ack();
    log('ingest', 'OK', started, metadata);
  } catch (cause) {
    const error = fault(cause);
    if (['INVALID_ARGUMENT', 'REQUEST_TOO_LARGE', 'EVENT_ID_CONFLICT', 'UNKNOWN_TYPE', 'INVALID_CURSOR', 'RESULT_TOO_LARGE', 'NOT_FOUND'].includes(error.code)) msg.term();
    else msg.nak(Math.min(30_000, 1000 * 2 ** Math.min(5, msg.info.deliveryCount - 1)));
    log('ingest', error.code, started, metadata);
  }
}
/** Обрабатывает общий GameCore event; события без notification считаются успешно проигнорированными. */
export async function ingestGameCoreMessage(msg: JsMsg, handlers: AlertsHandlers, gate: LoadGate): Promise<void> {
  try { const input = decode(msg.data); await gate.run(context => handlers.ingestGameCoreEvent(input, context)); msg.ack(); }
  catch (cause) { const error = fault(cause); if (['INVALID_ARGUMENT', 'EVENT_ID_CONFLICT', 'UNKNOWN_TYPE'].includes(error.code)) msg.term(); else msg.nak(Math.min(30_000, 1000 * 2 ** Math.min(5, msg.info.deliveryCount - 1))); }
}
/** Проверяет и подключает durable Alerts consumer общего GameCore stream. */
export async function runGameCoreEvents(nc: NatsConnection, handlers: AlertsHandlers, gate: LoadGate): Promise<{ finished: Promise<void>; stop: () => Promise<void> }> {
  const manager = await nc.jetstreamManager(); const stream = (await manager.streams.info(gameCoreStreamName)).config;
  if (stream.storage !== StorageType.File || stream.retention !== RetentionPolicy.Limits || !stream.subjects?.includes(gameCoreSubject)) throw new Error('ALERTS_GAME_CORE_STREAM_CONFIG_MISMATCH');
  const info = await manager.consumers.info(gameCoreStreamName, gameCoreDurableName); const consumerConfig = info.config;
  if (consumerConfig.ack_policy !== AckPolicy.Explicit || consumerConfig.deliver_policy !== DeliverPolicy.All || consumerConfig.replay_policy !== ReplayPolicy.Instant || consumerConfig.filter_subject !== gameCoreSubject || consumerConfig.max_deliver !== -1 || consumerConfig.headers_only || consumerConfig.deliver_subject) throw new Error('ALERTS_GAME_CORE_CONSUMER_CONFIG_MISMATCH');
  const consumer = await nc.jetstream().consumers.get(gameCoreStreamName, gameCoreDurableName); let messages: ConsumerMessages | undefined; let stopped = false;
  const finished = (async () => { while (!stopped && !nc.isClosed()) { try { messages = await consumer.consume({ max_messages: 1, expires: 1_000 }); for await (const msg of messages) { if (stopped) { msg.nak(); break; } await ingestGameCoreMessage(msg, handlers, gate); } } catch (error) { if (!stopped) console.error(JSON.stringify({ service: 'service_alerts', operation: 'game-core.consume', result: error instanceof Error ? error.name : 'UNKNOWN' })); } finally { messages?.stop(); messages = undefined; } } })();
  return { finished, async stop() { stopped = true; messages?.stop(); await finished; } };
}
/** Регистрирует Services API и ограниченный pull; NATS SDK предоставляет PING/INFO/STATS. */
export async function runNats(nc: NatsConnection, handlers: AlertsHandlers, gate: LoadGate) {
  await handlers.ready();
  await checkJetStream(nc);
  const service = await nc.services.add({ name: 'service_alerts', version: '1.0.0', description: 'Brai personal and common notifications', queue: 'service_alerts' });
  async function handle(operation: Operation, msg: ServiceMsg): Promise<void> {
    const started = performance.now();
    try {
      const input = decode(msg.data);
      const value = await gate.run(context => handlers.execute(operation, input, context));
      const data = Buffer.from(JSON.stringify(value));
      if (data.length > limits.maxResponseBytes) throw new AlertsFault('RESULT_TOO_LARGE');
      msg.respond(data);
      log(operation, 'OK', started, { executor: service.info().id });
    } catch (cause) {
      const error = fault(cause);
      msg.respondError(errorStatus[error.code], error.code, Buffer.from(JSON.stringify({ code: error.code, message: error.code, retryable: error.retryable })));
      log(operation, error.code, started, { executor: service.info().id });
    }
  }
  let messages;
  try {
    for (const operation of ['list', 'get', 'summary', 'read', 'read_all'] as Operation[]) service.addEndpoint(operation, { subject: subjects[operation], queue: 'service_alerts', handler: (error, msg) => { if (!error) void handle(operation, msg); } });
    const consumer = await nc.jetstream().consumers.get(streamName, durableName);
    messages = await consumer.consume({ max_messages: 1, expires: pullExpiresMs, abort_on_missing_resource: true });
  } catch (error) { await service.stop(); throw error; }
  const finished = (async () => { for await (const msg of messages) await ingestMessage(msg, handlers, gate); })();
  // AIDEV-NOTE: Обработчик подключён сразу, чтобы ранний обрыв pull не стал необработанным rejection до сборки runtime.
  void finished.catch(() => {});
  let stopping: Promise<void> | undefined;
  return { service, finished, stop() {
    return stopping ??= (async () => { await messages.close(); await service.stop(); await finished; })();
  } };
}
