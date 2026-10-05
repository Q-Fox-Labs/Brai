// ABOUTME: Поднимает официальный Better Auth и NATS adapter с локальным OTP callback.
// ABOUTME: Подключается только к отдельным test PG/NATS и отдаёт OTP на loopback.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from 'nats';
import pg from 'pg';

if (process.env.BRAI_ACCEPTANCE_GATE !== 'accepted') throw new Error('Acceptance gate is closed');
const gateRunId = process.env.BRAI_ACCEPTANCE_RUN_ID ?? '';
if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(gateRunId)) throw new Error('Set a unique BRAI_ACCEPTANCE_RUN_ID');
if (!/^[0-9a-f]{40}$/.test(process.env.BRAI_ACCEPTANCE_SOURCE_REVISION ?? '')) throw new Error('Set exact accepted BRAI_ACCEPTANCE_SOURCE_REVISION');
const authUrl = new URL(required('BRAI_ACCEPTANCE_AUTH_DATABASE_URL'));
const natsUrl = new URL(required('BRAI_ACCEPTANCE_NATS_URL'));
const authDatabase = required('BRAI_ACCEPTANCE_AUTH_DATABASE_NAME');
if (!/^[a-z_][a-z0-9_]*$/.test(authDatabase) || authUrl.protocol !== 'postgresql:' || !['db', 'postgres'].includes(authUrl.hostname) || authUrl.pathname !== `/${authDatabase}`) throw new Error('Refusing non-fixture PostgreSQL URL');
if (!/^[a-z_][a-z0-9_]*$/.test(required('BRAI_ACCEPTANCE_AUTH_APP_ROLE')) || authUrl.username !== process.env.BRAI_ACCEPTANCE_AUTH_APP_ROLE) throw new Error('PostgreSQL URL must use the explicit acceptance app role');
if (natsUrl.protocol !== 'nats:' || natsUrl.hostname !== 'nats' || natsUrl.port !== '4222' || natsUrl.pathname) throw new Error('Refusing non-fixture NATS URL');
const otpPort = Number(process.env.BRAI_ACCEPTANCE_OTP_PORT ?? '13006');
if (otpPort !== 13006) throw new Error('OTP callback port is fixed to 13006');
const testEmails = new Set((process.env.BRAI_ACCEPTANCE_TEST_EMAILS ?? '').split(',').map(value => value.trim()).filter(Boolean));
if (!testEmails.size || [...testEmails].some(email => !/^[^@]+@brai\.invalid$/.test(email))) throw new Error('Set an explicit comma-separated BRAI_ACCEPTANCE_TEST_EMAILS allowlist under @brai.invalid');
const runtimeRoot = resolve(process.env.BRAI_ACCEPTANCE_RUNTIME_ROOT ?? '/app');
const { Pool } = pg;
const { createAuth } = await import(pathToFileURL(resolve(runtimeRoot, 'services/auth/dist/auth.js')).href);
const { runNats } = await import(pathToFileURL(resolve(runtimeRoot, 'services/auth/dist/nats.js')).href);
const pool = new Pool({ connectionString: authUrl.href, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
const origin = 'http://127.0.0.1:13000';
const pendingOtp = new Map();
const config = {
  databaseURL: authUrl.href,
  secret: required('BRAI_ACCEPTANCE_AUTH_SECRET'),
  origin,
  emailFrom: 'Test fixture <test@brai.invalid>',
  resendKey: '',
  natsServers: [natsUrl.href],
  natsUser: required('BRAI_ACCEPTANCE_NATS_USER'),
  natsPassword: required('BRAI_ACCEPTANCE_NATS_PASSWORD'),
};
assert.ok(config.secret.length >= 32);
const auth = createAuth(config, pool, async (email, otp) => {
  if (!testEmails.has(email) || !/^\d{6}$/.test(otp)) throw new Error('Unexpected test OTP request');
  pendingOtp.set(email, otp);
});
const identity = (await pool.query('SELECT current_user, current_database(), (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS elevated')).rows[0];
if (identity.current_user !== authUrl.username || identity.current_database !== authDatabase || identity.elevated) throw new Error('Auth fixture PostgreSQL identity is not the scoped runtime role');
await pool.query('SELECT 1 FROM "session" LIMIT 0');
const nats = await connect({
  servers: config.natsServers, user: config.natsUser, pass: config.natsPassword,
  inboxPrefix: '_INBOX.brai_auth', maxReconnectAttempts: -1,
  timeout: 5000, name: `brai_acceptance_auth_${gateRunId}`,
});
const adapter = await runNats(nats, config, auth.handler);
const otpServer = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (!['127.0.0.1', '::1', '172.30.59.1'].includes(request.socket.remoteAddress)) {
    response.writeHead(403).end(); return;
  }
  const email = url.searchParams.get('address');
  const otp = email && testEmails.has(email) ? pendingOtp.get(email) : undefined;
  if (request.method !== 'GET' || url.pathname !== '/__test/otp' || !otp) {
    response.writeHead(404, { 'cache-control': 'no-store' }).end(); return;
  }
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify({ otp }));
  pendingOtp.delete(email);
});
await new Promise((accept, reject) => {
  otpServer.once('error', reject);
  otpServer.listen(otpPort, '0.0.0.0', accept);
});
console.info(JSON.stringify({ component: 'artifacts-acceptance-auth-fixture', event: 'ready', runId: gateRunId, otpAddress: '127.0.0.1:13006' }));

let closing;
const stop = () => closing ??= (async () => {
  await new Promise(accept => otpServer.close(accept));
  await adapter.stop();
  await nats.drain();
  await pool.end();
})();
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
await nats.closed();
await stop();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} from the operation-2 test fixture`);
  return value;
}
