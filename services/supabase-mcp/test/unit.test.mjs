// ABOUTME: Проверяет конфигурацию и отсутствие секретов в машинных ошибках.
// ABOUTME: Реальный транспорт и PostgreSQL проверяются отдельным интеграционным стендом.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../dist/config.js';
import { safeError } from '../dist/database.js';
import { tools } from '../dist/contracts.js';
const instance = { id: 'a', host: '127.0.0.1', port: 5432, user: 'postgres', bootstrapDatabase: 'postgres', tls: false };
test('strict config, default instance and unique identifiers', () => {
    assert.equal(parseConfig({ defaultInstance: 'a', instances: [instance] }).limits.connections, 8);
    for (const value of [{ defaultInstance: 'b', instances: [instance] }, { defaultInstance: 'a', instances: [instance, instance] }, { defaultInstance: 'a', instances: [instance], databases: ['x'] }, { defaultInstance: 'a', instances: [{ ...instance, tls: true }] }])
        assert.throws(() => parseConfig(value));
});
test('errors remove database detail, SQL and credentials', () => {
    assert.deepEqual(safeError(Object.assign(new Error('password=SECRET host=PRIVATE SQL'), { code: '42P01', detail: 'SECRET' })), { code: 'DATABASE_ERROR', sqlstate: '42P01', outcome: 'unknown' });
    assert.deepEqual(safeError(Object.assign(new Error('SECRET'), { code: 'ECONNREFUSED' })), { code: 'DATABASE_ERROR', outcome: 'unknown' });
});
test('eight stable tools, no target database enum and deterministic migration version', () => {
    assert.equal(Object.keys(tools).length, 8);
    assert.equal(tools.execute_sql.input.parse({ database: 'a " b', sql: 'SELECT 1' }).database, 'a " b');
    assert.throws(() => tools.execute_sql.input.parse({ database: 'x', sql: 'SELECT 1', host: 'attack' }));
    assert.throws(() => tools.apply_migration.input.parse({ database: 'x', name: 'one', sql: 'SELECT 1' }));
});
test('password is read by the server from an explicit synthetic file', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { loadInstances } = await import('../dist/config.js');
    const directory = await mkdtemp(join(tmpdir(), 'brai-mcp-unit-'));
    try {
        const path = join(directory, 'password');
        await writeFile(path, 'synthetic-fixture-password\n', { mode: 0o600 });
        const config = parseConfig({ defaultInstance: 'a', instances: [{ ...instance, passwordFile: path }] });
        assert.equal((await loadInstances(config))[0].password, 'synthetic-fixture-password');
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
