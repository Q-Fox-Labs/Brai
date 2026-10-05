// ABOUTME: Проверяет базовый публичный NATS путь каталога, одного embed и одной transcription.
// ABOUTME: Отдельный protected acceptance flag и изолированная fixture config обязательны.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalAiPeer } from './local-ai-peer.mjs';

const input = process.env.LOCAL_AI_PEER_CONFIG_JSON;
const acceptanceVerified = process.env.LOCAL_AI_ACCEPTANCE_VERIFIED === 'true';

test('isolated public NATS peer checks catalog, one embedding, one transcription, and safe errors', {
  skip: (!acceptanceVerified || !input) && 'explicit verified acceptance gate and protected fixture config are required',
}, async () => {
  let config;
  try { config = JSON.parse(input); } catch { throw new Error('LOCAL_AI_PEER_CONFIG_INVALID'); }
  const result = await runLocalAiPeer(config);
  assert.deepEqual(result.verified, [
    'catalog-list', 'catalog-get', 'catalog-search', 'status', 'embedding', 'transcription', 'safe-model-error',
  ]);
});
