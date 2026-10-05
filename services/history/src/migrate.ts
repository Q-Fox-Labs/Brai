// ABOUTME: Атомарно создаёт схему истории, системный seed и минимальные SQL-права.
// ABOUTME: Только отдельный владелец БД выполняет миграции; рабочий процесс не получает его секреты.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
/** Применяет повторяемую миграцию и grants; существующие безопасные роли создаёт оператор. */
export async function migrate(pool: Pool, ownerRole: string, appRole: string, webRole: string): Promise<void> {
  if (![ownerRole, appRole, webRole].every(Boolean) || new Set([ownerRole, appRole, webRole]).size !== 3) throw new Error("HISTORY_ROLES_MUST_DIFFER");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(70482318)");
    const { rows } = await client.query("SELECT current_user AS role,current_database() AS db,(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner");
    if (rows[0].role !== ownerRole || rows[0].owner !== ownerRole) throw new Error("MIGRATION_REQUIRES_DATABASE_OWNER");
    for (const role of [appRole, webRole]) {
      const data = (await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1", [role])).rows[0];
      const memberships = (await client.query("SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1", [role])).rowCount;
      if (!data || Object.values(data).some(Boolean) || memberships) throw new Error("UNSAFE_RUNTIME_ROLE");
      const owned = (await client.query("SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname=$1) AND relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('history','public'))", [role])).rowCount;
      if (owned) throw new Error("RUNTIME_ROLE_OWNS_TABLES");
    }
    await client.query(`REVOKE ALL ON DATABASE ${quote(rows[0].db)} FROM PUBLIC,${quote(appRole)},${quote(webRole)}`);
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await client.query(`REVOKE CREATE ON SCHEMA public FROM ${quote(appRole)},${quote(webRole)}`);
    // AIDEV-NOTE: Повтор всегда сверяет закреплённые seed ID/code/category; журнал не скрывает повреждённый seed.
    await client.query(readFileSync(new URL("../migrations/001.sql", import.meta.url), "utf8"));
    const schemaOwner = (await client.query("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='history'")).rows[0]?.owner;
    const wrongTableOwner = (await client.query("SELECT 1 FROM pg_class WHERE relnamespace='history'::regnamespace AND relowner<>(SELECT oid FROM pg_roles WHERE rolname=$1)", [ownerRole])).rowCount;
    if (schemaOwner !== ownerRole || wrongTableOwner) throw new Error("HISTORY_REQUIRES_MIGRATION_OWNER");
    await client.query(`REVOKE ALL ON SCHEMA history FROM PUBLIC,${quote(appRole)},${quote(webRole)}`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA history FROM PUBLIC,${quote(appRole)},${quote(webRole)}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA history FROM PUBLIC,${quote(appRole)},${quote(webRole)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${quote(rows[0].db)} TO ${quote(appRole)},${quote(webRole)}`);
    await client.query(`GRANT USAGE ON SCHEMA history TO ${quote(appRole)},${quote(webRole)}`);
    await client.query(`GRANT SELECT ON history.sys_categories,history.sys_types,history.events TO ${quote(appRole)},${quote(webRole)}`);
    await client.query(`GRANT INSERT(code,name,description) ON history.sys_categories TO ${quote(appRole)}`);
    await client.query(`GRANT INSERT(category_id,code,name,description) ON history.sys_types TO ${quote(appRole)}`);
    await client.query(`GRANT INSERT(id,source,type_id,occurred_at,actor_id,scope_type,scope_id,object_type,object_id,data) ON history.events TO ${quote(appRole)}`);
    await client.query(`GRANT UPDATE(name,description) ON history.sys_categories,history.sys_types TO ${quote(appRole)}`);
    await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA history TO ${quote(appRole)}`);
    await client.query("DROP POLICY IF EXISTS history_internal_read ON history.events");
    await client.query("DROP POLICY IF EXISTS history_internal_append ON history.events");
    await client.query("DROP POLICY IF EXISTS history_web_read ON history.events");
    await client.query(`CREATE POLICY history_internal_read ON history.events FOR SELECT TO ${quote(appRole)} USING(true)`);
    await client.query(`CREATE POLICY history_internal_append ON history.events FOR INSERT TO ${quote(appRole)} WITH CHECK(true)`);
    await client.query(`CREATE POLICY history_web_read ON history.events FOR SELECT TO ${quote(webRole)} USING(scope_type='user' AND scope_id=NULLIF(current_setting('app.user_id',true),''))`);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.HISTORY_OWNER_DATABASE_URL;
  if (!url) throw new Error("HISTORY_OWNER_DATABASE_URL_REQUIRED");
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await migrate(pool, process.env.HISTORY_OWNER_ROLE ?? "", process.env.HISTORY_APP_ROLE ?? "", process.env.HISTORY_WEB_ROLE ?? "");
    console.log("history migration complete");
  } catch (error) { console.error("history migration failed", error instanceof Error ? error.message : "UNKNOWN"); process.exitCode = 1; }
  finally { await pool.end(); }
}
