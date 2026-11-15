// ABOUTME: Проверяет файловый bootstrap старого профиля после смены и отката программы.
// ABOUTME: Использует синтетические owner-настройки и подставные чтения защищённых файлов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileConfiguration, identityFileConfiguration } from '../configuration.mjs';

const config = { ownerId: 'owner-1', publisher: { configPath: '/protected/owner-1/publisher.json' } };
const fail = code => new Error(code);
const fixture = () => ({ ownerId: config.ownerId, moduleRoot: '/previous-release/services/hermes/files',
  entry: '/previous-release/services/hermes/tools.mjs', stateRoot: '/home/owner-1/workspace/files',
  resultRoot: '/home/owner-1/results', readRoots: ['/home/owner-1/workspace', '/home/owner-1/media', '/home/owner-1/results'],
  serviceRoots: ['/opt/brai-profile/runtime'], toolsConfig: '/protected/owner-1/tools.json' });
const ports = (value, metadata = {}) => ({
  lstat: async path => {
    assert.equal(path, '/protected/owner-1/files.json');
    return { isFile: () => true, uid: 0, mode: 0o100600, size: 1024, ...metadata };
  },
  readFile: async (path, encoding) => {
    assert.equal(path, '/protected/owner-1/files.json');
    assert.equal(encoding, 'utf8');
    return JSON.stringify(value);
  },
});

test('unchanged personal configuration survives two program versions and rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hermes-bootstrap-'));
  try {
    const source = await readFile(new URL('../configuration.mjs', import.meta.url), 'utf8');
    const modules = [];
    for (const version of ['release-a', 'release-b']) {
      const path = join(root, version, 'services/hermes/files/configuration.mjs');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
      modules.push({ root: dirname(path), module: await import(pathToFileURL(path).href) });
    }
    const stored = fixture(), before = structuredClone(stored);
    for (const selected of [modules[0], modules[1], modules[0]]) {
      const value = await selected.module.identityFileConfiguration(config, fail, ports(stored));
      assert.deepEqual(value, { ...stored, moduleRoot: selected.root, entry: join(dirname(selected.root), 'tools.mjs') });
      assert.deepEqual(stored, before);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('program paths always come from the loaded Control, never from the saved profile', async () => {
  const stored = { ...fixture(), moduleRoot: '/foreign/code', entry: '/foreign/execute.mjs' };
  const value = await identityFileConfiguration(config, fail, ports(stored));
  assert.equal(value.moduleRoot, fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''));
  assert.equal(value.entry, fileURLToPath(new URL('../../tools.mjs', import.meta.url)));
  assert.equal(value.stateRoot, stored.stateRoot);
});

test('fixed-owner bootstrap still rejects another runtime version', async () => {
  await assert.rejects(fileConfiguration(config, fail, ports(fixture())), /FILES_CONFIG_UNTRUSTED/);
});

test('owner, file metadata and schema checks apply before either bootstrap path', async () => {
  for (const read of [fileConfiguration, identityFileConfiguration]) {
    for (const [value, metadata] of [
      [{ ...fixture(), ownerId: 'owner-2' }, {}],
      [{ ...fixture(), unexpected: true }, {}],
      [fixture(), { uid: 1000 }],
      [fixture(), { mode: 0o100622 }],
      [fixture(), { isFile: () => false }],
    ]) await assert.rejects(read(config, fail, ports(value, metadata)), /FILES_CONFIG_UNTRUSTED/);
  }
});
