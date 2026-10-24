// ABOUTME: Подключает NATS Services, JetStream publisher и durable event stream GameCore.
// ABOUTME: ACK outbox выполняется только после PubAck; runtime проверяет готовую конфигурацию брокера.
import { AckPolicy, DeliverPolicy, DiscardPolicy, nanos, RetentionPolicy, ReplayPolicy, StorageType, connect, type NatsConnection, type Service, type ServiceMsg } from "nats";
import { randomUUID } from "node:crypto";
import { errorStatus, limits, subjects, type ErrorCode } from "./contracts.js";
import { GameCoreFault, type GameCoreHandlers } from "./domain.js";
import type { Config } from "./config.js";
import type { GameCoreStore } from "./domain.js";
import type { LoadGate } from "./load.js";

export const streamName = "BRAI_GAME_CORE_EVENTS_V1";
export const publisherDurable = "game_core_outbox_publisher";
const eventSubject = "brai.game-core.v1.events.>";
/** Открывает соединение с NATS; вызывающий владеет его закрытием. */
export function connectNats(cfg: Config): Promise<NatsConnection> { return connect({ servers: cfg.natsServers, user: cfg.natsUser, pass: cfg.natsPassword, inboxPrefix: cfg.natsInboxPrefix, maxReconnectAttempts: -1, timeout: 5_000, name: "service_game_core" }); }
/** Проверяет готовые stream/consumers; несовместимая конфигурация останавливает запуск. */
export async function setupJetStream(nc: NatsConnection, cfg: Config): Promise<void> {
  const manager = await nc.jetstreamManager();
  const stream = (await manager.streams.info(streamName)).config;
  if (stream.storage !== StorageType.File || stream.retention !== RetentionPolicy.Limits || stream.discard !== DiscardPolicy.Old || stream.max_age !== nanos(cfg.eventMaxAgeMs) || stream.max_bytes !== cfg.eventMaxBytes || stream.max_msg_size !== limits.maxRequestBytes || stream.max_msgs !== -1 || stream.max_msgs_per_subject !== -1 || stream.subjects?.length !== 1 || stream.subjects[0] !== eventSubject) throw new Error("GAME_CORE_STREAM_CONFIG_MISMATCH");
  for (const durable of ["history_game_core_events", "alerts_game_core_events"]) {
    const consumer = (await manager.consumers.info(streamName, durable)).config;
    if (consumer.durable_name !== durable || consumer.ack_policy !== AckPolicy.Explicit || consumer.ack_wait !== nanos(cfg.ackWaitMs) || consumer.max_ack_pending !== 8 || consumer.max_deliver !== -1 || consumer.filter_subject !== eventSubject || consumer.deliver_policy !== DeliverPolicy.All || consumer.replay_policy !== ReplayPolicy.Instant || consumer.headers_only || consumer.deliver_subject) throw new Error("GAME_CORE_CONSUMER_CONFIG_MISMATCH");
  }
}
function fault(error: unknown): GameCoreFault { return error instanceof GameCoreFault ? error : new GameCoreFault("INTERNAL"); }
function body(error: GameCoreFault): Buffer { return Buffer.from(JSON.stringify({ code: error.code, message: error.code, retryable: error.retryable })); }
function parse(data: Uint8Array): unknown { if (data.length > limits.maxRequestBytes) throw new GameCoreFault("INVALID_ARGUMENT"); try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); } catch { throw new GameCoreFault("INVALID_ARGUMENT"); } }
async function respond(operation: string, msg: ServiceMsg, handlers: GameCoreHandlers, gate: LoadGate): Promise<void> {
  const started = performance.now(); try { const value = await gate.run(context => { const table: Record<string, (value: unknown, context: any) => Promise<unknown>> = { graph: handlers.graphGet, timeline: handlers.timelineGet, element: handlers.elementGet, moves: handlers.movesAvailable, create: handlers.structureCreate, revise: handlers.elementRevise, claim: handlers.moveClaim, complete: handlers.moveComplete, activate: handlers.elementActivate, fail: handlers.moveFail, link: handlers.moveLink, planningPacket: handlers.planningPacket ?? (async () => { throw new GameCoreFault("FORBIDDEN"); }), planningBind: handlers.planningBind ?? (async () => { throw new GameCoreFault("FORBIDDEN"); }), planningBuild: handlers.planningBuild ?? (async () => { throw new GameCoreFault("FORBIDDEN"); }), planningApply: handlers.planningApply ?? (async () => { throw new GameCoreFault("FORBIDDEN"); }), elementReclassify: handlers.elementReclassify ?? (async () => { throw new GameCoreFault("FORBIDDEN"); }), planningExpandRepeat: handlers.planningExpandRepeat ?? (async () => { throw new GameCoreFault("FORBIDDEN"); }), devStatus: handlers.devStatus ?? (async () => { throw new GameCoreFault("FORBIDDEN"); }) }; const fn = table[operation]; if (!fn) throw new GameCoreFault("INVALID_ARGUMENT"); return fn(parse(msg.data), context); }); const data = Buffer.from(JSON.stringify(value)); if (data.length > limits.maxResponseBytes) throw new GameCoreFault("INTERNAL"); msg.respond(data); console.log(JSON.stringify({ service: "service_game_core", request_id: randomUUID(), operation, duration_ms: Math.round(performance.now() - started), result: "OK" })); } catch (error) { const failure = fault(error); msg.respondError(errorStatus[failure.code as ErrorCode], failure.code, body(failure)); console.log(JSON.stringify({ service: "service_game_core", operation, duration_ms: Math.round(performance.now() - started), result: failure.code })); }
}
async function publishOutbox(nc: NatsConnection, store: GameCoreStore, cfg: Config, stop: () => boolean): Promise<void> {
  const js = nc.jetstream();
  while (!stop()) {
    try {
      const events = await store.pendingOutbox(20);
      if (!events.length) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
      for (const event of events) { if (stop()) return; await js.publish(event.subject, Buffer.from(JSON.stringify(event.payload)), { msgID: event.id }); await store.markOutboxPublished(event.id); }
    } catch (error) { console.error(JSON.stringify({ service: "service_game_core", operation: "outbox.publish", result: error instanceof Error ? error.name : "UNKNOWN" })); await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
}
/** Подключает endpoints и publisher; stop завершает их, не закрывая соединение вызывающего. */
export async function runNats(nc: NatsConnection, handlers: GameCoreHandlers, store: GameCoreStore, cfg: Config, gate: LoadGate): Promise<{ service: Service; finished: Promise<void>; stop: () => Promise<void> }> {
  await handlers.ready(); await setupJetStream(nc, cfg);
  const service = await nc.services.add({ name: "service_game_core", version: "1.0.0", description: "Brai game-core", queue: "service_game_core" });
  const operations: Record<string, string> = { graph: subjects.graph, timeline: subjects.timeline, element: subjects.element, moves: subjects.moves, create: subjects.create, revise: subjects.revise, claim: subjects.claim, complete: subjects.complete, activate: subjects.activate, fail: "brai.game-core.v1.command.fail", link: "brai.game-core.v1.command.link", planningPacket: "brai.game-core.v1.command.planning-packet", planningBind: "brai.game-core.v1.command.planning-bind", planningBuild: "brai.game-core.v1.command.planning-build", planningApply: "brai.game-core.v1.command.planning-apply", elementReclassify: "brai.game-core.v1.command.reclassify", planningExpandRepeat: "brai.game-core.v1.command.planning-expand-repeat", devStatus: "brai.game-core.v1.command.dev-status" };
  for (const [operation, subject] of Object.entries(operations)) service.addEndpoint(operation, { subject, queue: "service_game_core", handler: (error, msg) => { if (!error) void respond(operation, msg, handlers, gate); } });
  let stopping = false; const publisher = publishOutbox(nc, store, cfg, () => stopping);
  const finished = publisher.catch(() => {});
  return { service, finished, async stop() { stopping = true; await service.stop(); await finished; } };
}
