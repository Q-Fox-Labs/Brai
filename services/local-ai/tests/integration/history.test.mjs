// ABOUTME: Проверяет однократную Core NATS публикацию и ограниченные пропуски истории.
// ABOUTME: Фейк не имеет request/flush, чтобы исключить скрытое ожидание получателя.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryFactPublisher } from '../../dist/adapters/history/index.js';

const fact = {
  id: '4c8eac73-55de-4414-8b0e-4a7a495a0891', type_id: 1201, occurred_at: '2026-10-05T20:15:30.000Z',
  actor_id: 'user-1', scope_type: 'user', scope_id: 'user-1', object_type: 'operation', object_id: 'operation-1',
  data: { operation: 'invoke', modelId: 'embedder', outcome: 'succeeded', durationMs: 5 },
};
function connection() {
  const sent = [];
  return { sent, closed: false, draining: false, pending: 0,
    isClosed() { return this.closed; }, isDraining() { return this.draining; },
    protocol: { connected: true, outbound: { size: () => 0 } },
    publish(subject, payload) { sent.push({ subject, body: JSON.parse(payload.toString()), argc: arguments.length }); },
  };
}
// Размер SDK буфера принадлежит конкретному соединению.
function fixture() {
  const nc = connection();
  nc.protocol.outbound.size = () => nc.pending;
  return nc;
}
test('one bounded final fact uses existing subject without reply or acknowledgement', () => {
  const nc = fixture(); const publisher = createHistoryFactPublisher(nc);
  assert.equal(publisher.publish(fact), undefined);
  assert.deepEqual(nc.sent, [{ subject: 'brai.history.v1.append.local_ai', body: fact, argc: 2 }]);
  assert.deepEqual(publisher.diagnostics(), { published: 1, skipped: 0 });
});
test('disconnected/full/invalid/throwing publisher skips without retry and reconnect resumes only new facts', () => {
  const nc = fixture(); const publisher = createHistoryFactPublisher(nc);
  nc.protocol.connected = false; publisher.publish(fact);
  nc.protocol.connected = true; nc.pending = 65536; publisher.publish(fact);
  nc.pending = 0; publisher.publish({ ...fact, data: { ...fact.data, text: 'private sentinel' } });
  nc.publish = () => { throw new Error('write failure'); }; assert.doesNotThrow(() => publisher.publish(fact));
  nc.publish = (subject, payload) => nc.sent.push({ subject, payload }); publisher.publish(fact);
  assert.equal(nc.sent.length, 1);
  assert.deepEqual(publisher.diagnostics(), { published: 1, skipped: 4 });
  delete nc.protocol; publisher.publish(fact);
  assert.deepEqual(publisher.diagnostics(), { published: 1, skipped: 5 });
});
