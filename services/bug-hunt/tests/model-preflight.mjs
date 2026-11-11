// ABOUTME: Проверяет публичные модельные каталоги перед реализацией систематизации.
// ABOUTME: Выводит только selector и состояния; не читает обращения и не вызывает inference.
import assert from 'node:assert/strict';
import { connect } from 'nats';
import { validateResponse } from '../../local-ai/contracts/index.mjs';

assert.equal(process.env.BUG_HUNT_PREFLIGHT_TARGET, 'dev');
const nc = await connect({
  servers: 'nats://127.0.0.1:4223',
  user: process.env.NATS_USER,
  pass: process.env.NATS_PASSWORD,
  inboxPrefix: '_INBOX.brai_alerts_admin',
  timeout: 3000,
});
const result = { local_ai: null, gemma: null, providers: null, jev: null };
try {
  const request = async (subject, value) => {
    const response = await nc.request(subject, Buffer.from(JSON.stringify(value)), { timeout: 10000 });
    assert.equal(response.headers?.get('Nats-Service-Error') ?? '', '');
    return JSON.parse(Buffer.from(response.data).toString('utf8'));
  };
  const local = await request('brai.local_ai.v1.status', {});
  assert.ok(validateResponse('brai.local_ai.v1.status', local));
  result.local_ai = local.state;
  const card = await request('brai.local_ai.v1.models.get', { modelId: 'embeddinggemma-2-q8' });
  assert.ok(validateResponse('brai.local_ai.v1.models.get', card));
  result.gemma = {
    modelId: card.modelId, revision: card.revision, profileId: card.profileId,
    installationState: card.installationState, runtimeState: card.runtimeState,
    embed: card.embed, supported: card.supported,
  };
  const providers = await request('brai.providers.v1.status', {});
  result.providers = { ready: providers.ready, active: providers.active, capacity: providers.capacity };
  const jev = await request('brai.providers.v1.models.get', { provider: 'typesafe', model: 'jev-1.13.0' });
  result.jev = jev;
  console.log(JSON.stringify(result));
  assert.equal(local.state, 'ready');
  assert.equal(card.modelId, 'embeddinggemma-2-q8');
  assert.equal(card.revision, 'bfcd298762cc34d0357ece5ebdd31791a3a374d8');
  assert.equal(card.profileId, 'embeddinggemma2_llama_cpp');
  assert.equal(card.installationState, 'installed');
  assert.equal(card.supported, true);
  assert.equal(providers.ready, true);
} catch {
  console.error(JSON.stringify({ code: 'MODEL_PREFLIGHT_FAILED', catalogs: result }));
  process.exitCode = 1;
} finally {
  await nc.close();
}
