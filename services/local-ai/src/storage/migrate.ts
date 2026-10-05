// ABOUTME: Применяет миграцию local-ai и выдаёт приложению ограниченные SQL-права.
// ABOUTME: Запускается отдельно под владельцем БД; рабочий сервис миграции не выполняет.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Pool, type PoolClient } from 'pg';

const quote = (name: string): string => '"' + name.replaceAll('"', '""') + '"';
function roleName(value: string): boolean { return /^[a-z_][a-z0-9_]{0,62}$/.test(value); }

/** Применяет миграцию целиком и настраивает только необходимые права runtime-роли. */
export async function migrate(pool: Pool, ownerRole: string, appRole: string): Promise<void> {
  if (!roleName(ownerRole) || !roleName(appRole) || ownerRole === appRole) throw new Error('OWNER_AND_APP_ROLES_MUST_DIFFER');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [126100012]);
    const identity = (await client.query(`SELECT current_user AS role,current_database() AS db,
      (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner`)).rows[0];
    if (identity.role !== ownerRole || identity.owner !== ownerRole) throw new Error('MIGRATION_REQUIRES_DATABASE_OWNER');
    const roles = (await client.query(`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
      FROM pg_roles WHERE rolname=ANY($1::text[])`, [[ownerRole, appRole]])).rows;
    if (roles.length !== 2 || roles.some(row => Object.entries(row).some(([key, value]) => key !== 'rolname' && value))) throw new Error('UNSAFE_DATABASE_ROLE');
    const memberships = (await client.query(`SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
      WHERE r.rolname=ANY($1::text[]) LIMIT 1`, [[ownerRole, appRole]])).rowCount;
    if (memberships) throw new Error('DATABASE_ROLE_MEMBERSHIP_NOT_ALLOWED');
    const appOwnsTables = (await client.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relowner=(SELECT oid FROM pg_roles WHERE rolname=$1) AND n.nspname IN ('local_ai','public') LIMIT 1`, [appRole])).rowCount;
    if (appOwnsTables) throw new Error('RUNTIME_ROLE_OWNS_TABLES');

    const schemaExists = (await client.query("SELECT to_regnamespace('local_ai') AS schema_name")).rows[0].schema_name;
    const exists = (await client.query("SELECT to_regclass('local_ai.migrations') AS table_name")).rows[0].table_name;
    if (!schemaExists && !exists) {
      await client.query(readFileSync(new URL('../../migrations/001.sql', import.meta.url), 'utf8'));
    } else if (schemaExists && exists) {
      const applied = (await client.query('SELECT version,name FROM local_ai.migrations ORDER BY version')).rows;
      if (applied.length !== 1 || applied[0].version !== 1 || applied[0].name !== '001_local_ai_storage') throw new Error('UNKNOWN_MIGRATION_STATE');
    } else throw new Error('UNKNOWN_MIGRATION_STATE');
    const schemaOwner = (await client.query(`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace n WHERE nspname='local_ai'`)).rows[0]?.owner;
    const wrongOwner = (await client.query(`SELECT 1 FROM pg_class WHERE relnamespace='local_ai'::regnamespace
      AND relowner<>(SELECT oid FROM pg_roles WHERE rolname=$1) LIMIT 1`, [ownerRole])).rowCount;
    if (schemaOwner !== ownerRole || wrongOwner) throw new Error('MIGRATION_REQUIRES_SCHEMA_OWNER');

    const db = quote(identity.db);
    const app = quote(appRole);
    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC,${app}`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${app}`);
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query(`REVOKE ALL ON SCHEMA public FROM ${app}`);
    await client.query(`REVOKE ALL ON SCHEMA local_ai FROM PUBLIC,${app}`);
    await client.query(`GRANT USAGE ON SCHEMA local_ai TO ${app}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA local_ai FROM PUBLIC,${app}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON local_ai.models,local_ai.installations,
      local_ai.installation_operations,local_ai.settings,local_ai.outbox TO ${app}`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const databaseURL = process.env.LOCAL_AI_DATABASE_URL;
  if (!databaseURL) throw new Error('LOCAL_AI_DATABASE_URL_REQUIRED');
  const pool = new Pool({ connectionString: databaseURL, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  try {
    await migrate(pool, process.env.LOCAL_AI_OWNER_ROLE ?? '', process.env.LOCAL_AI_APP_ROLE ?? '');
    console.log('local-ai migration complete');
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'MIGRATION_FAILED';
    console.error('local-ai migration failed', code);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
