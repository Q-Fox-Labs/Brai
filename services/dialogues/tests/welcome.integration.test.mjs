// ABOUTME: Проверяет запись Welcome и переход к гостю через настоящий Auth и персональный MCP.
// ABOUTME: Использует только явно заданный изолированный PostgreSQL и локальный NATS.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
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
import {welcomeOwner} from '../dist/welcome-owner.js';
import {createWelcome,dialogueId} from '../../welcome/src/service.mjs';
import {authPort,dialoguesPort} from '../../welcome/src/ports.mjs';
import {welcomeAdmin} from '../../welcome/src/admin.mjs';
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
 const {createAuth} = await import('../../auth/dist/auth.js');
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
 let nc;
 t.after(async () => {
  await Promise.allSettled(clients.map(client => client.close()));
  await Promise.allSettled(listeners.map(listener => listener.close()));
  await Promise.allSettled(runtimes.map(runtime => runtime.stop()));
  await nc?.close();
  await Promise.allSettled(pools.map(pool => pool.end()));
  await rm(folder, {recursive: true, force: true});
 });
 nc = await connect({servers: nats, maxReconnectAttempts: 0});
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
 await authOwner.query("INSERT INTO brai_identity(user_id,telegram_id,profile_id,role,status) VALUES($1,'710010',$2,'creator','active')",
  [actor, randomUUID()]);

 const origin = 'https://fixture.invalid';
 const auth = {identityMode: 'telegram', origin, trustedOrigins: [origin], secret};
 const engine = createAuth(auth, authApp);
 const startAuth = async config => {
  const runtime = await runNats(nc, config, engine.handler, authApp);
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
 const [firstRegistration, concurrentRegistration] = await Promise.all([
  request('welcome-register', registration),
  request('welcome-register', {...registration, requestId: 'welcome-a-concurrent'})
 ]);
 const a = firstRegistration.body.user;
 assert.equal(firstRegistration.ok, true);
 assert.equal(concurrentRegistration.ok, true);
 assert.deepEqual(concurrentRegistration.body.user, a);
 const b = (await request('welcome-register', {requestId: 'welcome-b', telegramId: '710002', name: 'Второй'})).body.user;
 assert.deepEqual((await request('welcome-register', registration)).body.user, a);
 const repeatLookup = await Promise.all(['welcome-a-repeat-1', 'welcome-a-repeat-2'].map(requestId =>
  request('welcome-register', {...registration, requestId})));
 assert.ok(repeatLookup.every(reply => reply.ok && reply.body.user.id === a.id && reply.body.user.profileId === a.profileId));
 assert.equal((await request('welcome-register', {...registration, telegramId: '710003'})).ok, false);
 assert.equal((await request('welcome-register', {...registration, role: 'admin'})).ok, false);
 assert.equal((await request('profile-ready', {userId: a.id, profileId: a.profileId})).body.user, null);
 assert.equal((await request('lifecycle-claim', {workerId: 'fixture', rolePolicyVersion: 1})).body.operation, null);
 assert.equal((await request('telegram-code-issue', {telegramId: registration.telegramId, requestId: 'before-approved'})).ok, false);
 assert.equal(a.role, 'welcome');
 assert.equal(b.role, 'welcome');
 await assert.rejects(authApp.query("UPDATE brai_identity SET status='active' WHERE user_id=$1", [a.id]), {code: '23514'});

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
  const settings = {host: '127.0.0.1', port: 0, hosts: ['127.0.0.1'], origins: ['http://127.0.0.1'], owner: ownerBinding.ownerId,
   token: randomUUID().replaceAll('-', ''), personal: {...ownerBinding, authorize: createAuthAccess(nc, binding.subject, binding)}};
  const listener = await startMcp(createStore(pool, 'welcome-fixture-cursor'), settings, () => {});
  listeners.push(listener);
  settings.hosts.push(new URL(listener.url).host);
  return {url: listener.url, token: settings.token, ...ownerBinding};
 };
 const endpointA = await startOwner(bindings[0], 'welcome_dialogues_a');
 const endpointB = await startOwner(bindings[1], 'welcome_dialogues_b');
 const client = async endpoint => {
  const value = await connectMcpEndpoint(endpoint, {endpointName: 'dialogues'});
  clients.push(value);
  return value;
 };
 const welcomeA = await client(endpointA), welcomeB = await client(endpointB);
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
 await assert.rejects((await client({...endpointA, token: endpointB.token})).list(), error => error.code === 401);
 await assert.rejects((await client({...endpointA, profileId: endpointB.profileId})).list(), error => error.code === 403);

 const grant = {requestId: 'approved-welcome-a', telegramId: registration.telegramId, role: 'guest'};
 const issued = await request('telegram-code-issue', {telegramId: '710010', requestId: 'fixture-admin-login'});
 assert.equal(issued.ok, true);
 const signed = (await request('login-code-redeem', {headers: {origin, 'x-forwarded-for': '192.0.2.77'}, body: {code: issued.body.code}})).body;
 assert.equal(signed.status, 200);
 const cookie = signed.setCookies.map(value => value.split(';')[0]).join('; ');
 assert.ok(cookie);
 const admin = async (operation, body) => (await request(operation, {headers: {origin, cookie}, body})).body;
 assert.equal((await admin('users-add', {...grant, requestId: 'invalid-role', role: 'user'})).status, 409);
 assert.equal((await admin('status-set', {requestId: 'invalid-active', userId: a.id, status: 'active'})).status, 409);
 assert.equal((await request('users-add', {headers: {origin}, body: grant})).body.status, 401);
 const approval = await admin('users-add', grant);
 assert.equal(approval.status, 200);
 assert.equal(approval.body.user.id, a.id);
 assert.equal(approval.body.user.profileId, a.profileId);
 assert.equal(approval.body.user.role, 'guest');
 assert.equal(approval.body.user.status, 'provisioning');
 const audit = await authOwner.query('SELECT actor_id,old_role,new_role FROM brai_identity_audit WHERE request_id=$1', [grant.requestId]);
 assert.deepEqual(audit.rows, [{actor_id: actor, old_role: 'welcome', new_role: 'guest'}]);
 assert.equal((await admin('users-add', grant)).body.operation.id, approval.body.operation.id);
 assert.equal((await request('profile-ready', {userId: a.id, profileId: a.profileId})).body.user, null);
 const {operation} = (await request('lifecycle-claim', {workerId: 'synthetic-hermes', rolePolicyVersion: 1})).body;
 assert.equal(operation.id, approval.body.operation.id);
 assert.equal((await request('lifecycle-complete', {operationId: operation.id, leaseToken: operation.leaseToken, success: true})).body.accepted, true);
 assert.equal((await request('telegram-resolve', {telegramId: registration.telegramId})).body.user.status, 'active');
 assert.equal((await request('welcome-register', registration)).body.user.role, 'guest');

 await welcomeA.close();
 const guest = await client(endpointA);
 const continued = await exchange(guest, 'input', {request_id: 'first-guest-input', dialogue: {id, channel: 'telegram'},
  messages: [{id: 'input-2', text: 'Продолжим тот же разговор'}]}, 'start');
 assert.match(JSON.stringify(continued.context), /Данные только первого пользователя/);
 assert.doesNotMatch(JSON.stringify(continued.context), /Данные только второго пользователя/);
 assert.equal((await exchange(guest, 'read', {request_id: 'read-first', dialogue_id: id, message_id: 'input-1'})).text,
  'Данные только первого пользователя');
 assert.equal((await exchange(guest, 'read', {request_id: 'read-first-answer', dialogue_id: id, message_id: 'final-1'})).text,
  'Ответ справочной');
 const count = async login => (await sql(url('welcome_dialogues_fixture', login)).query('SELECT count(*)::int AS n FROM dialogues_live.messages')).rows[0].n;
 assert.equal(await count('welcome_dialogues_a'), 3);
 assert.equal(await count('welcome_dialogues_b'), 2);

 const blocked = await admin('users-revoke', {requestId: 'block-welcome-b', userId: b.id});
 assert.equal(blocked.body.user.status, 'blocked');
 assert.equal(blocked.body.user.profileId, b.profileId);
 assert.equal(blocked.body.operation.state, 'succeeded');
 assert.equal((await request('lifecycle-claim', {workerId: 'fixture', rolePolicyVersion: 1})).body.operation, null);
 await assert.rejects(welcomeB.list(), error => error.code === 403);
 assert.equal(await count('welcome_dialogues_b'), 2);

 await root.query('CREATE DATABASE welcome_service_fixture');
 const welcomeDb=sql(url('welcome_service_fixture','welcome_fixture_root'));
 await welcomeDb.query(await readFile(new URL('../../welcome/migrations/001.sql',import.meta.url),'utf8'));
 await welcomeDb.query('UPDATE welcome.settings SET enabled=true,request_limit=1 WHERE singleton');
 const portProbe=createServer();
 await new Promise(done=>portProbe.listen(0,'127.0.0.1',done));
 const listenPort=portProbe.address().port;
 await new Promise(done=>portProbe.close(done));
 const publicOrigin='http://127.0.0.1:'+listenPort;
 const grantToken='welcome-dialogues-fixture-grant-only-test';
 const gateway=welcomeOwner({owner:dialoguesOwner,administrator:root,ownerRole:owner,
  databaseURL:url('welcome_dialogues_fixture',owner),publicOrigin,grantToken,secret:'welcome-fixture-owner-only-secret',
  authorize:async userId=>(await request('identity-get',{userId})).body.user
 });
 await new Promise((done,reject)=>gateway.server.once('error',reject).listen(listenPort,'127.0.0.1',done));
 listeners.push(gateway);
 const welcomeAuth=authPort({async request(topic,value){
  const reply=await nc.request(topic,Buffer.from(JSON.stringify(value)),{timeout:3000});
  if(reply.headers?.get('Nats-Service-Error-Code'))throw Error('fixture RPC rejected');
  return JSON.parse(Buffer.from(reply.data).toString());
 }});
 const decisions={
  'Тестовый вопрос':{action:'answer',text:'Ответ справочной для фикстуры',valid:false},
  'Второй запрос':{action:'answer',text:'Превышение квоты',valid:false},
  'Только текст':{action:'voice-off',text:'',valid:false},
  'Хочу гостевой доступ':{action:'apply',text:'',valid:false},
  '...':{action:'question',text:'Опишите занятие подробнее.',valid:false},
  'Преподаю историю':{action:'question',text:'',valid:true},
  'Подготовка учебных материалов':{action:'question',text:'',valid:true},
  'Пришли реферальную ссылку':{action:'referral',text:'',valid:false}
 };
 const model={async respond({text}){assert.ok(decisions[text],text);return decisions[text];}};
 const bridge=dialoguesPort({origin:publicOrigin,token:grantToken});
 const service=createWelcome({pool:welcomeDb,auth:welcomeAuth,dialogues:bridge,model,botName:'fixture_welcome_bot'});
 const operator=welcomeAdmin(welcomeDb,welcomeAuth,model);
 const headers={origin,cookie};
 const ingress={botId:'710100',telegramId:'710005',name:'Посетитель'};
 let update=0;
 const send=(text,kind='text',extra={})=>service.handle({...ingress,kind,text,updateId:String(++update),...extra});
 assert.match((await send('прикрыли файлом','file')).text,/не принимает файлы/);
 assert.equal(await welcomeAuth.resolve(ingress.telegramId),null);
 assert.match((await send('/start')).text,/Привет/);
 assert.equal((await send('Тестовый вопрос')).text,'Ответ справочной для фикстуры');
 assert.match((await send('Второй запрос')).text,/лимит запросов исчерпан/i);
 assert.equal((await send('Только текст')).voice,false);
 const referral=(await send('Пришли реферальную ссылку')).text.split('start=')[1];
 await send('/start '+referral,'text',{name:'Приглашённый',telegramId:'710006'});
 assert.equal((await operator('visitors',{},headers)).items.find(row=>row.telegram_id==='710006').inviter_name,ingress.name);
 assert.match((await send('Хочу гостевой доступ')).text,/Чем вы занимаетесь/);
 assert.match((await send('...')).text,/Опишите занятие подробнее/);
 assert.match((await send('Преподаю историю')).text,/Для чего/);
 assert.equal((await send('Подготовка учебных материалов')).button,'submit');
 assert.match((await send(null,'callback',{action:'submit'})).text,/Заявка отправлена/);
 const application=(await operator('applications',{},headers)).items[0];
 assert.equal(application.occupation,'Преподаю историю');
 assert.equal(application.purpose,'Подготовка учебных материалов');
 const before=await welcomeAuth.resolve(ingress.telegramId);
 const fetchEndpoint=async()=>{
  const response=await fetch(publicOrigin+'/endpoint',{method:'POST',headers:{authorization:'Bearer '+grantToken},
   body:JSON.stringify({userId:before.id,profileId:before.profileId})});
  assert.equal(response.status,200);
  return response.json();
 };
 const exactEndpoint=await fetchEndpoint();
 const decision=await operator('decision',{applicationId:application.id,decision:'approve'},headers);
 const approved=(await request('lifecycle-claim',{workerId:'synthetic-hermes',rolePolicyVersion:1})).body.operation;
 assert.equal(approved.id,decision.operation.id);
 assert.equal((await request('lifecycle-complete',{operationId:approved.id,leaseToken:approved.leaseToken,success:true})).body.accepted,true);
 const after=await welcomeAuth.resolve(ingress.telegramId);
 assert.equal(after.id,before.id);
 assert.equal(after.profileId,before.profileId);
 assert.equal(after.role,'guest');
 assert.equal(after.status,'active');
 assert.deepEqual(await fetchEndpoint(),exactEndpoint);
 assert.equal((await operator('applications',{},headers)).items[0].status,'approved');
 assert.deepEqual(await send('Продолжим'),{pass:true});
 const guestEndpoint=await client({...exactEndpoint,ownerId:before.id});
 const continuity=await exchange(guestEndpoint,'input',{request_id:'welcome-native-guest-input',
  dialogue:{id:dialogueId(ingress),channel:'telegram'},messages:[{id:'guest-first',text:'Продолжим'}]},'start');
 assert.match(JSON.stringify(continuity.context),/Ответ справочной для фикстуры/);
});
