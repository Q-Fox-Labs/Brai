// ABOUTME: Сохраняет оригинал и предметное состояние пакета в собственной PostgreSQL-схеме.
// ABOUTME: Транзакционные блокировки защищают параллельные результаты; очередей повторов нет.
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Fault, type Binding, type Event, type Packet, type Reject, type Store } from './types.js';
/** Создаёт PostgreSQL адаптер; пул принадлежит вызывающей программе. */
export function createStore(pool: Pool): Store {
 async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect(),clientError=()=>{};
  c.on('error',clientError);
  try { await c.query('BEGIN'); const result = await work(c); await c.query('COMMIT'); return result; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.removeListener('error',clientError);c.release(); }
 }
 const get = async (id: string): Promise<Packet | null> => (await pool.query('SELECT body FROM intake.intake_packets WHERE id=$1',[id])).rows[0]?.body ?? null;
 const find = async (source: string, eventId: string): Promise<Packet | null> => (await pool.query('SELECT body FROM intake.intake_packets WHERE source=$1 AND event_id=$2',[source,eventId])).rows[0]?.body ?? null;
 return {
  get, find,
  async ready() { await pool.query('SELECT id FROM intake.intake_packets LIMIT 0'); await pool.query('SELECT source FROM intake.intake_control_events LIMIT 0'); },
  async register(event: Event, binding: Binding, hash: string, acceptedAt?: string) {
   return transaction(async c => {
    // AIDEV-NOTE: Advisory lock живёт только в транзакции; это сериализация ключа, не lease/очередь.
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[event.source + '/' + event.eventId]);
    const prior = (await c.query('SELECT body FROM intake.intake_packets WHERE source=$1 AND event_id=$2',[event.source,event.eventId])).rows[0]?.body as Packet | undefined;
    if ((await c.query('SELECT 1 FROM intake.intake_control_events WHERE source=$1 AND event_id=$2',[event.source,event.eventId])).rowCount) throw new Fault('EVENT_ID_CONFLICT');
    if (prior) { if (prior.inputHash !== hash || prior.ownerId !== binding.ownerId) throw new Fault('EVENT_ID_CONFLICT'); return prior; }
    let receiptId: string | null = null;
    const mode = event.type === 'event.recorded' ? 'jetstream' : 'temporal';
    if (mode === 'temporal') {
     const result = await c.query('INSERT INTO intake.intake_receipts(id,owner_id,source,material_id,current_revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,source,material_id) DO UPDATE SET current_revision=GREATEST(intake.intake_receipts.current_revision,EXCLUDED.current_revision) RETURNING id',[randomUUID(),binding.ownerId,event.source,event.data.materialId,event.data.revision]);
     receiptId = result.rows[0].id;
     const duplicate = await c.query("SELECT id FROM intake.intake_packets WHERE receipt_id=$1 AND (body->'original'->'data'->>'revision')::integer=$2",[receiptId,event.data.revision]);
     if(duplicate.rowCount) throw new Fault('MATERIAL_REVISION_CONFLICT');
    }
    const id = randomUUID();
    const receivedAt = acceptedAt ?? (await c.query('SELECT now() AS time')).rows[0].time.toISOString();
    const packet: Packet = {id,ownerId:binding.ownerId,source:event.source,eventId:event.eventId,inputHash:hash,original:event,receiptId,receivedAt,mode,scenario:mode === 'jetstream' ? 'forward.v1' : event.type === 'message.incoming' ? 'incoming.v1' : 'outgoing.v1',state:'registered',workflowId:mode === 'temporal' ? 'intake/v1/' + id : null,jobs:{},attempts:{},dispatch:{},resumeVersion:0,reason:null};
    await c.query('INSERT INTO intake.intake_packets(id,owner_id,source,event_id,input_hash,receipt_id,body) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,binding.ownerId,event.source,event.eventId,hash,receiptId,packet]);
    return packet;
   });
  },
  async update(id, change, control) {
   return transaction(async c => {
    let replay=false;
    if(control) {
     await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[control.source+'/'+control.eventId]);
     if((await c.query('SELECT 1 FROM intake.intake_packets WHERE source=$1 AND event_id=$2',[control.source,control.eventId])).rowCount) throw new Fault('EVENT_ID_CONFLICT');
     const prior=(await c.query('SELECT owner_id,input_hash,packet_id FROM intake.intake_control_events WHERE source=$1 AND event_id=$2',[control.source,control.eventId])).rows[0];
     if(prior) {
      if(prior.owner_id!==control.ownerId || prior.input_hash!==control.inputHash || prior.packet_id!==id) throw new Fault('EVENT_ID_CONFLICT');
      replay=true;
     }
    }
    const p = (await c.query('SELECT body FROM intake.intake_packets WHERE id=$1 FOR UPDATE',[id])).rows[0]?.body as Packet | undefined;
    if (!p || (control && p.ownerId!==control.ownerId)) throw new Fault('NOT_FOUND');
    if(replay) return p;
    const original = JSON.stringify(p.original), prepared = p.prepared && JSON.stringify(p.prepared), context=p.context && JSON.stringify(p.context),contactRequest=p.contactRequest&&JSON.stringify(p.contactRequest),contact=p.contact&&JSON.stringify(p.contact),contactDiagnostics=p.contactDiagnostics&&JSON.stringify(p.contactDiagnostics);
    change(p);
    if (JSON.stringify(p.original) !== original || (prepared && JSON.stringify(p.prepared) !== prepared) || (context && JSON.stringify(p.context)!==context) || (contactRequest && JSON.stringify(p.contactRequest)!==contactRequest) || (contact && JSON.stringify(p.contact)!==contact) || (contactDiagnostics && JSON.stringify(p.contactDiagnostics)!==contactDiagnostics)) throw new Fault('IMMUTABLE_INPUT');
    await c.query('UPDATE intake.intake_packets SET body=$2 WHERE id=$1',[id,p]);
    if(control) await c.query('INSERT INTO intake.intake_control_events(source,event_id,owner_id,input_hash,packet_id) VALUES($1,$2,$3,$4,$5)',[control.source,control.eventId,control.ownerId,control.inputHash,id]);
    return p;
   });
  },
  async rejection(source,sequence) {
   const r=(await pool.query('SELECT * FROM intake.intake_rejections WHERE source=$1 AND sequence=$2',[source,sequence])).rows[0];
   return r?{delivery:{stream:r.stream,sequence:Number(r.sequence),source:r.source},ownerId:r.owner_id,eventId:r.event_id,hash:r.input_hash,code:r.code}:null;
  },
  async reject(r: Reject) {
   await pool.query('INSERT INTO intake.intake_rejections(stream,sequence,source,owner_id,event_id,input_hash,code) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[r.delivery.stream,r.delivery.sequence,r.delivery.source,r.ownerId,r.eventId,r.hash,r.code]);
  }
 };
}
