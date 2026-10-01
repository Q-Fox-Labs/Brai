// ABOUTME: Проверяет настоящий MCP HTTP и PostgreSQL на двух изолированных экземплярах.
// ABOUTME: Использует только явно выделенные loopback fixtures; не читает рабочие секреты.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { request as httpRequest } from 'node:http';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseConfig, loadInstances } from '../dist/config.js';
import { Database } from '../dist/database.js';
import { startServer } from '../dist/server.js';
const ports = [Number(process.env.TEST_PG_PORT_A), Number(process.env.TEST_PG_PORT_B)];
if (ports.some(x => !Number.isInteger(x) || x < 1024))
    throw new Error('Set TEST_PG_PORT_A/B for dedicated disposable PostgreSQL fixtures');
const admins = ports.map(port => new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' }));
const config = parseConfig({ port: 0, defaultInstance: 'a', instances: ports.map((port, i) => ({ id: i ? 'b' : 'a', host: '127.0.0.1', port, user: 'postgres', bootstrapDatabase: 'postgres', tls: false })), limits: { connections: 2, queue: 4, deadlineMs: 1200, rows: 5, bytes: 8192 } });
let db, server, client, transport, initialTools;
const target = 'mcp_main';
const quote = x => '"' + x.replaceAll('"', '""') + '"';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function raw(name, args = {}, options) { const result = await client.callTool({ name, arguments: args }, undefined, options); assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent); return result.structuredContent; }
async function call(name, args = {}) { const result = await raw(name, args); assert.equal(result.ok, true, JSON.stringify(result)); return result.data; }
async function sql(text, database = target, instance) { return call('execute_sql', { database, sql: text, ...(instance ? { instance } : {}) }); }
async function drained() {
    for (let i = 0; i < 100; i++) {
        if (db.usage().every(x => x.active === 0 && x.queued === 0))
            return;
        await sleep(20);
    }
    assert.fail('MCP connections did not drain');
}
before(async () => {
    await Promise.all(admins.map(x => x.connect()));
    for (const admin of admins)
        await admin.query(`CREATE DATABASE ${quote(target)}`);
    db = new Database(config, await loadInstances(config));
    server = await startServer(config, db);
    client = new McpClient({ name: 'fixture-client', version: '1.0.0' });
    transport = new StreamableHTTPClientTransport(new URL(server.url));
    await client.connect(transport);
    initialTools = await client.listTools();
});
after(async () => { await transport?.terminateSession().catch(() => { }); await client?.close(); await server?.close(); await Promise.all(admins.map(x => x.end().catch(() => { }))); });
test('real initialize/tools/list: eight explicit schemas and protocol 2025-06-18', async () => {
    assert.equal(initialTools.tools.length, 8);
    for (const tool of initialTools.tools) {
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(tool.outputSchema.type, 'object');
    }
    const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'protocol-probe', version: '1' } } }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.result.protocolVersion, '2025-06-18');
    const session = response.headers.get('mcp-session-id');
    await fetch(server.url, { method: 'DELETE', headers: { 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' } });
    assert.deepEqual((await call('list_instances')).instances, [{ id: 'a', isDefault: true }, { id: 'b', isDefault: false }]);
});
test('CRUD, separate multi-statement results and SQL value encodings', async () => {
    const result = await sql('CREATE TABLE values_test(id bigint PRIMARY KEY,t timestamptz,b bytea); INSERT INTO values_test VALUES(9223372036854775807,\'2026-01-02T03:04:05Z\',decode(\'00ff\',\'hex\')); SELECT * FROM values_test; UPDATE values_test SET t=t+interval \'1 second\'; DELETE FROM values_test RETURNING id');
    assert.deepEqual(result.results.map(x => x.command), ['CREATE', 'INSERT', 'SELECT', 'UPDATE', 'DELETE']);
    assert.deepEqual(result.results[2].rows[0], ['9223372036854775807', '2026-01-02T03:04:05.000Z', 'AP8=']);
    assert.equal(result.results[4].rowCount, 1);
    assert.equal((await sql('-- comment only')).results[0].command, null);
});
test('new database and quoted objects after startup; other owner and RLS', async () => {
    const database = 'mcp fixture " odd';
    await admins[0].query(`CREATE DATABASE ${quote(database)}`);
    const table = '"odd schema"."table "" name"';
    await sql(`CREATE ROLE fixture_other NOLOGIN; CREATE SCHEMA "odd schema" AUTHORIZATION fixture_other; CREATE TABLE ${table} (id int PRIMARY KEY,value text); ALTER TABLE ${table} OWNER TO fixture_other; ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY; INSERT INTO ${table} VALUES(1,'x'); UPDATE ${table} SET value='y'; SELECT * FROM ${table}`, database);
    assert.ok((await call('list_databases', { name: database })).databases.some(x => x.name === database));
    assert.ok((await call('list_schemas', { database })).schemas.some(x => x.name === 'odd schema'));
    const tables = (await call('list_tables', { database, verbosity: 'relations' })).tables;
    assert.equal(tables[0].rls_enabled, true);
    assert.equal(tables[0].rls_forced, true);
    assert.deepEqual(tables[0].primary_keys, ['id']);
    assert.equal(tables[0].columns.length, 2);
    assert.deepEqual(await client.listTools(), initialTools);
});
test('all schemas by default, explicit system access and cumulative metadata', async () => {
    await sql('CREATE SCHEMA extra; CREATE TABLE extra.parent(id int,value text,PRIMARY KEY(id) INCLUDE (value)); CREATE TABLE extra.child(a int,b text,FOREIGN KEY(a) REFERENCES extra.parent(id))');
    const schemas = await call('list_schemas', { database: target });
    assert.ok(schemas.schemas.some(x => x.name === 'extra'));
    assert.ok(!schemas.schemas.some(x => x.name === 'pg_catalog'));
    assert.ok((await call('list_schemas', { database: target, includeSystem: true, schemas: ['pg_catalog'] })).schemas.some(x => x.name === 'pg_catalog'));
    const details = await call('list_tables', { database: target, schemas: ['extra'], verbosity: 'relations' });
    const parent = details.tables.find(x => x.name === 'parent');
    const child = details.tables.find(x => x.name === 'child');
    assert.deepEqual(parent.primary_keys, ['id']);
    assert.deepEqual(child.relationships[0].source_columns, ['a']);
    assert.deepEqual(child.relationships[0].target_columns, ['id']);
    const names = await call('list_tables', { database: target, schemas: ['extra'], verbosity: 'names' });
    assert.ok(!('columns' in names.tables[0]));
    await sql('CREATE EXTENSION amcheck');
    const extensions = await call('list_extensions', { database: target });
    assert.equal(extensions.truncated, true);
    assert.ok(extensions.extensions.some(x => x.name === 'amcheck' && x.installed_version));
});
test('missing journal read is side-effect free; first migration is atomic and version is unique', async () => {
    const missing = await call('list_migrations', { database: target });
    assert.deepEqual(missing, { available: false, migrations: [], nextCursor: null });
    assert.equal((await sql("SELECT to_regnamespace('supabase_migrations') IS NULL")).results[0].rows[0][0], true);
    await call('apply_migration', { database: target, version: '20261001180001', name: 'initial', sql: "CREATE TABLE migrated(id int); INSERT INTO migrated VALUES(1); CREATE TABLE quoted_literals(value text); INSERT INTO quoted_literals VALUES('semi; dollar $$ quote '' slash \\')" });
    const duplicate = await raw('apply_migration', { database: target, version: '20261001180001', name: 'initial', sql: 'INSERT INTO migrated VALUES(2)' });
    assert.equal(duplicate.error.code, 'MIGRATION_VERSION_EXISTS');
    assert.equal((await sql('SELECT count(*)::int FROM migrated')).results[0].rows[0][0], 1);
    const journal = await call('list_migrations', { database: target });
    assert.equal(journal.available, true);
    assert.equal(journal.migrations[0].version, '20261001180001');
});
test('migration error rolls back DDL, data and journal; timer/auth history stays untouched', async () => {
    await sql('CREATE SCHEMA timer; CREATE TABLE timer.migrations(id int); INSERT INTO timer.migrations VALUES(1); CREATE TABLE auth_history(id int); INSERT INTO auth_history VALUES(2)');
    const result = await raw('apply_migration', { database: target, version: '20261001180002', name: 'broken', sql: 'CREATE TABLE must_rollback(id int); INSERT INTO migrated VALUES(3); SELECT * FROM no_such_table' });
    assert.equal(result.ok, false);
    assert.equal(result.error.sqlstate, '42P01');
    assert.deepEqual((await sql("SELECT to_regclass('must_rollback') IS NULL,(SELECT count(*)::int FROM migrated),(SELECT id FROM timer.migrations),(SELECT id FROM auth_history)")).results[0].rows[0], [true, 1, 1, 2]);
    assert.equal((await call('list_migrations', { database: target })).migrations.length, 1);
});
test('migration containment rejects transaction control including dynamic nested DO', async () => {
    for (const [index, control] of ['COMMIT', 'END', 'ROLLBACK', "DO $inner$ BEGIN EXECUTE 'COMMIT'; END $inner$"].entries()) {
        const result = await raw('apply_migration', { database: target, version: `2026100118001${index}`, name: 'transaction_escape', sql: `CREATE TABLE tx_escape_${index}(id int); ${control}; INSERT INTO migrated VALUES(4)` });
        assert.equal(result.ok, false);
        assert.ok(['0A000', '2D000'].includes(result.error.sqlstate), `${control}: ${JSON.stringify(result)}`);
        assert.equal((await sql(`SELECT to_regclass('tx_escape_${index}') IS NULL`)).results[0].rows[0][0], true);
    }
    const ddl = await raw('apply_migration', { database: target, version: '20261001180019', name: 'concurrent_index', sql: 'CREATE INDEX CONCURRENTLY bad_index ON migrated(id)' });
    assert.equal(ddl.ok, false);
    assert.equal(ddl.error.sqlstate, '25001');
});
test('failed first migration does not leave a journal; cancellation rolls back initial DDL', async () => {
    const database = 'mcp_first_failed';
    await admins[0].query(`CREATE DATABASE ${quote(database)}`);
    const failed = await raw('apply_migration', { database, version: '20261001180021', name: 'initial_bad', sql: 'CREATE TABLE rolled_back(id int); SELECT * FROM missing' });
    assert.equal(failed.ok, false);
    assert.deepEqual(await call('list_migrations', { database }), { available: false, migrations: [], nextCursor: null });
    assert.deepEqual((await sql("SELECT to_regnamespace('supabase_migrations') IS NULL,to_regclass('rolled_back') IS NULL", database)).results[0].rows[0], [true, true]);
    const controller = new AbortController();
    const pending = raw('apply_migration', { database, version: '20261001180022', name: 'cancelled', sql: 'CREATE TABLE cancelled_ddl(id int); SELECT pg_sleep(5)' }, { signal: controller.signal });
    await sleep(150);
    controller.abort();
    await assert.rejects(pending);
    await drained();
    assert.deepEqual((await sql("SELECT to_regnamespace('supabase_migrations') IS NULL,to_regclass('cancelled_ddl') IS NULL", database)).results[0].rows[0], [true, true]);
});
test('incompatible journal is rejected without overwrite or migration writes', async () => {
    const database = 'mcp_bad_journal';
    await admins[0].query(`CREATE DATABASE ${quote(database)}`);
    await sql('CREATE SCHEMA supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version integer)', database);
    for (const [name, args] of [['list_migrations', {}], ['apply_migration', { version: '20261001180020', name: 'bad', sql: 'CREATE TABLE never_written(id int)' }]]) {
        const result = await raw(name, { database, ...args });
        assert.equal(result.error.code, 'INCOMPATIBLE_MIGRATION_JOURNAL');
    }
    assert.equal((await sql("SELECT to_regclass('never_written') IS NULL", database)).results[0].rows[0][0], true);
});
test('concurrent first migrations serialize initialization and duplicate versions', async () => {
    const database = 'mcp_concurrent';
    await admins[0].query(`CREATE DATABASE ${quote(database)}`);
    const results = await Promise.all([1, 2].map(() => raw('apply_migration', { database, version: '20261001180030', name: 'one', sql: 'CREATE TABLE once_only(id int); INSERT INTO once_only VALUES(1)' })));
    assert.equal(results.filter(x => x.ok).length, 1);
    assert.equal(results.find(x => !x.ok).error.code, 'MIGRATION_VERSION_EXISTS');
    assert.equal((await sql('SELECT count(*)::int FROM once_only', database)).results[0].rows[0][0], 1);
});
test('migration keyset cursor and bound filter validation', async () => {
    for (let i = 40; i < 43; i++)
        await call('apply_migration', { database: target, version: `202610011800${i}`, name: 'paged', sql: 'SELECT 1' });
    const first = await call('list_migrations', { database: target, limit: 2 });
    const second = await call('list_migrations', { database: target, limit: 2, cursor: first.nextCursor });
    assert.equal(first.migrations.length, 2);
    assert.equal(second.migrations.length, 2);
    assert.equal(second.nextCursor, null);
    assert.equal((await raw('list_migrations', { database: 'mcp_concurrent', cursor: first.nextCursor })).error.code, 'INVALID_CURSOR');
});
test('300 new databases paginate fully without tool or connection-per-database growth', async () => {
    for (let i = 0; i < 300; i++)
        await admins[0].query(`CREATE DATABASE fixture_${String(i).padStart(3, '0')}`);
    const names = [];
    let cursor;
    do {
        const page = await call('list_databases', { name: 'fixture_', limit: 37, ...(cursor ? { cursor } : {}) });
        names.push(...page.databases.map(x => x.name));
        cursor = page.nextCursor;
    } while (cursor);
    assert.equal(names.length, 300);
    assert.equal(new Set(names).size, 300);
    assert.equal(names[0], 'fixture_000');
    assert.equal(names[299], 'fixture_299');
    for (const database of [names[0], names[149], names[299]]) {
        await sql('CREATE TABLE sample(id int); INSERT INTO sample VALUES(7)', database);
        assert.equal((await sql('SELECT id FROM sample', database)).results[0].rows[0][0], 7);
    }
    const first = await call('list_databases', { name: 'fixture_', limit: 1 });
    assert.equal((await raw('list_databases', { name: 'different', cursor: first.nextCursor })).error.code, 'INVALID_CURSOR');
    assert.deepEqual(await client.listTools(), initialTools);
    await drained();
    assert.equal(Number((await admins[0].query("SELECT count(*) FROM pg_stat_activity WHERE application_name='brai-supabase-mcp'")).rows[0].count), 0);
});
test('database rename, deletion, no-connect and templates are live', async () => {
    await admins[0].query('ALTER DATABASE fixture_299 RENAME TO fixture_renamed');
    assert.equal((await raw('execute_sql', { database: 'fixture_299', sql: 'SELECT 1' })).error.code, 'DATABASE_NOT_FOUND');
    assert.equal((await sql('SELECT id FROM sample', 'fixture_renamed')).results[0].rows[0][0], 7);
    await admins[0].query('DROP DATABASE fixture_renamed');
    assert.equal((await raw('execute_sql', { database: 'fixture_renamed', sql: 'SELECT 1' })).error.code, 'DATABASE_NOT_FOUND');
    await admins[0].query('ALTER DATABASE fixture_298 ALLOW_CONNECTIONS false');
    const page = await call('list_databases', { name: 'fixture_298' });
    assert.equal(page.databases[0].datallowconn, false);
    assert.equal((await raw('execute_sql', { database: 'fixture_298', sql: 'SELECT 1' })).error.code, 'DATABASE_CONNECTION_DISABLED');
    assert.equal((await call('list_databases', { name: 'template' })).databases.length, 0);
    assert.equal((await call('list_databases', { name: 'template', includeTemplates: true })).databases.length, 2);
});
test('same database name across two instances stays isolated and omitted instance selects default', async () => {
    await sql('CREATE TABLE instance_value(value text); INSERT INTO instance_value VALUES(\'a\')');
    await sql('CREATE TABLE instance_value(value text); INSERT INTO instance_value VALUES(\'b\')', target, 'b');
    assert.equal((await sql('SELECT value FROM instance_value')).results[0].rows[0][0], 'a');
    assert.equal((await sql('SELECT value FROM instance_value', target, 'b')).results[0].rows[0][0], 'b');
    assert.equal((await raw('execute_sql', { database: target, instance: 'not_configured', sql: 'SELECT 1' })).error.code, 'INSTANCE_NOT_FOUND');
});
test('result row/byte limits preserve full RETURNING writes and bound metadata', async () => {
    await sql('CREATE TABLE bulk(id int)');
    const write = await sql('INSERT INTO bulk SELECT generate_series(1,1000) RETURNING id');
    assert.equal(write.results[0].rowCount, 1000);
    assert.equal(write.results[0].rows.length, 5);
    assert.equal(write.results[0].truncated, true);
    assert.equal((await sql('SELECT count(*)::int FROM bulk')).results[0].rows[0][0], 1000);
    const huge = await sql("SELECT repeat('x',20000)");
    assert.equal(huge.results[0].rows.length, 0);
    assert.equal(huge.results[0].truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= config.limits.bytes);
    const headers = await sql(Array.from({ length: 150 }, (_, i) => `SELECT 1 AS ${quote('long_column_' + i + 'x'.repeat(40))}`).join(';'));
    assert.ok(headers.omittedResults > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(headers)) <= config.limits.bytes);
    assert.equal((await sql("SELECT 'NaN'::float8,'Infinity'::float8,'-Infinity'::float8,'infinity'::timestamptz")).results[0].rows[0][0], 'NaN');
});
test('invalid PostgreSQL timestamp gives a safe error and the service remains available', async () => {
    const result = await raw('execute_sql', { database: target, sql: "SELECT '294276-12-31'::timestamp" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SERIALIZATION_ERROR');
    assert.equal((await sql('SELECT 42')).results[0].rows[0][0], 42);
});
test('bounded connection budget and queue under concurrent SQL; call transactions do not leak', async () => {
    let peak = 0;
    const monitor = setInterval(() => void admins[0].query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='brai-supabase-mcp'").then(x => { peak = Math.max(peak, x.rows[0].n); }), 10);
    const results = await Promise.all(Array.from({ length: 24 }, () => raw('execute_sql', { database: target, sql: 'SELECT pg_sleep(0.15)' })));
    clearInterval(monitor);
    assert.ok(peak <= 2, `peak ${peak}`);
    assert.ok(results.some(x => x.error?.code === 'BUSY'));
    assert.ok(results.some(x => x.ok));
    await drained();
    await sql('BEGIN; INSERT INTO bulk VALUES(99999)');
    assert.equal((await sql('SELECT count(*)::int FROM bulk WHERE id=99999')).results[0].rows[0][0], 0);
});
test('deadline never retries committed writes and releases connections', async () => {
    await sql('CREATE TABLE outcomes(id int)');
    const result = await raw('execute_sql', { database: target, sql: 'BEGIN; INSERT INTO outcomes VALUES(1); COMMIT; SELECT pg_sleep(5)' });
    assert.equal(result.error.code, 'DEADLINE_EXCEEDED');
    assert.equal(result.error.outcome, 'unknown');
    await drained();
    assert.equal((await sql('SELECT count(*)::int FROM outcomes')).results[0].rows[0][0], 1);
});
test('MCP cancellation closes SQL and does not retry a committed write', async () => {
    const controller = new AbortController();
    const pending = raw('execute_sql', { database: target, sql: 'BEGIN; INSERT INTO outcomes VALUES(2); COMMIT; SELECT pg_sleep(5)' }, { signal: controller.signal });
    await sleep(150);
    controller.abort();
    await assert.rejects(pending);
    await drained();
    assert.equal((await sql('SELECT count(*)::int FROM outcomes WHERE id=2')).results[0].rows[0][0], 1);
});
test('HTTP disconnect without MCP cancellation drains SQL', async () => {
    const controller = new AbortController();
    const pending = fetch(server.url, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': transport.sessionId, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'disconnect', method: 'tools/call', params: { name: 'execute_sql', arguments: { database: target, sql: 'BEGIN; INSERT INTO outcomes VALUES(3); COMMIT; SELECT pg_sleep(5)' } } }) });
    await sleep(150);
    controller.abort();
    await assert.rejects(pending);
    await drained();
    assert.equal((await sql('SELECT count(*)::int FROM outcomes WHERE id=3')).results[0].rows[0][0], 1);
});
test('server-side database error and connection errors do not reveal private details', async () => {
    const result = await raw('execute_sql', { database: target, sql: "DO $$ BEGIN RAISE EXCEPTION 'SECRET password=synthetic host=private'; END $$" });
    assert.equal(result.error.sqlstate, 'P0001');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.ok(!JSON.stringify(result).includes('private'));
    const hostStatus = await new Promise((resolve, reject) => {
        const request = httpRequest(server.url, { method: 'POST', headers: { host: 'attacker.example', accept: 'application/json, text/event-stream', 'content-type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
        request.end('{}');
    });
    assert.equal(hostStatus, 403);
    const origin = await fetch(server.url, { method: 'POST', headers: { origin: 'https://attacker.example', accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(origin.status, 403);
});
test('graceful shutdown drains running calls and a restart reconnects', async () => {
    const pending = raw('execute_sql', { database: target, sql: 'SELECT pg_sleep(5)' }).catch(() => undefined);
    await sleep(100);
    await server.close();
    await pending;
    assert.ok(db.usage().every(x => x.active === 0 && x.queued === 0));
    db = new Database(config, await loadInstances(config));
    server = await startServer(config, db);
    await transport.close();
    await client.close();
    client = new McpClient({ name: 'restarted', version: '1' });
    transport = new StreamableHTTPClientTransport(new URL(server.url));
    await client.connect(transport);
    assert.equal((await sql('SELECT 42')).results[0].rows[0][0], 42);
});
