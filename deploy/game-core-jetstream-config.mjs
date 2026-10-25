// ABOUTME: Закрепляет JetStream stream и durable consumers для событий GameCore.
// ABOUTME: Конфигурация используется только инфраструктурным provision/verify helper.
import { AckPolicy, DeliverPolicy, DiscardPolicy, nanos, RetentionPolicy, ReplayPolicy, StorageType } from "nats";

export const streamConfig = Object.freeze({
  name: "BRAI_GAME_CORE_EVENTS_V1",
  subjects: ["brai.game-core.v1.events.>"],
  retention: RetentionPolicy.Limits,
  storage: StorageType.File,
  discard: DiscardPolicy.Old,
  max_bytes: 65_536,
  max_age: nanos(7 * 24 * 60 * 60 * 1000),
  max_msg_size: 65_536,
  max_msgs: -1,
  max_msgs_per_subject: -1,
  num_replicas: 1,
});

export const consumerConfigs = Object.freeze([
  "history_game_core_events",
  "alerts_game_core_events",
].map((durable_name) => Object.freeze({
  durable_name,
  ack_policy: AckPolicy.Explicit,
  ack_wait: nanos(30_000),
  deliver_policy: DeliverPolicy.All,
  replay_policy: ReplayPolicy.Instant,
  filter_subject: "brai.game-core.v1.events.>",
  max_ack_pending: 8,
  max_deliver: -1,
})));
