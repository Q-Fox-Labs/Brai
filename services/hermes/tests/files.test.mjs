// ABOUTME: Проверяет owner-fixed metadata и явные наборы файлов Hermes.
// ABOUTME: Запускает автономные проверки Python без сети или пользовательских данных.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fileMetadata, fileMetadataTools } from '../files/metadata.mjs';
import { compileInput } from '../catalog.mjs';
import { subjects } from '../../artifacts/contracts/index.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const owner = 'fixed-owner';
const artifact = { artifactId: id, ownerId: owner, requestId: 'file', kind: 'original', status: 'ready',
  title: 'image', filename: 'photo.png', extension: 'png', mimeType: 'image/png', source: 'hermes',
  sizeBytes: 1, sha256: 'a'.repeat(64), internalUrl: 'http://private/artifact', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z' };
const fail = code => Object.assign(new Error(code), { code });

test('file get/list use owner schemas and hide owner/internal addresses', async () => {
  const calls = [];
  const request = async (subject, payload) => {
    calls.push({ subject, payload });
    return subject === subjects.get ? artifact : { items: [artifact], total: 1, limit: 100, offset: 0, sort: 'createdAt', order: 'desc' };
  };
  assert.equal((await fileMetadata('files_get', { artifactId: id }, owner, request, fail)).artifactId, id);
  const listed = await fileMetadata('files_list', {}, owner, request, fail);
  assert.equal(listed.items[0].ownerId, undefined);
  assert.deepEqual(calls[1].payload.filter, { ownerId: owner, status: 'ready' });
  await assert.rejects(fileMetadata('files_get', { artifactId: id }, 'another-owner', request, fail), /FORBIDDEN/);
});

test('file sets preserve order, duplicates, captions and an explicit delivery mode', async () => {
  const args = { mode: 'album', items: [{ artifactId: id, caption: 'первая' }, { artifactId: id, caption: 'повтор' }] };
  const result = await fileMetadata('files_prepare', args, owner, async () => artifact, fail);
  assert.deepEqual(result.fileSet, args);
  assert.equal(result.deliveryMarker, 'BRAI_FILES:' + JSON.stringify(args));
  assert.equal(result.files.length, 2);
  await assert.rejects(fileMetadata('files_prepare', args, owner, async () => ({ ...artifact, status: 'pending', internalUrl: undefined }), fail), /NOT_READY/);
  for (const tool of fileMetadataTools) {
    const valid = compileInput(tool.inputSchema);
    const input = tool.name === 'files_prepare' ? args : tool.name === 'files_get' ? { artifactId: id } : {};
    assert.equal(valid(input), true);
    assert.equal(valid({ ...input, ownerId: owner }), false);
  }
});

test('universal file lifecycle, albums, failures and migration pass without live services', { timeout: 60000 }, () => {
  const script = fileURLToPath(new URL('../files/tests/test_files.py', import.meta.url));
  const result = spawnSync('python3', ['-B', script], { encoding: 'utf8', timeout: 55000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
