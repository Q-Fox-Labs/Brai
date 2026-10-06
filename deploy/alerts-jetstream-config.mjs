// ABOUTME: Задаёт общие закреплённые JetStream параметры для fixture и будущего provisioning.
// ABOUTME: Описывает только alerts stream/consumer; не соединяется с broker.
import {nanos,RetentionPolicy,StorageType,DiscardPolicy,AckPolicy,DeliverPolicy,ReplayPolicy} from "nats";
/** Неизменяемый stream входных сообщений alerts с отказом при переполнении. */
export const streamConfig=Object.freeze({name:"BRAI_ALERTS_INGEST_V1",subjects:["brai.alerts.v1.ingest"],retention:RetentionPolicy.Workqueue,storage:StorageType.File,discard:DiscardPolicy.New,max_bytes:268435456,max_age:0,max_msg_size:65536,max_msgs:-1,max_msgs_per_subject:-1,num_replicas:1});
/** Pull consumer подтверждает commit; повторная доставка не имеет ограниченного количества попыток. */
export const consumerConfig=Object.freeze({durable_name:"alerts_ingest",ack_policy:AckPolicy.Explicit,ack_wait:nanos(30000),deliver_policy:DeliverPolicy.All,replay_policy:ReplayPolicy.Instant,filter_subject:"brai.alerts.v1.ingest",max_ack_pending:8,max_deliver:-1});
