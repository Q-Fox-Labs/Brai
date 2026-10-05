// ABOUTME: Проверяет строгие настройки отдельного MCP адаптера.
// ABOUTME: Тесты не подключаются к NATS, PostgreSQL или файловому ядру.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadMcpConfig } from '../dist/mcp.js';

test('MCP uses only NATS settings and binds to loopback by default', () => {
  const config = loadMcpConfig({ NATS_URL: 'nats://127.0.0.1:24241' });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3005);
  assert.equal(config.deadlineMs, 15000);
  assert.equal(config.maxConcurrent, 16);
  assert.equal(config.inboxPrefix, '_INBOX.brai_artifacts_mcp');
  assert.equal('databaseURL' in config, false);
  assert.equal('dataDir' in config, false);
});

test('MCP rejects public binds without explicit Host and Origin allowlists', () => {
  assert.throws(() => loadMcpConfig({ NATS_URL: 'nats://127.0.0.1:24241', ARTIFACTS_MCP_HOST: '0.0.0.0' }), /Explicit MCP hosts and origins/);
  assert.throws(() => loadMcpConfig({ NATS_URL: 'nats://127.0.0.1:24241', ARTIFACTS_MCP_MAX_REQUEST_BYTES: '0' }), /Invalid ARTIFACTS_MCP_MAX_REQUEST_BYTES/);
  assert.throws(() => loadMcpConfig({ NATS_URL: 'nats://127.0.0.1:24241', ARTIFACTS_MCP_ALLOWED_ORIGINS: 'javascript:alert(1)' }), /Invalid ARTIFACTS_MCP_ALLOWED_ORIGINS/);
});
