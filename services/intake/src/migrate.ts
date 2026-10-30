// ABOUTME: Применяет идемпотентную миграцию отдельной owner-ролью.
// ABOUTME: Runtime-роль получает только DML своих таблиц и не выполняет DDL.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
/** Применяет owner DDL и минимальные права указанной runtime-роли. */
export async function migrate(pool: Pool, role: string): Promise<void> {
 if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw Error('INVALID_RUNTIME_ROLE');
 const c = await pool.connect();
 try {
  await c.query('BEGIN');
  await c.query('SELECT pg_advisory_xact_lock(742185101)');
  const identity=(await c.query("SELECT current_user AS role,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
  if(identity.role!==identity.owner || identity.role===role)throw Error('DEDICATED_DATABASE_OWNER_REQUIRED');
  const app=(await c.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows[0];
  if(!app || Object.values(app).some(Boolean) || (await c.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)',[role])).rowCount)throw Error('UNSAFE_RUNTIME_ROLE');
  await c.query(await readFile(new URL('../migrations/001.sql', import.meta.url), 'utf8'));
  await c.query(await readFile(new URL('../migrations/002.sql', import.meta.url), 'utf8'));
  await c.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await c.query('REVOKE ALL ON SCHEMA intake FROM "'+role+'"');
  await c.query('REVOKE ALL ON ALL TABLES IN SCHEMA intake FROM "'+role+'"');
  await c.query('GRANT USAGE ON SCHEMA intake TO "' + role + '"');
  await c.query('GRANT SELECT,INSERT ON intake.intake_receipts,intake.intake_packets TO "' + role + '"');
  await c.query('GRANT UPDATE(current_revision) ON intake.intake_receipts TO "'+role+'"');
  await c.query('GRANT UPDATE(body) ON intake.intake_packets TO "'+role+'"');
  await c.query('GRANT SELECT,INSERT ON intake.intake_rejections,intake.intake_control_events TO "' + role + '"');
  await c.query('COMMIT');
 } catch(e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
 const url = process.env.INTAKE_OWNER_DATABASE_URL, role = process.env.INTAKE_RUNTIME_ROLE;
 if (!url || !role) throw Error('MISSING_MIGRATION_CONFIG');
 const pool = new Pool({connectionString:url,max:1});
 try { await migrate(pool,role); } finally { await pool.end(); }
}
