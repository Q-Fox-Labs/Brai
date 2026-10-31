// ABOUTME: Применяет миграции сервиса целей от имени владельца базы.
// ABOUTME: Runtime-роль не получает права на изменение схемы.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Применяет миграции атомарно и выдаёт runtime-роли только права на данные. */
export async function migrate(pool: Pool, ownerRole: string, appRole: string): Promise<void> {
  if (!ownerRole || !appRole || ownerRole === appRole) throw new Error("OWNER_AND_APP_MUST_DIFFER");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(81374304)");
    const identity = (await client.query("SELECT current_user AS role, current_database() AS db, (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
    if (identity.role !== ownerRole || identity.owner !== ownerRole) throw new Error("MIGRATION_REQUIRES_DATABASE_OWNER");
    const role = (await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1", [appRole])).rows[0];
    if (!role || Object.values(role).some(Boolean)) throw new Error("UNSAFE_RUNTIME_ROLE");
    await client.query("CREATE SCHEMA IF NOT EXISTS goals");
    await client.query("CREATE TABLE IF NOT EXISTS goals.migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const applied = await client.query("SELECT 1 FROM goals.migrations WHERE version=1");
    if (!applied.rowCount) {
      await client.query(readFileSync(new URL("../migrations/001.sql", import.meta.url), "utf8"));
      await client.query("INSERT INTO goals.migrations(version) VALUES(1)");
    }
    await client.query(`REVOKE ALL ON DATABASE ${quote(identity.db)} FROM PUBLIC,${quote(appRole)}`);
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.query(`REVOKE ALL ON SCHEMA goals FROM PUBLIC,${quote(appRole)}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA goals FROM PUBLIC,${quote(appRole)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${quote(identity.db)} TO ${quote(appRole)}`);
    await client.query(`GRANT USAGE ON SCHEMA goals TO ${quote(appRole)}`);
    await client.query(`GRANT SELECT ON goals.migrations TO ${quote(appRole)}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON goals.goals,goals.focus,goals.entries,goals.resources,goals.needs,goals.allocations,goals.requests,goals.exchange_rates TO ${quote(appRole)}`);
    await client.query(`GRANT SELECT,INSERT ON goals.history TO ${quote(appRole)}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = new Pool({ connectionString: process.env.GOALS_OWNER_DATABASE_URL, connectionTimeoutMillis: 5_000 });
  migrate(pool, process.env.GOALS_OWNER_ROLE ?? "", process.env.GOALS_APP_ROLE ?? "")
    .then(() => console.log("goals migration complete"), () => { console.error("goals migration failed"); process.exitCode = 1; })
    .finally(() => pool.end());
}
