// ABOUTME: Проверяет доступность собственной схемы GameCore.
// ABOUTME: Не запускает миграции и не принимает пользовательские команды.
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.GAME_CORE_DATABASE_URL, connectionTimeoutMillis: 3_000 });
try { await pool.query("SELECT 1 FROM game_core.elements LIMIT 0"); console.log(JSON.stringify({ service: "service_game_core", result: "ready" })); } catch { console.error(JSON.stringify({ service: "service_game_core", result: "not_ready" })); process.exitCode = 1; } finally { await pool.end(); }
