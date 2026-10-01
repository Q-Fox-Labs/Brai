// ABOUTME: Реализует живой каталог, открытый SQL и транзакционные миграции.
// ABOUTME: Один вызов выбирает только настроенный экземпляр и актуальную БД.
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { tools, type ToolName } from './contracts.js';
import { Database, ServiceError, safeError, streamQuery } from './database.js';
import { extensionSql, schemaWhere, tableSql } from './metadata.js';
function objects(result: Awaited<ReturnType<typeof streamQuery>>['results'][number]) { return result.rows.map(row => Object.fromEntries(result.columns.map((field, index) => [field.name, row[index]]))); }
function cursorRead(cursor: unknown, binding: string): string {
    if (cursor === undefined)
        return '';
    try {
        const parsed = JSON.parse(Buffer.from(cursor as string, 'base64url').toString('utf8'));
        if (parsed.binding !== binding || typeof parsed.after !== 'string' || parsed.after.length > 63)
            throw 0;
        return parsed.after;
    }
    catch {
        throw new ServiceError('INVALID_CURSOR');
    }
}
function cursorWrite(after: string, binding: string) { return Buffer.from(JSON.stringify({ after, binding })).toString('base64url'); }
async function journal(client: Client): Promise<boolean> {
    const exists = await client.query("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS exists");
    if (!exists.rows[0].exists)
        return false;
    const shape = await client.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
    FROM pg_attribute a WHERE a.attrelid='supabase_migrations.schema_migrations'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attname`);
    const pk = await client.query(`SELECT array_agg(a.attname::text ORDER BY u.ord) AS names FROM pg_constraint c
    JOIN LATERAL unnest(c.conkey) WITH ORDINALITY u(attnum,ord) ON true
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=u.attnum
    WHERE c.conrelid='supabase_migrations.schema_migrations'::regclass AND c.contype='p' GROUP BY c.oid`);
    const expected = [['name', 'text'], ['statements', 'text[]'], ['version', 'text']];
    if (shape.rows.length !== 3 || shape.rows.some((r, i) => r.attname !== expected[i][0] || r.type !== expected[i][1]) || !shape.rows[2].attnotnull || pk.rows.length !== 1 || JSON.stringify(pk.rows[0].names) !== '["version"]')
        throw new ServiceError('INCOMPATIBLE_MIGRATION_JOURNAL');
    return true;
}
/** Исполняет инструмент после проверки его единственной входной схемой, возвращая безопасный MCP envelope. */
export async function callTool(database: Database, name: ToolName, input: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    try {
        const args = tools[name].input.parse(input) as Record<string, any>;
        let data: unknown;
        if (name === 'list_instances')
            data = { instances: database.listInstances() };
        else
            data = await database.use(args.instance, args.database, signal, async (client) => {
                const limits = database.config.limits;
                if (name === 'list_databases') {
                    const binding = JSON.stringify([args.instance ?? database.config.defaultInstance, args.includeTemplates, args.name ?? null]);
                    const after = cursorRead(args.cursor, binding);
                    const rows = await client.query(`SELECT datname AS name,pg_get_userbyid(datdba) AS owner,datallowconn,datistemplate AS is_template
          FROM pg_database WHERE ($1::boolean OR NOT datistemplate) AND ($2::text IS NULL OR strpos(datname,$2)>0)
          AND datname COLLATE "C">$3::text COLLATE "C" ORDER BY datname COLLATE "C" LIMIT $4`, [args.includeTemplates, args.name ?? null, after, args.limit + 1]);
                    const more = rows.rows.length > args.limit;
                    return { databases: rows.rows.slice(0, args.limit), nextCursor: more ? cursorWrite(rows.rows[args.limit - 1].name, binding) : null };
                }
                if (name === 'list_schemas') {
                    const batch = await streamQuery(client, `SELECT n.nspname AS name,pg_get_userbyid(n.nspowner) AS owner FROM pg_namespace n WHERE ${schemaWhere} ORDER BY n.nspname COLLATE "C"`, limits, [args.includeSystem, args.schemas ?? null]);
                    return { schemas: objects(batch.results[0]), truncated: batch.results[0].truncated };
                }
                if (name === 'list_tables') {
                    const batch = await streamQuery(client, tableSql, limits, [args.includeSystem, args.schemas ?? null, ['names', 'columns', 'keys', 'relations'].indexOf(args.verbosity)]);
                    const tables = objects(batch.results[0]).map(row => Object.fromEntries(Object.entries(row).filter(([key, value]) => value !== null || !['columns', 'primary_keys', 'relationships'].includes(key))));
                    return { tables, truncated: batch.results[0].truncated };
                }
                if (name === 'list_extensions') {
                    const batch = await streamQuery(client, extensionSql, limits);
                    return { extensions: objects(batch.results[0]), truncated: batch.results[0].truncated };
                }
                if (name === 'execute_sql')
                    return { ...await streamQuery(client, args.sql, limits), limits: { rows: limits.rows, bytes: limits.bytes } };
                if (name === 'list_migrations') {
                    if (!await journal(client))
                        return { available: false, migrations: [], nextCursor: null };
                    const binding = JSON.stringify([args.instance ?? database.config.defaultInstance, args.database, 'migrations']);
                    const after = cursorRead(args.cursor, binding);
                    const batch = await streamQuery(client, 'SELECT version,name FROM supabase_migrations.schema_migrations WHERE version COLLATE "C">$1::text COLLATE "C" ORDER BY version COLLATE "C" LIMIT $2', { rows: args.limit + 1, bytes: limits.bytes }, [after, args.limit + 1]);
                    const result = batch.results[0];
                    if (!result || result.truncated && result.rows.length === 0)
                        throw new ServiceError('RESULT_TOO_LARGE');
                    const rows = objects(result);
                    const migrations = rows.slice(0, args.limit);
                    const more = rows.length > args.limit || result.truncated;
                    return { available: true, migrations, nextCursor: more ? cursorWrite(migrations.at(-1)!.version as string, binding) : null };
                }
                await client.query('BEGIN');
                try {
                    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('brai.supabase-mcp.migration',0))");
                    if (!await journal(client))
                        await client.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY,statements text[],name text)');
                    const duplicate = await client.query('SELECT 1 FROM supabase_migrations.schema_migrations WHERE version=$1', [args.version]);
                    if (duplicate.rowCount)
                        throw new ServiceError('MIGRATION_VERSION_EXISTS');
                    // AIDEV-NOTE: SPI внутри DO запрещает даже динамический COMMIT; SQL не может завершить внешнюю транзакцию.
                    const tag = `$mcp_${randomUUID().replaceAll('-', '')}$`;
                    const literal = `E'${args.sql.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
                    await client.query(`DO ${tag} BEGIN EXECUTE ${literal}; END ${tag}`);
                    await client.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES($1,$2,$3)', [args.version, args.name, [args.sql]]);
                    await client.query('COMMIT');
                    return { version: args.version, name: args.name };
                }
                catch (error) {
                    await client.query('ROLLBACK').catch(() => { });
                    throw error;
                }
            });
        if (Buffer.byteLength(JSON.stringify(data)) > database.config.limits.bytes)
            throw new ServiceError('RESULT_TOO_LARGE', undefined, 'unknown');
        return tools[name].output.parse({ ok: true, data }) as Record<string, unknown>;
    }
    catch (error) {
        return { ok: false, error: error instanceof z.ZodError ? { code: 'INVALID_INPUT', outcome: 'not_started' } : safeError(error) };
    }
}
