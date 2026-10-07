// ABOUTME: Применяет metadata миграцию transcription и отделяет рабочую SQL роль от владельца.
// ABOUTME: Запускается явно отдельно от helper/main; не создаёт пользователей или секреты.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';

/** Атомарно применяет owner DDL и grants существующей безопасной runtime роли. */
export async function migrate(pool: Pool, ownerRole: string, appRole: string, config: { transactionTimeoutMs: number }): Promise<void> {
  if (!Number.isSafeInteger(config.transactionTimeoutMs) || config.transactionTimeoutMs <= 0) throw new Error('INVALID_MIGRATION_TIMEOUT');
  if (!ownerRole || !appRole || ownerRole === appRole) throw new Error('TRANSCRIPTION_ROLES_MUST_DIFFER');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [String(config.transactionTimeoutMs)]);
    await client.query('SELECT pg_advisory_xact_lock(70482319)');
    const { rows } = await client.query("SELECT current_user AS role,current_database() AS db,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner");
    if (rows[0].role !== ownerRole || rows[0].owner !== ownerRole) throw new Error('MIGRATION_REQUIRES_DATABASE_OWNER');
    const role = (await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1', [appRole])).rows[0];
    const membership = (await client.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1', [appRole])).rowCount;
    if (!role || Object.values(role).some(Boolean) || membership) throw new Error('UNSAFE_RUNTIME_ROLE');
    await client.query(`REVOKE ALL ON DATABASE ${quote(rows[0].db)} FROM PUBLIC,${quote(appRole)}`);
    await client.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC,${quote(appRole)}`);
    const migration = new URL('../helper/migrations/001.sql', import.meta.resolve('#transcription-contracts'));
    await client.query(readFileSync(migration, 'utf8'));
    const alertsMigration = new URL('../helper/migrations/002.sql', import.meta.resolve('#transcription-contracts'));
    if (!(await client.query('SELECT version FROM transcription.migrations WHERE version=2')).rowCount) await client.query(readFileSync(alertsMigration, 'utf8'));
    const schemaOwner = (await client.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='transcription'")).rows[0]?.owner;
    const otherOwner = (await client.query("SELECT 1 FROM pg_class WHERE relnamespace='transcription'::regnamespace AND relowner<>(SELECT oid FROM pg_roles WHERE rolname=$1)", [ownerRole])).rowCount;
    if (schemaOwner !== ownerRole || otherOwner) throw new Error('MIGRATION_OWNER_MISMATCH');
    await client.query(`REVOKE ALL ON SCHEMA transcription FROM PUBLIC,${quote(appRole)}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA transcription FROM PUBLIC,${quote(appRole)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${quote(rows[0].db)} TO ${quote(appRole)}`);
    await client.query(`GRANT USAGE ON SCHEMA transcription TO ${quote(appRole)}`);
    await client.query(`GRANT SELECT ON transcription.migrations TO ${quote(appRole)}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON transcription.settings,transcription.requests,transcription.attempts,transcription.history_outbox TO ${quote(appRole)}`);
    await client.query('GRANT SELECT,INSERT,UPDATE,DELETE ON transcription.alerts_outbox TO ' + quote(appRole));
    await client.query('GRANT SELECT,INSERT,UPDATE ON transcription.alerts_incidents TO ' + quote(appRole));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const timeout = Number(process.env.TRANSCRIPTION_MIGRATION_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('TRANSCRIPTION_MIGRATION_TIMEOUT_MS_REQUIRED');
  const pool = new Pool({ connectionTimeoutMillis: timeout, query_timeout: timeout, max: 1 });
  try { await migrate(pool, process.env.PGUSER ?? '', process.env.TRANSCRIPTION_APP_ROLE ?? '', { transactionTimeoutMs: timeout }); console.log('transcription migration complete'); }
  catch { console.error('transcription migration failed'); process.exitCode = 1; }
  finally { await pool.end(); }
}
