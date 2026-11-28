// ABOUTME: Проверяет запись Welcome и переход к гостю через настоящий Auth и персональный MCP.
// ABOUTME: Использует только явно заданный изолированный PostgreSQL и локальный NATS.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {connect} from 'nats';
import {Pool} from 'pg';
import {createAuthAccess} from '../dist/auth-access.js';
import {bindOwner, migrateIsolation, verifyOwnerConnection} from '../dist/isolation.js';
import {migrate} from '../dist/migrate.js';
import {startMcp} from '../dist/mcp.js';
import {createStore} from '../dist/store.js';
import {connectMcpEndpoint} from '../../hermes/runtime.mjs';

const pg = process.env.WELCOME_FIXTURE_PG;
const nats = process.env.WELCOME_FIXTURE_NATS;
const secret = 'welcome-synthetic-fixture-only-1234';

test('Welcome: два личных MCP, тот же владелец и история после активации гостя', {skip: !pg || !nats}, async t => {
 const base = new URL(pg), broker = new URL(nats);
 assert.equal(base.hostname, '127.0.0.1');
 assert.equal(base.pathname, '/postgres');
 assert.equal(base.username, 'welcome_fixture_root');
 assert.ok(base.port);
 assert.equal(broker.protocol, 'nats:');
 assert.equal(broker.hostname, '127.0.0.1');
 assert.ok(broker.port);
 const {adminAction} = await import('../../auth/dist/admin.js');
 const {runNats} = await import('../../auth/dist/nats.js');
 const folder = await mkdtemp(join(tmpdir(), 'brai-welcome-proof-'));
 const pools = [], listeners = [], clients = [], runtimes = [];
 const sql = (connectionString) => {
  const pool = new Pool({connectionString});
  pools.push(pool);
  return pool;
 };
 const url = (db, login) => {
  const value = new URL(base);
  value.pathname = '/' + db;
  value.username = login;
  return value.href;
 };
 const nc = await connect({servers: nats, maxReconnectAttempts: 0});
 t.after(async () => {
  await Promise.allSettled(clients.map(client => client.close()));
  await Promise.allSettled(listeners.map(listener => listener.close()));
  await Promise.allSettled(runtimes.map(runtime => runtime.stop()));
  await nc.close();
  await Promise.allSettled(pools.map(pool => pool.end()));
  await rm(folder, {recursive: true, force: true});
 });
 const root = sql(pg);
 for (const role of ['welcome_auth_owner', 'welcome_auth_app', 'welcome_dialogues_owner', 'welcome_dialogues_a', 'welcome_dialogues_b']) {
  await root.query('CREATE ROLE ' + role + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT');
 }
 await root.query('CREATE DATABASE welcome_auth_fixture OWNER welcome_auth_owner');
 await root.query('CREATE DATABASE welcome_dialogues_fixture OWNER welcome_dialogues_owner');
 const authOwnerUrl = url('welcome_auth_fixture', 'welcome_auth_owner');
 await promisify(execFile)(process.execPath, [new URL('../../auth/dist/migrate.js', import.meta.url).pathname], {
  env: {...process.env, AUTH_DATABASE_URL: authOwnerUrl, AUTH_OWNER_ROLE: 'welcome_auth_owner', AUTH_APP_ROLE: 'welcome_auth_app',
   AUTH_IDENTITY_MODE: 'telegram', AUTH_ORIGIN: 'https://fixture.invalid', AUTH_SECRET: secret}
 });
 const authOwner = sql(authOwnerUrl);
 const authApp = sql(url('welcome_auth_fixture', 'welcome_auth_app'));
 const actor = randomUUID();
 await authOwner.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,false,now(),now())',
  [actor, 'Fixture admin', 'fixture-admin@fixture.invalid']);
 await authOwner.query("INSERT INTO brai_identity(user_id,role,status) VALUES($1,'creator','active')", [actor]);

 const auth = {identityMode: 'telegram', secret};
 const startAuth = async config => {
  const runtime = await runNats(nc, config, () => { throw Error('Unexpected web auth request'); }, authApp);
  runtimes.push(runtime);
  await nc.flush();
  return runtime;
 };
 const request = async (operation, value) => {
  const message = await nc.request('brai.auth.v2.' + operation, Buffer.from(JSON.stringify(value)), {timeout: 3000});
  return {ok: !message.headers?.get('Nats-Service-Error-Code'), body: JSON.parse(Buffer.from(message.data).toString() || '{}')};
 };
 const start = await startAuth(auth);
 const registration = {requestId: 'welcome-a', telegramId: '710001', name: 'Первый'};
 const a = (await request('welcome-register', registration)).body.user;
 const b = (await request('welcome-register', {requestId: 'welcome-b', telegramId: '710002', name: 'Второй'})).body.user;
 assert.deepEqual((await request('welcome-register', registration)).body.user, a);
 assert.equal((await request('welcome-register', {...registration, telegramId: '710003'})).ok, false);
 assert.equal((await request('welcome-register', {...registration, role: 'admin'})).ok, false);
 assert.equal((await request('profile-ready', {userId: a.id, profileId: a.profileId})).body.user, null);
 assert.equal((await request('lifecycle-claim', {workerId: 'fixture', rolePolicyVersion: 1})).body.operation, null);
 assert.equal((await request('telegram-code-issue', {telegramId: registration.telegramId, requestId: 'before-approved'})).ok, false);
 assert.equal(a.role, 'welcome');
 assert.equal(b.role, 'welcome');

 const bindings = [a, b].map((user, i) => ({
  userId: user.id, profileId: user.profileId, subject: 'brai.auth.v2.dialogues-access.' + String(i + 1).repeat(64)
 }));
 const bindingsFile = join(folder, 'bindings.json');
 await writeFile(bindingsFile, JSON.stringify(bindings), {mode: 0o600});
 await start.stop();
 runtimes.pop();
 await startAuth({...auth, dialoguesBindingsFile: bindingsFile});

 const owner = 'welcome_dialogues_owner';
 const dialoguesOwner = sql(url('welcome_dialogues_fixture', owner));
 await migrate(dialoguesOwner, owner, 'welcome_dialogues_a');
 await migrateIsolation(dialoguesOwner, owner);
 const startOwner = async (binding, login) => {
  const ownerBinding = {userId: binding.userId, profileId: binding.profileId, ownerId: binding.userId};
  await bindOwner(dialoguesOwner, owner, login, ownerBinding);
  const pool = sql(url('welcome_dialogues_fixture', login));
  await verifyOwnerConnection(pool, ownerBinding);
  const settings = {host: '127.0.0.1', port: 0, hosts: [], origins: [], owner: ownerBinding.ownerId,
   token: randomUUID().replaceAll('-', ''), personal: {...ownerBinding, authorize: createAuthAccess(nc, binding.subject, binding)}};
  const listener = await startMcp(createStore(pool, 'welcome-fixture-cursor'), settings, () => {});
  listeners.push(listener);
  settings.hosts.push(new URL(listener.url).host);
  return {url: listener.url, token: settings.token, ...ownerBinding};
 };
 const endpointA = await startOwner(bindings[0], 'welcome_dialogues_a');
 const endpointB = await startOwner(bindings[1], 'welcome_dialogues_b');
 const client = endpoint => {
  const value = connectMcpEndpoint(endpoint, {endpointName: 'dialogues'});
  clients.push(value);
  return value;
 };
 const welcomeA = client(endpointA), welcomeB = client(endpointB);
 const exchange = async (endpoint, action, args, automaticReceipt) => {
  const result = await endpoint.call('dialogues_exchange', {action, arguments: args}, undefined, automaticReceipt);
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent;
 };
 const id = 'same-telegram-chat-id';
 const saveTurn = async (endpoint, text) => {
  const args = {request_id: 'welcome-input', dialogue: {id, channel: 'telegram'}, messages: [{id: 'input-1', text}]};
  const input = await exchange(endpoint, 'input', args, 'start');
  const final = {request_id: 'welcome-final', dialogue_id: id, turn_id: input.turn_id,
   expected_version: input.version, final: {id: 'final-1', text: 'Ответ справочной'}};
  assert.equal((await exchange(endpoint, 'finish', final)).status, 'completed');
  assert.equal((await exchange(endpoint, 'finish', final)).status, 'completed');
 };
 await saveTurn(welcomeA, 'Данные только первого пользователя');
 await saveTurn(welcomeB, 'Данные только второго пользователя');
 await assert.rejects(client({...endpointA, token: endpointB.token}).list(), error => error.code === 401);
 await assert.rejects(client({...endpointA, profileId: endpointB.profileId}).list(), error => error.code === 403);

 const grant = {requestId: 'approved-welcome-a', telegramId: registration.telegramId, role: 'guest'};
 assert.equal((await adminAction(authApp, secret, actor, 'users-add', {...grant, requestId: 'invalid-role', role: 'user'})).status, 409);
 assert.equal((await adminAction(authApp, secret, actor, 'status-set', {requestId: 'invalid-active', userId: a.id, status: 'active'})).status, 409);
 assert.equal((await adminAction(authApp, secret, b.id, 'users-add', grant)).status, 403);
 const approval = await adminAction(authApp, secret, actor, 'users-add', grant);
 assert.equal(approval.status, 200);
 assert.equal(approval.body.user.id, a.id);
 assert.equal(approval.body.user.profileId, a.profileId);
 assert.equal(approval.body.user.role, 'guest');
 assert.equal(approval.body.user.status, 'provisioning');
 assert.equal((await adminAction(authApp, secret, actor, 'users-add', grant)).body.operation.id, approval.body.operation.id);
 assert.equal((await request('profile-ready', {userId: a.id, profileId: a.profileId})).body.user, null);
 const {operation} = (await request('lifecycle-claim', {workerId: 'synthetic-hermes', rolePolicyVersion: 1})).body;
 assert.equal(operation.id, approval.body.operation.id);
 assert.equal((await request('lifecycle-complete', {operationId: operation.id, leaseToken: operation.leaseToken, success: true})).body.accepted, true);
 assert.equal((await request('telegram-resolve', {telegramId: registration.telegramId})).body.user.status, 'active');

 await welcomeA.close();
 const guest = client(endpointA);
 const continued = await exchange(guest, 'input', {request_id: 'first-guest-input', dialogue: {id, channel: 'telegram'},
  messages: [{id: 'input-2', text: 'Продолжим тот же разговор'}]}, 'start');
 assert.match(JSON.stringify(continued.context), /Данные только первого пользователя/);
 assert.doesNotMatch(JSON.stringify(continued.context), /Данные только второго пользователя/);
 assert.equal((await exchange(guest, 'read', {request_id: 'read-first', dialogue_id: id, message_id: 'input-1'})).text,
  'Данные только первого пользователя');
 const count = await dialoguesOwner.query('SELECT count(*)::int AS n FROM dialogues_live.messages');
 assert.equal(count.rows[0].n, 5);
});
