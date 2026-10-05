// ABOUTME: Проверяет реальный публичный поиск Hugging Face без авторизации.
// ABOUTME: Включается отдельно, чтобы изолированные integration-запуски не зависели от внешней сети.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHuggingFaceCatalog } from '../../dist/install/huggingface.js';
import { validateSchema } from '../../contracts/index.mjs';

const enabled = process.env.BRAI_HF_PUBLIC_INTEGRATION === '1';
const profile = {
  profileId: 'known_profile', modelId: 'known-model', repository: 'known-org/known-model',
  revision: 'a'.repeat(40), files: [{ path: 'model.bin', bytes: 1, sha256: '0'.repeat(64) }],
  record: {
    modelId: 'known-model', name: 'known model', description: '', source: 'known-org/known-model',
    license: null, revision: 'a'.repeat(40), profileId: 'known_profile', supported: true,
    operations: ['embed'], languages: [], inputKinds: ['text'], outputKinds: ['vector'],
    files: [{ path: 'model.bin', sizeBytes: 1, sha256: '0'.repeat(64) }],
    hardwareRequirements: { cpuArchitectures: [], minMemoryBytes: null, accelerator: null },
    limits: { maxInputBytes: null, maxAudioSeconds: null, maxItems: null, maxResultBytes: null, vectorDimensions: null },
    parameters: { embed: { purpose: ['query'] }, transcribe: null },
  },
};

test('real public Hub model search works without an auth token', { skip: !enabled && 'set BRAI_HF_PUBLIC_INTEGRATION=1 to use the public Hugging Face API' }, async () => {
  const result = await createHuggingFaceCatalog({ profiles: [profile], requestTimeoutMs: 10_000 }).search({ query: 'giga', page: { limit: 5 } });
  assert.ok(Array.isArray(result.items));
  assert.ok(result.items.length > 0, 'a known nonempty query must produce public model records');
  assert.ok(result.items.length <= 5);
  assert.ok(result.items.every(item => validateSchema('ModelRecord', item)), 'every real Hub result must satisfy the public ModelRecord schema');
  assert.equal(result.nextCursor === null || typeof result.nextCursor === 'string', true);
  assert.ok(result.items.every(item => item.supported ? item.profileId !== null : item.profileId === null));
});
