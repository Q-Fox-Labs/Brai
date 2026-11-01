// ABOUTME: Проверяет доступность схемы целей под runtime-ролью.
// ABOUTME: Не читает личные сведения и не меняет состояние.
import { Pool } from "pg";
const pool = new Pool({connectionString:process.env.GOALS_DATABASE_URL,connectionTimeoutMillis:3_000,statement_timeout:3_000});
try {
  if (!(await pool.query("SELECT 1 FROM goals.migrations WHERE version=1")).rowCount) throw new Error("MIGRATION_REQUIRED");
  await pool.query("SELECT 1 FROM goals.goals LIMIT 0");
  console.log(JSON.stringify({service:"service_goals",result:"ready"}));
} catch {
  console.error(JSON.stringify({service:"service_goals",result:"not_ready"}));
  process.exitCode = 1;
} finally {await pool.end();}
