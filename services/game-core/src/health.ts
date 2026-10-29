// ABOUTME: Проверяет доступность собственной схемы GameCore.
// ABOUTME: Не запускает миграции и не принимает пользовательские команды.
import { Pool } from "pg";
import { spawnSync } from "node:child_process";
const pool = new Pool({ connectionString: process.env.GAME_CORE_DATABASE_URL, connectionTimeoutMillis: 3_000 });
try {
 const python=spawnSync('/usr/bin/python3',['-B','-c','import hashlib, json, pathlib, tempfile, uuid'],{timeout:3_000,stdio:'ignore'});
 if(python.error||python.status!==0)throw new Error('PLANNING_RUNTIME_UNAVAILABLE');
 await pool.query("SELECT 1 FROM game_core.elements LIMIT 0");
 console.log(JSON.stringify({ service: "service_game_core", result: "ready" }));
} catch { console.error(JSON.stringify({ service: "service_game_core", result: "not_ready" })); process.exitCode = 1; } finally { await pool.end(); }
