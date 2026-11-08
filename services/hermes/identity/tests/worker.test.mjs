// ABOUTME: Запускает тесты пользовательского Hermes в общем Node test runner.
// ABOUTME: Не подключается к установленным сервисам и пользовательским данным.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
test('Python worker modules and regression tests are declared in the component', () => {
  const component = JSON.parse(readFileSync(join(here, '../../component.json'), 'utf8'));
  for (const entry of readdirSync(join(here, '..'), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.py')) continue;
    const path = 'services/hermes/identity/' + entry.name;
    assert.ok(component.inputs.runtime.includes(path), 'Missing runtime input: ' + path);
    assert.ok(component.delivery.files.includes(path), 'Missing delivered module: ' + path);
  }
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    if (!entry.isFile() || !/^test_worker.*\.py$/.test(entry.name)) continue;
    const path = 'services/hermes/identity/tests/' + entry.name;
    assert.ok(component.inputs.checks.includes(path), 'Missing check input: ' + path);
  }
});
test('Hermes worker IPC and tools', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-B', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_worker*.py', '-v'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Worker tests failed');
});

test('Hermes Telegram ingress', () => {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-B', '-m', 'unittest', 'discover', '-s', here, '-p', 'test_telegram_runtime.py', '-v'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Telegram tests failed');
});

for (const pattern of ['test_shared_search.py', 'test_delivery_routes.py', 'test_memory_status.py', 'test_memory_feedback.py']) {
  test('Hermes owner boundary: ' + pattern, () => {
    const result = spawnSync(process.env.PYTHON || 'python3',
      ['-B', '-m', 'unittest', 'discover', '-s', here, '-p', pattern, '-v'],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message || 'Boundary tests failed');
  });
}
