// ABOUTME: Проверяет реальную готовность NATS service и Codex executor.
// ABOUTME: Не читает авторизацию Codex и не создаёт чаты.
import { readFile } from 'node:fs/promises';
import { connect } from 'nats';
import { fileURLToPath } from 'node:url';
import { subjects } from '../contracts/index.mjs';
/** Проверяет ready endpoint, не создавая задания. */
export async function runHealth() {
const config = JSON.parse(await readFile(process.env.BRAI_AGENT_CONFIG!, 'utf8'));
const nc = await connect({ ...config.nats, pass: config.nats.password });
try { const response = await nc.request(subjects.rpc, Buffer.from('{"action":"status"}'), { timeout: 10000 }); if (!JSON.parse(Buffer.from(response.data).toString()).ready) process.exitCode = 1; }
finally { await nc.close(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runHealth();
