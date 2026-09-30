// ABOUTME: Соединяет сохранение результата, публикацию и подтверждение команды.
// ABOUTME: ACK возможен только после успешного сохранения и подтверждённой публикации.
export type Delivery = { subject: string; data: Uint8Array; key: string };
import type { Saved } from "./domain.js";
/** Выполняет save → publish/PubAck → ACK; любая ошибка оставляет доставку неподтверждённой. */
export async function handleDelivery(delivery: Delivery, ports: {save:(delivery:Delivery)=>Promise<Saved>;publish:(saved:Saved)=>Promise<unknown>;ack:()=>void}) {
 const saved=await ports.save(delivery);
 await ports.publish(saved);
 ports.ack();
 return saved;
}
