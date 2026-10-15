// ABOUTME: Проверяет доступность собственной схемы Elements.
// ABOUTME: Не запускает миграции и не принимает пользовательские команды.
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.ELEMENTS_DATABASE_URL, connectionTimeoutMillis: 3_000 });
try { await pool.query("SELECT 1 FROM elements.migrations"); console.log(JSON.stringify({ service: "service_elements", result: "ready" })); } catch { console.error(JSON.stringify({ service: "service_elements", result: "not_ready" })); process.exitCode = 1; } finally { await pool.end(); }
