import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(directory, '../../../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'brai-broker-tests-'));

try {
  const result = spawnSync('python3', [
    '-B',
    '-m',
    'unittest',
    'discover',
    '-s',
    'services/hermes/identity/tests',
    '-p',
    'test_broker.py',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      BRAI_BROKER_TMP: fixtureRoot,
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  process.stdout.write(result.stdout);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
