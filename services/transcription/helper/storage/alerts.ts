// ABOUTME: Выполняет атомарные резервы, эпизоды и lease очереди уведомлений в транзакции helper.
// ABOUTME: Получает существующий SQL client; NATS и вычисление здесь отсутствуют.
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { assertDto } from '#transcription-contracts';
import { incidentEvent, requestEvent } from '../../notifications.js';
import type { IncidentKey } from '../../notifications.js';

/** Операции очереди вызываются только под общим advisory lock транзакции metadata. */
export function createAlertsStore(capacity: number, leaseMs: number, fail: (code: string) => never) {
  async function reserve(client: PoolClient, requestId: string): Promise<void> {
    await client.query("INSERT INTO transcription.alerts_outbox(delivery_id,request_id,state) VALUES($1,$2,'reserved')", [randomUUID(), requestId]);
  }
  async function hasCapacity(client: PoolClient): Promise<boolean> {
    const result = await client.query('SELECT count(*)::integer AS used FROM transcription.alerts_outbox WHERE request_id IS NOT NULL');
    return result.rows[0].used < capacity;
  }
  async function release(client: PoolClient, requestId: string): Promise<void> {
    await client.query("DELETE FROM transcription.alerts_outbox WHERE request_id=$1 AND state='reserved'", [requestId]);
  }
  async function problem(client: PoolClient, record: any, now: string): Promise<void> {
    const slot = (await client.query('SELECT * FROM transcription.alerts_outbox WHERE request_id=$1 FOR UPDATE', [record.requestId])).rows[0];
    if (!slot || slot.state !== 'reserved') return fail('STATE_CONFLICT');
    const event = requestEvent(record, slot.delivery_id, now);
    await client.query("UPDATE transcription.alerts_outbox SET state='pending',event=$2 WHERE delivery_id=$1", [slot.delivery_id, event]);
  }
  async function observe(client: PoolClient, params: any, now: string): Promise<any> {
    const previous = (await client.query('SELECT * FROM transcription.alerts_incidents WHERE key=$1 FOR UPDATE', [params.key])).rows[0];
    if (params.available) {
      await client.query("INSERT INTO transcription.alerts_incidents(key,active,event) VALUES($1,false,NULL) ON CONFLICT(key) DO UPDATE SET active=false,event=NULL", [params.key]);
      return { event: null };
    }
    if (previous?.active) return { event: assertDto('AlertEvent', previous.event) };
    // AIDEV-NOTE: Пока прежний эпизод не отправлен, колебания зависимости объединяются в его стабильное событие.
    const pending = (await client.query('SELECT event FROM transcription.alerts_outbox WHERE incident_key=$1 FOR UPDATE', [params.key])).rows[0];
    const event = pending?.event ?? incidentEvent(params.key as IncidentKey, params.eventId ?? randomUUID(), params.occurredAt ?? now);
    assertDto('AlertEvent', event);
    if (!pending) await client.query("INSERT INTO transcription.alerts_outbox(delivery_id,incident_key,state,event) VALUES($1,$2,'pending',$3)", [event.id, params.key, event]);
    await client.query('INSERT INTO transcription.alerts_incidents(key,active,event) VALUES($1,true,$2) ON CONFLICT(key) DO UPDATE SET active=true,event=EXCLUDED.event', [params.key,event]);
    return { event };
  }
  async function execute(client: PoolClient, method: string, params: any): Promise<any> {
    if (method === 'alerts.claim') {
      const row = (await client.query("SELECT * FROM transcription.alerts_outbox WHERE (state='pending' AND next_attempt_at<=clock_timestamp()) OR (state='claimed' AND lease_expires_at<=clock_timestamp()) ORDER BY next_attempt_at,delivery_id LIMIT 1 FOR UPDATE SKIP LOCKED")).rows[0];
      if (!row) return null;
      const token = randomUUID();
      await client.query("UPDATE transcription.alerts_outbox SET state='claimed',claim_token=$2,lease_expires_at=clock_timestamp()+($3::bigint * interval '1 millisecond') WHERE delivery_id=$1", [row.delivery_id,token,leaseMs]);
      return { deliveryId: row.delivery_id, claimToken: token, event: assertDto('AlertEvent', row.event) };
    }
    const row = (await client.query('SELECT *,lease_expires_at>clock_timestamp() AS live FROM transcription.alerts_outbox WHERE delivery_id=$1 FOR UPDATE', [params.deliveryId])).rows[0];
    if (!row || row.state !== 'claimed' || !row.live || row.claim_token !== params.claimToken.toLowerCase()) return fail('STALE_CLAIM');
    if (method === 'alerts.ack') {
      await client.query('DELETE FROM transcription.alerts_outbox WHERE delivery_id=$1',[params.deliveryId]);
      return { acknowledged: true };
    }
    await client.query("UPDATE transcription.alerts_outbox SET state='pending',claim_token=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp()+($2::bigint * interval '1 millisecond') WHERE delivery_id=$1",[params.deliveryId,params.retryDelayMs]);
    return { failed: true };
  }
  return { reserve, hasCapacity, release, problem, observe, execute };
}
