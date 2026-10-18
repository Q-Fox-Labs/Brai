// ABOUTME: Применяет миграцию Elements и выдаёт минимальные права runtime-роли.
// ABOUTME: Процесс сервиса не получает владельца БД и не выполняет DDL.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
const quote = (name: string) => `"${name.replaceAll("\"", "\"\"")}"`;
/** Применяет повторяемую миграцию; роли и база должны быть подготовлены оператором. */
export async function migrate(pool: Pool, ownerRole: string, appRole: string): Promise<void> {
  if (!ownerRole || !appRole || ownerRole === appRole) throw new Error("OWNER_AND_APP_MUST_DIFFER"); const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(81374291)");
    const row = (await client.query("SELECT current_user AS role,current_database() AS db,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner")).rows[0];
    if (row.role !== ownerRole || row.owner !== ownerRole) throw new Error("MIGRATION_REQUIRES_DATABASE_OWNER");
    for (const role of [appRole]) { const data = (await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1", [role])).rows[0]; if (!data || Object.values(data).some(Boolean)) throw new Error("UNSAFE_RUNTIME_ROLE"); }
    await client.query(`REVOKE ALL ON DATABASE ${quote(row.db)} FROM PUBLIC,${quote(appRole)}`); await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.query(readFileSync(new URL("../migrations/001.sql", import.meta.url), "utf8"));
    if (Number((await client.query("SELECT count(*) AS n FROM elements.elements")).rows[0].n) > 0) throw new Error("LEGACY_ELEMENTS_REQUIRE_EXPLICIT_MIGRATION");
    await client.query(readFileSync(new URL("../migrations/002-game-core.sql", import.meta.url), "utf8"));
    await client.query(`REVOKE ALL ON SCHEMA game_core FROM PUBLIC,${quote(appRole)}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA game_core FROM PUBLIC,${quote(appRole)}`);
    await client.query(`GRANT USAGE ON SCHEMA game_core TO ${quote(appRole)}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA game_core TO ${quote(appRole)}`);
    await client.query(`REVOKE UPDATE ON game_core.element_revisions,game_core.resources,game_core.attempt_resources,game_core.element_resources FROM ${quote(appRole)}`);
    await client.query(`REVOKE ALL ON SCHEMA elements FROM PUBLIC,${quote(appRole)}`); await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA elements FROM PUBLIC,${quote(appRole)}`); await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA elements FROM PUBLIC,${quote(appRole)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${quote(row.db)} TO ${quote(appRole)}`); await client.query(`GRANT USAGE ON SCHEMA elements TO ${quote(appRole)}`);
    await client.query(`GRANT SELECT ON elements.migrations TO ${quote(appRole)}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE ON elements.elements,elements.moves,elements.move_attempts,elements.outbox TO ${quote(appRole)}`);
    await client.query(`GRANT SELECT,INSERT ON elements.element_revisions,elements.move_element_links TO ${quote(appRole)}`); await client.query(`GRANT SELECT,USAGE ON ALL SEQUENCES IN SCHEMA elements TO ${quote(appRole)}`);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const pool = new Pool({ connectionString: process.env.ELEMENTS_OWNER_DATABASE_URL, connectionTimeoutMillis: 5_000 }); migrate(pool, process.env.ELEMENTS_OWNER_ROLE ?? "", process.env.ELEMENTS_APP_ROLE ?? "").then(() => console.log("elements migration complete"), error => { console.error(`elements migration failed: ${error instanceof Error ? error.message : "UNKNOWN"}`); process.exitCode = 1; }).finally(() => pool.end()); }
