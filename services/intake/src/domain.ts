// ABOUTME: Регистрирует события и передаёт ответственность выбранному исполнителю.
// ABOUTME: Не содержит очередей повторов; успех разрешает подтверждение входного события.
import { inputHash, isJobSuccess } from './contracts.js';
import { Fault, type Binding, type Delivery, type Event, type Data, type Packet, type Ports, type Store } from './types.js';
/** Обрабатывает одно доставленное событие с доверенной идентичностью subject. */
export async function ingest(store: Store, ports: Ports, bindings: Record<string, Binding>, event: Event, delivery: Delivery): Promise<void> {
 const binding = Object.hasOwn(bindings,delivery.source) ? bindings[delivery.source] : undefined;
 if (!binding || event.source !== delivery.source || !binding.types.includes(event.type)) throw new Fault('FORBIDDEN');
 if (event.type === 'operation.result' || event.type === 'processing.resume') { await control(store, ports, binding, event); return; }
 if (event.type === 'event.recorded' && !binding.recipients.includes(String(event.data.recipient))) throw new Fault('FORBIDDEN');
 const packet = await store.register(event, binding, inputHash(event), delivery.receivedAt);
 if (packet.mode === 'temporal') {
  // AIDEV-NOTE: После COMMIT вход остаётся в JetStream до подтверждённого запуска.
  if (packet.state !== 'completed') await ports.startWorkflow(packet);
  return;
 }
 const recipient = String(event.data.recipient);
 if (!Object.hasOwn(packet.dispatch,recipient) || packet.dispatch[recipient] !== true) {
  await ports.publish('brai.intake.v1.dispatch.' + recipient, event, packet.id + '/' + recipient, packet.ownerId);
  await store.update(packet.id, p => { p.dispatch[recipient] = true; p.state = 'forwarded'; });
 }
}
/** Проверяет право и ожидаемый результат перед сигналом существующему workflow. */
async function control(store: Store, ports: Ports, binding: Binding, event: Event): Promise<void> {
 const id = String(event.data.packetId);
 const packet = await store.get(id);
 if (!packet || packet.ownerId !== binding.ownerId) throw new Fault('NOT_FOUND');
 if (event.type === 'processing.resume') {
  if (!binding.resume) throw new Fault('FORBIDDEN');
  const version = Number(event.data.expectedResumeVersion);
  await store.update(id, p => {
   if (p.resumeVersion >= version + 1) return;
   if (p.resumeVersion !== version || p.state !== 'needs_attention') throw new Fault('CONFLICT');
   p.resumeVersion++;
  }, {source:event.source,eventId:event.eventId,inputHash:inputHash(event),ownerId:binding.ownerId});
 } else {
  const operationId = String(event.data.operationId);
  const state = String(event.data.outcome) as 'succeeded' | 'failed' | 'unknown';
  const result = (event.data.result ?? {}) as Data;
  await store.update(id, p => {
   const job = p.jobs[operationId];
   if (!job || job.expectedSource !== event.source) throw new Fault('FORBIDDEN');
   if (job.state === 'succeeded' || job.state === 'failed') {
    if (job.state !== state || inputHash(job.result ?? {}) !== inputHash(result)) throw new Fault('RESULT_CONFLICT');
    return;
   }
   if (state==='succeeded' && !isJobSuccess(p,job,result)) throw new Fault('INVALID_JOB_RESULT');
   if (job.state !== state || inputHash(job.result ?? {}) !== inputHash(result)) {
    job.state = state; job.result = result; job.resultVersion = (job.resultVersion ?? 0) + 1;
   }
  }, {source:event.source,eventId:event.eventId,inputHash:inputHash(event),ownerId:binding.ownerId});
 }
 const current = (await store.get(id))!;
 if (current.state === 'completed') return;
 if (event.type === 'operation.result') {
  const job=current.jobs[String(event.data.operationId)],version=job.resultVersion??0;
  if((job.notifiedVersion??0)<version) {
   await ports.signalWorkflow(current);
   await store.update(id,p=>{const j=p.jobs[job.id];j.notifiedVersion=Math.max(j.notifiedVersion??0,version);});
  }
 } else if((current.resumeNotifiedVersion??0)<current.resumeVersion) {
  await ports.signalWorkflow(current);
  await store.update(id,p=>{p.resumeNotifiedVersion=Math.max(p.resumeNotifiedVersion??0,current.resumeVersion);});
 }
}
/** Возвращает только пакет области доверенного читателя. */
export async function lookup(store: Store, binding: Binding, source: string, eventId: string, expectedHash?: string): Promise<Packet> {
 if (!binding.read) throw new Fault('FORBIDDEN');
 const packet = await store.find(source, eventId);
 if (!packet || packet.ownerId !== binding.ownerId) throw new Fault('NOT_FOUND');
 if (expectedHash && packet.inputHash !== expectedHash) throw new Fault('EVENT_ID_CONFLICT');
 return packet;
}
