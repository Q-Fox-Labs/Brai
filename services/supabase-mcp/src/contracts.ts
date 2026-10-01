// ABOUTME: Задаёт единственные машинные схемы восьми инструментов MCP.
// ABOUTME: Имена БД и объектов проверяются живым каталогом, а не статическим enum.
import { z } from 'zod';
const name = z.string().min(1).max(63).refine(x => !x.includes('\0'), 'Invalid name');
const instance = z.string().min(1).max(100).optional();
const target = { instance, database: name };
const page = { limit: z.number().int().min(1).max(100).default(50), cursor: z.string().max(2048).optional() };
const schemaFilter = { includeSystem: z.boolean().default(false), schemas: z.array(name).max(100).optional() };
const column = z.object({ name: z.string(), dataTypeID: z.number().int() });
const statement = z.object({ statementIndex: z.number().int(), command: z.string().nullable(), columns: z.array(column), rows: z.array(z.array(z.unknown())), rowCount: z.number().nullable(), truncated: z.boolean() });
const table = z.object({ id: z.string(), schema: z.string(), name: z.string(), rls_enabled: z.boolean(), rls_forced: z.boolean(),
    columns: z.array(z.object({ name: z.string(), ordinal_position: z.number(), data_type: z.string(), is_nullable: z.boolean(), default_value: z.string().nullable(), is_identity: z.boolean(), is_generated: z.boolean() })).optional(),
    primary_keys: z.array(z.string()).optional(),
    relationships: z.array(z.object({ constraint_name: z.string(), source_schema: z.string(), source_table_name: z.string(), source_columns: z.array(z.string()), target_table_schema: z.string(), target_table_name: z.string(), target_columns: z.array(z.string()) })).optional(),
});
const error = z.object({ code: z.string(), sqlstate: z.string().optional(), outcome: z.enum(['not_started', 'unknown']) });
const envelope = (data: z.ZodType) => z.object({ ok: z.boolean(), data: data.optional(), error: error.optional() });
/** Стабильные машинные входы и результаты восьми MCP-инструментов. */
export const tools = {
    list_instances: { description: 'List configured PostgreSQL instance identifiers without credentials.', input: z.strictObject({}), output: envelope(z.object({ instances: z.array(z.object({ id: z.string(), isDefault: z.boolean() })) })) },
    list_databases: { description: 'Read the live PostgreSQL database catalog with opaque keyset pagination.', input: z.strictObject({ instance, ...page, includeTemplates: z.boolean().default(false), name: z.string().max(63).optional() }), output: envelope(z.object({ databases: z.array(z.object({ name: z.string(), owner: z.string(), datallowconn: z.boolean(), is_template: z.boolean() })), nextCursor: z.string().nullable() })) },
    list_schemas: { description: 'List live schemas; defaults to all non-system schemas.', input: z.strictObject({ ...target, ...schemaFilter }), output: envelope(z.object({ schemas: z.array(z.object({ name: z.string(), owner: z.string() })), truncated: z.boolean() })) },
    list_tables: { description: 'List live tables, with cumulative names, columns, keys or relations detail.', input: z.strictObject({ ...target, ...schemaFilter, verbosity: z.enum(['names', 'columns', 'keys', 'relations']).default('columns') }), output: envelope(z.object({ tables: z.array(table), truncated: z.boolean() })) },
    list_extensions: { description: 'List available PostgreSQL extensions and installed versions.', input: z.strictObject(target), output: envelope(z.object({ extensions: z.array(z.object({ name: z.string(), schema: z.string().nullable(), default_version: z.string(), installed_version: z.string().nullable(), comment: z.string().nullable() })), truncated: z.boolean() })) },
    execute_sql: { description: 'Execute arbitrary SQL once, including CRUD and DDL. Result truncation does not limit writes. Timeout or disconnect may leave an unknown write outcome: do not automatically retry.', input: z.strictObject({ ...target, sql: z.string().min(1).max(1000000) }), output: envelope(z.object({ results: z.array(statement), omittedResults: z.number().int(), limits: z.object({ rows: z.number(), bytes: z.number() }) })) },
    list_migrations: { description: 'Read the Supabase migration journal without creating it.', input: z.strictObject({ ...target, ...page }), output: envelope(z.object({ available: z.boolean(), migrations: z.array(z.object({ version: z.string(), name: z.string().nullable() })), nextCursor: z.string().nullable() })) },
    apply_migration: { description: 'Atomically execute transactional SQL and record one required, unique migration version. Transaction control and nontransactional DDL are rejected by PostgreSQL; use execute_sql for those operations. Never automatically retry unknown outcomes.', input: z.strictObject({ ...target, version: z.string().regex(/^\d{14}$/), name: z.string().regex(/^[a-z][a-z0-9_]*$/).max(100), sql: z.string().min(1).max(1000000) }), output: envelope(z.object({ version: z.string(), name: z.string() })) },
};
export type ToolName = keyof typeof tools;
