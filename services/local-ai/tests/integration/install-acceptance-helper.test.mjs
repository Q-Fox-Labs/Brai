// ABOUTME: Проверяет guard-функции защищённой приёмки без PostgreSQL, сети и моделей.
// ABOUTME: Настоящий ENOSPC считается только при наблюдаемой ошибке системной записи.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { open as namedOpen } from 'node:fs/promises';
import {
  assertFreshInstallNamespace,
  assertInstallDatabaseIdentity,
  assertExpectedHashMismatch,
  classifyHashNamespaceState,
  installAcceptanceCaseDirectories,
  isNativeEnospcWitness,
  readAcceptanceStoreRows,
  readInstallAcceptanceConfig,
  withNativeEnospcWitness,
} from './install-acceptance-helper.mjs';

const acceptedEnv = () => ({
  BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_REQUIRED: '1',
  BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_PHASE: 'public',
  BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_RUN_ID: 'a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371',
  BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_DATABASE_URL: 'postgresql://laa_install_app:fixture@127.0.0.1:19472/brai_local_ai_acceptance_installation',
  BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_DATABASE: 'brai_local_ai_acceptance_installation',
  BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_APP_ROLE: 'laa_install_app',
  BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_ROOT: '/var/lib/brai-local-ai-installation-acceptance/a6c6c83e-1234-4b1a-a1e1-9a4b4c7ef371',
  BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_MAX_OPERATION_MS: '300000',
  BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_CLEANUP_GRACE_MS: '30000',
  BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_WATCHDOG_MS: '900000',
  BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_PUBLIC_RESERVE_BYTES: '268435456',
});

test('required configuration fails closed and accepts only the isolated namespace and bounded phase', () => {
  assert.throws(() => readInstallAcceptanceConfig({}), /REQUIRED=1/);
  assert.throws(() => readInstallAcceptanceConfig({ BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_REQUIRED: '1' }), /bound is invalid/);
  assert.throws(() => readInstallAcceptanceConfig({ ...acceptedEnv(), BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_ROOT: '/var/lib/brai/local-ai/models' }), /configuration/);
  assert.throws(() => readInstallAcceptanceConfig({ ...acceptedEnv(), BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_PHASE: 'migrate' }), /configuration/);
  assert.throws(() => readInstallAcceptanceConfig({ ...acceptedEnv(), BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_WATCHDOG_MS: '310000' }), /bound is invalid/);
  assert.throws(() => readInstallAcceptanceConfig({ ...acceptedEnv(), BRAI_LOCAL_AI_INSTALL_ACCEPTANCE_DATABASE_URL: 'postgresql://laa_install_app:secret@example.com/db' }), /configuration/);
  assert.throws(() => readInstallAcceptanceConfig({ ...acceptedEnv(), HF_TOKEN: 'never-copy-this' }), /forbidden inherited/);
  const config = readInstallAcceptanceConfig(acceptedEnv());
  assert.equal(config.phase, 'public');
  assert.equal(config.watchdogMs, 900000);
  assert.deepEqual(Object.keys(installAcceptanceCaseDirectories(config)).sort(), ['enospcDirectory', 'hashCandidateDirectory', 'publicDirectory', 'root']);
});

test('database identity and empty namespace guards reject before any mutation', () => {
  assertInstallDatabaseIdentity({ database: 'brai_local_ai_acceptance_installation', role: 'laa_install_app' });
  assert.throws(() => assertInstallDatabaseIdentity({ database: 'brai', role: 'laa_install_app' }), /identity mismatch/);
  assertFreshInstallNamespace({ models: 0, installations: 0, operations: 0, settings: 0 });
  assert.throws(() => assertFreshInstallNamespace({ models: 1, installations: 0, operations: 0, settings: 0 }), /not empty/);
});

test('acceptance state reader supplies required empty filters to both real-store list methods', async () => {
  const calls = [];
  const models = [{ modelId: 'fixture-model' }];
  const installations = [{ modelId: 'fixture-model', revision: 'a'.repeat(40) }];
  const store = {
    async transaction(run) {
      return run({
        models: { async list(filter) { assert.deepEqual(filter, {}); calls.push('models'); return models; } },
        installations: { async list(filter) { assert.deepEqual(filter, {}); calls.push('installations'); return installations; } },
      });
    },
  };
  assert.deepEqual(await readAcceptanceStoreRows(store), { models, installations });
  assert.deepEqual(calls, ['models', 'installations']);
});

test('hash candidate accepts only the exact first pinned file as its sole hash mismatch', () => {
  const profile = { files: [{ path: 'config.json' }, { path: 'pytorch_model.bin' }] };
  assert.doesNotThrow(() => assertExpectedHashMismatch(profile, ['config.json']));
  for (const mismatches of [[], ['pytorch_model.bin'], ['config.json', 'pytorch_model.bin']]) {
    assert.throws(() => assertExpectedHashMismatch(profile, mismatches), error => error?.safeCode === 'HASH_CANDIDATE_MISMATCH_NOT_EXPECTED');
  }
});

test('hash namespace resume accepts only empty state or exact pinned catalog registration', () => {
  const profile = { record: { modelId: 'pinned', revision: 'a'.repeat(40) } };
  const empty = { models: [], installations: [], operations: [], settings: 0 };
  const registered = { ...empty, models: [profile.record] };
  assert.equal(classifyHashNamespaceState(empty, profile), 'empty');
  assert.equal(classifyHashNamespaceState(registered, profile), 'registered');
  for (const state of [{ ...registered, models: [{ ...profile.record, revision: 'b'.repeat(40) }] },
    { ...registered, models: [profile.record, profile.record] }, { ...registered, operations: [{}] },
    { ...registered, settings: 1 }, { ...registered, installations: [{}] }]) {
    assert.throws(() => classifyHashNamespaceState(state, profile), error => error?.safeCode === 'HASH_NAMESPACE_INVALID');
  }
});

test('native write observer forwards an ordinary write and restores fs.promises.open', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brai-install-witness-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalOpen = fsPromises.open;
  const result = await withNativeEnospcWitness(root, async () => {
    const handle = await namedOpen(path.join(root, 'witness.txt'), 'wx', 0o600);
    try { await handle.writeFile('native success'); }
    finally { await handle.close(); }
    return await readFile(path.join(root, 'witness.txt'), 'utf8');
  });
  assert.equal(result.value, 'native success');
  assert.equal(result.thrown, undefined);
  assert.deepEqual(result.observed, { code: null, errno: null, syscall: null, writeCalls: 1 }, 'the named ESM import used by the installer must pass through the observer');
  assert.equal(isNativeEnospcWitness(result.observed), false, 'ordinary writes must never be reported as ENOSPC');
  assert.equal(fsPromises.open, originalOpen, 'observer restores the built-in even after completion');
});

test('native write observer restores the built-in when callback throws', async () => {
  const originalOpen = fsPromises.open;
  const expected = new Error('fixture control-flow sentinel');
  const root = await mkdtemp(path.join(os.tmpdir(), 'brai-install-witness-close-'));
  try {
    const result = await withNativeEnospcWitness(root, async () => { throw expected; });
    assert.equal(result.thrown, expected);
    assert.equal(fsPromises.open, originalOpen);
    assert.equal(isNativeEnospcWitness(result.observed), false, 'a callback error is not evidence of disk exhaustion');
  } finally { await rm(root, { recursive: true, force: true }); }
});
