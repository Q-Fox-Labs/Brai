// ABOUTME: Проверяет настоящие queued/in-flight/computed/delivery restart и повтор доставки history.
// ABOUTME: Только изолированная собственная среда; SQL read-only, без фиктивного выполнения и вывода содержимого.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createServer } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { connect } from 'nats';
import pg from 'pg';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { loadCoordinatorConfig } from '../../dist/coordinator/config.js';
import { methodMap, validateDto } from '../../contracts/index.mjs';
import { subjects as artifactSubjects, validateRequest as artifactRequest, validateResponse as artifactResponse } from '../../../artifacts/contracts/index.mjs';
import { subjects as localSubjects, validateRequest as localRequest } from '../../../local-ai/contracts/index.mjs';
import historyCommon from '../../../history/schemas/common.schema.json' with { type: 'json' };
import historyMessages from '../../../history/schemas/messages.schema.json' with { type: 'json' };

const ownRoot = '/home/agent/.codex/worktrees/brai-transcription/brai/services/transcription/';
const spokenRoot = '/var/lib/brai-transcription-acceptance/fixtures/asr-ru';
const actorPath = '/srv/projects/admin/tmp/transcription-restart-history-control.yml';
const responseBytes = 1048576;
const callMs = 10000;
// AIDEV-NOTE: Stage4 request budget 120 s + reply grace 15 s + bounded capture margin 15 s.
const phaseMs = 150000;
const prefix = 'transcription-acceptance-';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const same = isDeepStrictEqual;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function bounded(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}
async function until(read, matches, message, ms = phaseMs) {
  const end = Date.now() + ms;
  do { const value = await read(); if (matches(value)) return value; await pause(50); } while (Date.now() < end);
  throw new Error(message);
}
function ownNats(value, user, inboxPrefix) {
  let url;
  try { url = new URL(value.servers); } catch { throw new Error('Own broker configuration rejected'); }
  assert.ok(url.protocol === 'nats:' && url.hostname === '127.0.0.1' && url.port === '19680' && !url.username && !url.password && !url.search && !url.hash && (!url.pathname || url.pathname === '/'), 'own broker only');
  assert.ok(value.user === user && value.inboxPrefix === inboxPrefix && typeof value.pass === 'string' && value.pass.length > 0 && !value.token, 'exact own principal required');
}
function clientSettings(envPrefix, user, inboxPrefix) {
  const value = { servers: process.env[`${envPrefix}URL`], user: process.env[`${envPrefix}USER`], pass: process.env[`${envPrefix}PASSWORD`], inboxPrefix: process.env[`${envPrefix}INBOX_PREFIX`] };
  ownNats(value, user, inboxPrefix); return value;
}
function ownUrl(value, host, port, path) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Own HTTP URL rejected'); }
  assert.ok(url.protocol === 'http:' && url.hostname === host && url.port === port && url.pathname.startsWith(path) && !url.username && !url.password && !url.search && !url.hash, 'own artifact URL only'); return url;
}
async function jsonBody(response) {
  assert.ok(response.body, 'bounded JSON body required');
  const reader = response.body.getReader(); const bytes = Buffer.alloc(responseBytes); let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      assert.ok(size + next.value.length <= responseBytes, 'response bound'); bytes.set(next.value, size); size += next.value.length;
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
    catch { throw new Error('Invalid bounded fixture JSON'); }
  } finally { await reader.cancel().catch(() => {}); bytes.fill(0); }
}
async function natsJson(nc, subject, value) {
  const bytes = Buffer.from(JSON.stringify(value)); assert.ok(bytes.length <= 65536, 'request bound');
  const reply = await nc.request(subject, bytes, { timeout: callMs });
  assert.ok(reply.data.length <= responseBytes && !reply.headers?.get('Nats-Service-Error'), 'owner RPC success');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.data)); }
  catch { throw new Error('Invalid owner fixture JSON'); }
}
async function freeListener() {
  const server = createServer();
  await bounded(new Promise((resolve, reject) => { server.once('error', () => reject(new Error('Own coordinator listener already occupied'))); server.listen(19682, '127.0.0.1', resolve); }), 2000, 'Listener probe deadline');
  await new Promise((resolve) => server.close(resolve));
}
function fixtureProcess(config) {
  const path = fileURLToPath(new URL('./fixtures/restart-process.mjs', import.meta.url));
  assert.ok(path === `${ownRoot}tests/integration/fixtures/restart-process.mjs`, 'exact own runtime source');
  const child = fork(path, [], { env: {}, execArgv: [], detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const pending = new Map(); let sequence = 0; let exited = false; let outputBytes = 0; let paused = false;
  let birth; let cleanup; let groupFailure = false; let overflow = false;
  const exit = new Promise((resolve) => child.once('exit', () => { exited = true; for (const reject of pending.values()) reject(new Error('Own coordinator exited')); pending.clear(); resolve(); }));
  const identity = async () => {
    assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1, 'created own coordinator PID required');
    const stat = await readFile(`/proc/${child.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    assert.ok(Number(fields[2]) === child.pid && Number(fields[3]) === child.pid && /^\d+$/.test(fields[19]), 'own detached PGID/session/starttime');
    return fields[19];
  };
  // AIDEV-NOTE: Identity фиксируется до start IPC: дочерние программы ещё не созданы.
  const proven = identity().then((value) => { birth = value; });
  proven.catch(() => { groupFailure = true; });
  const ownGroup = async () => {
    await proven;
    assert.ok(!exited && await identity() === birth, 'same live own coordinator identity');
  };
  const killOwnedGroup = async () => {
    await proven;
    // Родитель может уже выйти, оставив детей в той же session; новый процесс с переиспользованным PID не трогаем.
    try { assert.ok(await identity() === birth, 'same own leader birth before group signal'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  };
  const output = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > responseBytes && !overflow) { overflow = true; void killOwnedGroup().catch(() => { groupFailure = true; }); }
  };
  child.stdout.on('data', output); child.stderr.on('data', output);
  child.on('error', () => { for (const reject of pending.values()) reject(new Error('Own coordinator unavailable')); });
  const call = (action, extra = {}, ms = callMs) => {
    const id = ++sequence; let receive;
    return bounded(new Promise((resolve, reject) => {
      receive = (message) => { if (message.id === id) resolve(message); };
      pending.set(id, reject); child.on('message', receive);
      child.send({ id, action, ...extra }, (error) => { if (error) reject(new Error('Own IPC unavailable')); });
    }), ms, 'Own IPC deadline').finally(() => { child.off('message', receive); pending.delete(id); });
  };
  const finishGroup = async () => {
    try { await killOwnedGroup(); }
    finally {
      await bounded(exit, 5000, 'Own group exit deadline');
      await until(async () => {
        try { process.kill(-child.pid, 0); return false; } catch (error) { if (error?.code !== 'ESRCH') throw error; }
        try { await freeListener(); return true; } catch { return false; }
      }, Boolean, 'Own group/listener cleanup deadline', 5000);
    }
    assert.ok(!groupFailure && outputBytes === 0, 'own group cleanup and silent runtime');
  };
  return {
    async start() { await ownGroup(); const reply = await call('start', { config }, phaseMs); assert.ok(reply.okay && reply.address.address === '127.0.0.1' && reply.address.port === 19682, 'real coordinator start'); },
    async ready(historyUnavailable = false) {
      await until(() => call('status'), (reply) => reply.okay && reply.status.localExecutor.configured && reply.status.localExecutor.verified && (historyUnavailable || (reply.status.ready && reply.status.localExecutor.available)), 'Actual ASR runtime readiness deadline');
    },
    async preparePause() { await ownGroup(); },
    // AIDEV-NOTE: Наблюдение owner invoke подтверждает postintent/await, не начало CPU inference; StatusResponse не содержит active job.
    pauseNow() { assert.ok(birth && !exited && !paused, 'proven own pause once'); process.kill(child.pid, 'SIGSTOP'); paused = true; },
    async crash() { try { await ownGroup(); } finally { await finishGroup(); } },
    close() {
      return cleanup ??= (async () => {
        try {
          if (!exited) {
            await ownGroup();
            if (paused) { process.kill(child.pid, 'SIGCONT'); paused = false; }
            try { await call('close', {}, 15000); await bounded(exit, 3000, 'Own close deadline'); } catch { /* Всю свою группу завершаем в finally. */ }
          }
        } finally { await finishGroup(); }
      })();
    },
  };
}
async function spokenFixtures() {
  assert.ok(process.env.TRANSCRIPTION_TEST_ASR_FIXTURE_ROOT === spokenRoot, 'exact published spoken fixture root');
  const root = await lstat(spokenRoot);
  assert.ok(root.isDirectory() && !root.isSymbolicLink() && root.uid === process.getuid() && !(root.mode & 0o222) && await realpath(spokenRoot) === spokenRoot, 'owned readonly fixture directory');
  assert.ok(same((await readdir(spokenRoot)).sort(), ['long-ru.wav', 'manifest.json', 'short-ru.wav']), 'closed fixture directory');
  const read = async (file, limit, size) => {
    const handle = await open(`${spokenRoot}/${file}`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      assert.ok(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o400 && stat.size > 0 && stat.size <= limit && (size === undefined || size === stat.size), 'owned bounded regular readonly fixture');
      const bytes = await handle.readFile(); assert.ok(bytes.length === stat.size, 'stable frozen fixture size'); return bytes;
    } finally { await handle.close(); }
  };
  const bytes = await read('manifest.json', 16384);
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('Invalid closed spoken fixture manifest'); }
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest) && same(Object.keys(manifest).sort(), ['generator', 'long', 'short', 'synthetic', 'version', 'voice']), 'closed manifest fields');
  assert.ok(manifest.version === 1 && manifest.synthetic === true && manifest.generator === 'espeak-ng' && manifest.voice === 'ru', 'published synthetic Russian speech');
  const wave = async (kind) => {
    const item = manifest[kind]; const filename = `${kind}-ru.wav`;
    assert.ok(item && typeof item === 'object' && !Array.isArray(item) && same(Object.keys(item).sort(), ['channels', 'durationMs', 'file', 'sampleFormat', 'sampleRateHz', 'sha256', 'sizeBytes']), 'closed spoken descriptor');
    assert.ok(item.file === filename && typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256) && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 44 && item.sizeBytes <= 6 * 1024 * 1024 && Number.isSafeInteger(item.durationMs) && item.durationMs > 0 && item.durationMs <= (kind === 'short' ? 25000 : 60000) && (kind !== 'long' || item.durationMs > 25000) && Number.isSafeInteger(item.sampleRateHz) && item.sampleRateHz >= 8000 && item.sampleRateHz <= 48000 && item.channels === 1 && item.sampleFormat === 'pcm_s16le', 'bounded spoken properties');
    const audio = await read(filename, 6 * 1024 * 1024, item.sizeBytes);
    assert.ok(createHash('sha256').update(audio).digest('hex') === item.sha256 && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE' && audio.readUInt32LE(4) === audio.length - 8, 'frozen RIFF hash and size');
    let offset = 12; let format; let dataBytes;
    while (offset + 8 <= audio.length) {
      const name = audio.toString('ascii', offset, offset + 4); const size = audio.readUInt32LE(offset + 4); const end = offset + 8 + size;
      assert.ok(end + (size % 2) <= audio.length, 'RIFF chunk bounds');
      if (name === 'fmt ') {
        assert.ok(!format && size >= 16, 'single PCM format chunk');
        format = { encoding: audio.readUInt16LE(offset + 8), channels: audio.readUInt16LE(offset + 10), rate: audio.readUInt32LE(offset + 12), byteRate: audio.readUInt32LE(offset + 16), align: audio.readUInt16LE(offset + 20), bits: audio.readUInt16LE(offset + 22) };
      }
      if (name === 'data') { assert.ok(dataBytes === undefined && size > 0, 'single nonempty PCM data chunk'); dataBytes = size; }
      offset = end + (size % 2);
    }
    assert.ok(offset === audio.length && format?.encoding === 1 && format.channels === 1 && format.rate === item.sampleRateHz && format.byteRate === format.rate * 2 && format.align === 2 && format.bits === 16 && Number.isSafeInteger(dataBytes) && dataBytes % 2 === 0 && Math.round(dataBytes / format.byteRate * 1000) === item.durationMs, 'measured mono PCM16 frames and duration');
    return { bytes: audio, file: filename };
  };
  return { short: await wave('short'), long: await wave('long') };
}
async function historyActor(action) {
  assert.ok(['STOP_OWN_HISTORY', 'START_OWN_HISTORY'].includes(action), 'closed history action');
  assert.ok(process.env.TRANSCRIPTION_TEST_RESTART_HISTORY_CONTROL === actorPath, 'exact reviewed controller required');
  // AIDEV-NOTE: Exit 0 означает проверенные actor-ом own project/service/image и STOPPED/HEALTHY после действия.
  const child = spawn('/usr/bin/sudo', ['-n', '/usr/bin/ansible-playbook', '-i', 'inventory/hosts.yml', actorPath, '-e', `transcription_restart_history_action=${action}`], {
    cwd: '/srv/projects/admin/ansible', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let size = 0;
  child.stdout.on('data', (chunk) => { size += chunk.length; }); child.stderr.on('data', (chunk) => { size += chunk.length; });
  const result = new Promise((resolve, reject) => { child.once('error', () => reject(new Error('Own history actor unavailable'))); child.once('exit', (code) => resolve(code)); });
  try { assert.ok(await bounded(result, 60000, 'Own history actor deadline') === 0 && size <= responseBytes, 'verified own history action'); }
  finally { if (child.exitCode === null && child.signalCode === null && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* own group already gone */ } await bounded(result, 5000, 'Own history actor cleanup'); } }
}

test('guarded actual ASR restart phases and immutable real history delivery', { timeout: 720000 }, async (t) => {
  let phase = 'guards';
  let runtime; let historyMayBeStopped = false; const connections = []; const artifacts = []; let uploader; let pool;
  const close = async () => {
    let failed = false;
    if (historyMayBeStopped) { try { await historyActor('START_OWN_HISTORY'); historyMayBeStopped = false; } catch { failed = true; } }
    try { await runtime?.close(); } catch { failed = true; }
    for (const artifactId of artifacts) {
      try { const input = { requestId: randomUUID(), artifactId }; assert.ok(artifactRequest(artifactSubjects.delete, input)); const reply = await natsJson(uploader, artifactSubjects.delete, input); assert.ok(artifactResponse(artifactSubjects.delete, reply) && reply.status === 'deleted'); } catch { failed = true; }
    }
    for (const nc of connections) { try { await bounded(nc.close(), 5000, 'Own connection close'); } catch { failed = true; } }
    if (pool) { try { await bounded(pool.end(), 5000, 'Own app SQL close'); } catch { failed = true; } }
    assert.ok(!failed, 'own fixture cleanup complete');
  };
  t.after(close);
  try {
    assert.ok(process.env.TRANSCRIPTION_TEST_RESTART_READY === '1', 'root-approved ASR/restart activation required');
    assert.ok(fileURLToPath(new URL('../../', import.meta.url)) === ownRoot, 'exact own runtime worktree');
    const speech = await spokenFixtures();
    const config = loadCoordinatorConfig(process.env); const helper = config.children.helper;
    assert.ok(helper.PGHOST === '127.0.0.1' && helper.PGPORT === '19679' && helper.PGDATABASE === 'brai_transcription_acceptance' && helper.PGUSER === 'transcription_app', 'own APP database required');
    assert.ok(config.http.host === '127.0.0.1' && config.http.port === 19682 && config.http.allowedHosts.includes('127.0.0.1:19682'), 'own coordinator listener');
    ownNats(config.nats, 'transcription', '_INBOX.brai_transcription');
    assert.ok(config.localAi, 'dedicated own local AI client required');
    ownNats(config.localAi, 'transcription_local_ai', '_INBOX.brai_transcription_local');
    assert.ok(config.domain.resultTtlMs >= 180000 && config.domain.resultTtlMs <= 600000 && config.domain.maxExecuteConcurrency === 1 && Number(helper.TRANSCRIPTION_REQUEST_LEASE_MS) <= 30000, 'finite capture/lease/TTL limits required');
    assert.ok(config.bindings.every((entry) => entry.principal.scopeType === 'user' && entry.principal.scopeId.startsWith(prefix) && entry.principal.ownerId.startsWith(prefix)), 'synthetic own principals');
    const binding = config.bindings.find((entry) => entry.principal.permissions.includes('transcription:use'));
    assert.ok(binding, 'own use principal'); const principal = binding.principal;
    let model;
    try { model = JSON.parse(process.env.TRANSCRIPTION_TEST_RESTART_MODEL_JSON); } catch { throw new Error('Pinned ASR model selector required'); }
    assert.ok(validateDto('ModelSelector', model), 'exact closed pinned model selector');
    const observerSettings = clientSettings('TRANSCRIPTION_TEST_RESTART_OBSERVER_NATS_', 'transcription_restart_observer', '_INBOX.brai_transcription_restart_observer');
    const uploaderSettings = clientSettings('TRANSCRIPTION_TEST_ARTIFACT_NATS_', 'test_uploader', '_INBOX.brai_artifacts_test');
    const historySettings = clientSettings('TRANSCRIPTION_TEST_HISTORY_NATS_', 'history_reader', '_INBOX.brai_history_test');
    assert.ok(process.env.TRANSCRIPTION_TEST_RESTART_HISTORY_CONTROL === actorPath, 'reviewed history controller gate');
    const open = async (settings) => { const nc = await connect({ ...settings, reconnect: false, timeout: 5000 }); connections.push(nc); return nc; };
    uploader = await open(uploaderSettings); const historyReader = await open(historySettings); const observer = await open(observerSettings);
    const seen = new Map(); let observerFault = false; let armed;
    observer.subscribe(localSubjects.invokeTranscribe, { callback(error, message) {
      try {
        assert.ok(!error && message.data.length <= 65536, 'bounded actual invoke metadata');
        const command = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message.data));
        assert.ok(localRequest(localSubjects.invokeTranscribe, command) && command.requestId === command.operationId && same(command.model, model), 'owner invocation identity and pinned selector');
        assert.ok(command.ownerId === principal.ownerId && artifacts.includes(command.audioArtifactId), 'only own observed invocation');
        assert.ok(seen.size < 32 || seen.has(command.operationId), 'bounded invoke observer');
        const prior = seen.get(command.operationId); seen.set(command.operationId, { count: (prior?.count ?? 0) + 1, artifactId: command.audioArtifactId });
        if (armed?.artifactId === command.audioArtifactId) { armed.runtime.pauseNow(); armed = undefined; }
      } catch { observerFault = true; }
    } });
    await observer.flush();
    const count = (artifactId) => [...seen.values()].filter((item) => item.artifactId === artifactId).reduce((sum, item) => sum + item.count, 0);
    const ensureObserver = () => assert.ok(!observerFault, 'own metadata observer valid');
    pool = new pg.Pool({ host: helper.PGHOST, port: Number(helper.PGPORT), database: helper.PGDATABASE, user: helper.PGUSER, password: helper.PGPASSWORD, max: 1, connectionTimeoutMillis: 3000, query_timeout: 3000, statement_timeout: 2000, idle_in_transaction_session_timeout: 3000 });
    pool.on('error', () => { observerFault = true; });
    const readOnly = async (read) => { const client = await pool.connect(); try { await client.query('BEGIN READ ONLY'); await client.query("SET LOCAL statement_timeout='2000ms'"); const value = await read(client); await client.query('COMMIT'); return value; } catch { await client.query('ROLLBACK').catch(() => {}); throw new Error('Own read-only metadata query failed'); } finally { client.release(); } };
    const baseline = await readOnly(async (client) => (await client.query("SELECT (SELECT count(*)::integer FROM transcription.requests WHERE task_state IN ('accepted','dispatching','running')) AS active,(SELECT count(*)::integer FROM transcription.history_outbox WHERE state<>'acknowledged') AS backlog")).rows[0]);
    assert.ok(baseline.active === 0 && baseline.backlog === 0, 'exclusive fixture with healthy empty active/backlog required');
    const summary = async (requestId) => readOnly(async (client) => {
      const rows = (await client.query('SELECT metadata FROM transcription.requests WHERE request_id=$1 AND scope_type=$2 AND scope_id=$3 AND owner_id=$4', [requestId, principal.scopeType, principal.scopeId, principal.ownerId])).rows;
      assert.ok(rows.length === 1 && validateDto('RequestRecord', rows[0].metadata), 'scoped closed durable record');
      const attempts = (await client.query('SELECT metadata FROM transcription.attempts WHERE request_id=$1 ORDER BY attempt_id LIMIT 3', [requestId])).rows.map((row) => row.metadata);
      assert.ok(attempts.length <= 1 && attempts.every((item) => validateDto('AttemptRecord', item)), 'exactly one closed attempt maximum');
      const outbox = (await client.query('SELECT delivery_id,state,event FROM transcription.history_outbox WHERE request_id=$1 ORDER BY delivery_id LIMIT 3', [requestId])).rows;
      assert.ok(outbox.length === 2 && outbox.every((item) => item.event === null || validateDto('HistoryAppendRequest', item.event)), 'accepted and reserved/terminal closed history');
      return { request: rows[0].metadata, attempts, outbox };
    });
    const api = async (method, params, signal) => {
      assert.ok(validateDto(methodMap.public[method][0], params), 'public input owner schema');
      const response = await fetch(`http://127.0.0.1:19682/v1/transcription/${method}`, { method: 'POST', headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' }, body: JSON.stringify(params), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(callMs)]) : AbortSignal.timeout(callMs) });
      assert.ok(response.status === 200 && response.headers.get('cache-control') === 'no-store', 'public successful metadata response');
      const value = await jsonBody(response); assert.ok(validateDto(methodMap.public[method][1], value), 'public output owner schema'); return value;
    };
    const freshConfig = (slow = false) => { const next = structuredClone(config); const id = `${prefix}${randomUUID()}`; next.domain.instanceId = id; next.recovery.instanceId = id; next.domain.workerId = id; next.recovery.workerId = id; if (slow) next.recovery.pumpPollIntervalMs = 60000; return next; };
    const start = async (slow = false) => { await freeListener(); runtime = fixtureProcess(freshConfig(slow)); await runtime.start(); await runtime.ready(historyMayBeStopped); const catalog = await api('models.list', {}); assert.ok(catalog.localCatalogState === 'available' && catalog.localItems.some((item) => same(item.selector, model) && item.supported && item.installed && item.ready), 'real ready canonical ASR catalog'); };
    const artifact = async (kind) => {
      assert.ok(['short', 'long'].includes(kind), 'closed spoken fixture kind'); const fixture = speech[kind];
      const input = { requestId: randomUUID(), ownerId: principal.ownerId, kind: 'original', metadata: { title: 'Synthetic Russian restart acceptance', filename: fixture.file, extension: 'wav', mimeType: 'audio/wav', source: 'transcription_acceptance' } };
      assert.ok(artifactRequest(artifactSubjects.prepare, input)); const reply = await natsJson(uploader, artifactSubjects.prepare, input);
      assert.ok(artifactResponse(artifactSubjects.prepare, reply) && reply.artifact.ownerId === principal.ownerId && reply.artifact.requestId === input.requestId, 'real correlated own artifact');
      const id = reply.artifact.artifactId; artifacts.push(id); const bytes = fixture.bytes;
      const response = await fetch(ownUrl(reply.uploadUrl, '172.31.246.1', '19681', '/upload/'), { method: 'PUT', body: bytes, headers: { 'content-type': 'audio/wav' }, redirect: 'error', signal: AbortSignal.timeout(callMs) });
      assert.ok(response.status === 201 && response.headers.get('x-artifact-id') === id && response.headers.get('x-artifact-state') === 'ready' && Number(response.headers.get('x-artifact-size')) === bytes.length, 'real frozen synthetic Russian PCM ready'); ownUrl(response.headers.get('location'), '172.31.246.1', '19684', '/files/'); await response.body?.cancel(); return id;
    };
    const input = (artifactId) => ({ clientIdempotencyKey: randomUUID(), audioArtifactId: artifactId, requestedModel: { route: 'local', selection: 'required', modelId: model.modelId }, deadlineAt: null });
    const done = async (requestId) => until(() => summary(requestId), (value) => {
      if (['failed', 'outcome_unknown', 'cancelled'].includes(value.request.taskState)) throw new Error('Real request reached unsuccessful terminal state');
      if (value.request.taskState !== 'succeeded') return false;
      assert.ok(value.request.resultState === 'available' && same(value.request.selectedModel, model) && same(value.request.actualModel, model), 'strict computed available result with pinned selected/actual selector');
      return true;
    }, 'Actual computed phase not captured');
    const durableIdentity = (value) => hash({ requestId: value.requestId, input: value.normalizedInputSha256, selected: value.selectedModel, policy: value.policySnapshot, requested: value.requestedModel, inputMetadata: value.inputMetadata });
    const repeat = async (params, captured) => { const reply = await api('request.submit', params); assert.ok(reply.request.requestId === captured.request.requestId, 'same client key old request'); const now = await summary(reply.request.requestId); assert.ok(durableIdentity(now.request) === durableIdentity(captured.request), 'immutable admitted identity and snapshot'); return now; };
    const assertOne = async (artifactId, requestId) => { await observer.flush(); ensureObserver(); const value = await summary(requestId); assert.ok(count(artifactId) === 1 && value.attempts.length === 1 && seen.get(value.request.currentAttemptId)?.count === 1, 'one actual invocation and one durable attempt'); return value; };
    const unchangedCompute = async (artifactId, before) => { const current = await repeat(before.input, before.value); await pause(300); await observer.flush(); ensureObserver(); assert.ok(count(artifactId) === before.count && same(current.attempts.map((item) => item.attemptId), before.value.attempts.map((item) => item.attemptId)), 'no implicit replacement or invoke'); return current; };

    const runPhase = async (name, body) => {
      let failed = false;
      await t.test(name, async () => { try { await body(); } catch { failed = true; throw new Error(`Guarded restart subcase failed in ${phase}; payload suppressed`); } });
      assert.ok(!failed, 'phase capture failed; no further compute authorized by this test');
    };
    phase = 'spoken-baseline'; await runPhase('real short Russian speech yields a nonempty volatile result', async () => {
      await start(); const id = await artifact('short'); const params = input(id); const accepted = await api('request.submit', params);
      const captured = await done(accepted.request.requestId); await assertOne(id, captured.request.requestId);
      const result = await api('result.get', { requestId: captured.request.requestId });
      assert.ok(result.state === 'available' && result.result.requestId === captured.request.requestId && same(result.result.actualModel, model) && typeof result.result.text === 'string' && result.result.text.trim().length > 0, 'actual spoken ASR nonempty result; content remains volatile');
      await runtime.close();
    });
    phase = 'queued'; await runPhase('accepted before dispatch continues with its first invocation once', async () => {
      await start(true); const id = await artifact('short'); const params = input(id); await runtime.preparePause();
      const accepted = await api('request.submit', params); runtime.pauseNow(); const captured = await summary(accepted.request.requestId); await observer.flush(); ensureObserver();
      assert.ok(captured.request.taskState === 'accepted' && captured.request.currentAttemptId === null && captured.attempts.length === 0 && count(id) === 0, 'preintent phase captured or fail without repeat');
      await runtime.crash(); await start(); await repeat(params, captured); await done(captured.request.requestId); await assertOne(id, captured.request.requestId); await runtime.close();
    });
    phase = 'inflight'; await runPhase('postintent owner invocation/await becomes unknown without another attempt', async () => {
      await start(); const id = await artifact('long'); const params = input(id); await runtime.preparePause(); armed = { artifactId: id, runtime };
      // AIDEV-NOTE: SIGSTOP может опередить HTTP reply уже принятого submit; read-only client key подтверждает durable admission.
      const submitAbort = new AbortController();
      const submitted = api('request.submit', params, submitAbort.signal).then((value) => value, () => null);
      let requestId;
      try {
        await until(async () => { ensureObserver(); return armed === undefined; }, Boolean, 'Actual invocation phase not observed');
        requestId = await readOnly(async (client) => {
          const rows = (await client.query('SELECT request_id FROM transcription.requests WHERE client_key=$1 AND scope_type=$2 AND scope_id=$3 AND owner_id=$4', [params.clientIdempotencyKey, principal.scopeType, principal.scopeId, principal.ownerId])).rows;
          assert.ok(rows.length === 1 && validateDto('Uuid', rows[0].request_id), 'scoped durable admission after actual public submit'); return rows[0].request_id;
        });
      } finally { submitAbort.abort(); }
      const reply = await submitted;
      assert.ok(reply === null || reply.request.requestId === requestId, 'public reply, when received, has durable identity');
      const captured = await summary(requestId); await observer.flush(); ensureObserver();
      assert.ok(['dispatching', 'running'].includes(captured.request.taskState) && captured.request.currentAttemptId !== null && captured.attempts.length === 1 && count(id) === 1, 'postintent owner command/await captured; CPU inference not asserted');
      await runtime.crash(); await start(); const recovered = await until(() => summary(captured.request.requestId), (value) => value.request.taskState === 'outcome_unknown', 'Expired lease recovery missing');
      assert.ok(recovered.request.resultState === 'not_ready', 'unknown compute has no invented result'); await unchangedCompute(id, { input: params, value: captured, count: 1 }); await runtime.close();
    });
    const computed = async (delivery) => {
      await start(); const id = await artifact('short'); const params = input(id); const accepted = await api('request.submit', params); const captured = await done(accepted.request.requestId); await assertOne(id, captured.request.requestId);
      assert.ok(same(captured.request.actualModel, model) && captured.attempts[0].durationMs !== null && captured.request.usage === null && captured.request.cost === null, 'actual local model and processing duration; unknown usage/cost null');
      const beforeMetrics = hash({ actual: captured.request.actualModel, usage: captured.request.usage, cost: captured.request.cost, attempt: captured.attempts[0] });
      if (delivery) {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), callMs);
        try {
          const response = await fetch('http://127.0.0.1:19682/v1/transcription/result.get', { method: 'POST', headers: { authorization: `Bearer ${binding.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: captured.request.requestId }), redirect: 'error', signal: controller.signal });
          assert.ok(response.status === 200 && response.headers.get('cache-control') === 'no-store', 'result headers received'); controller.abort(); await response.body?.cancel().catch(() => {});
        } finally { clearTimeout(timer); controller.abort(); }
        const marked = await summary(captured.request.requestId); assert.ok(marked.request.resultState === 'delivery_unknown', 'CAS delivery boundary; no packet receipt assertion');
      }
      await runtime.crash(); await start(); const lost = await summary(captured.request.requestId);
      assert.ok(lost.request.taskState === 'succeeded' && lost.request.resultState === 'lost' && hash({ actual: lost.request.actualModel, usage: lost.request.usage, cost: lost.request.cost, attempt: lost.attempts[0] }) === beforeMetrics, 'fresh instance loses volatile result and preserves actual computation metadata');
      const result = await api('result.get', { requestId: captured.request.requestId }); assert.ok(result.state === 'lost' && result.errorCode === 'RESULT_UNAVAILABLE', 'explicit lost result');
      await unchangedCompute(id, { input: params, value: captured, count: 1 }); await runtime.close();
    };
    phase = 'computed'; await runPhase('computed available buffer is lost after fresh-instance restart', () => computed(false));
    phase = 'delivery'; await runPhase('delivery_unknown CAS survives aborted HTTP then becomes lost', () => computed(true));
    phase = 'history'; await runPhase('own history outage keeps stable event identity and resumes actual delivery', async () => {
      await start(); historyMayBeStopped = true; await historyActor('STOP_OWN_HISTORY'); const id = await artifact('short'); const params = input(id); const accepted = await api('request.submit', params); const captured = await done(accepted.request.requestId); await assertOne(id, captured.request.requestId);
      assert.ok(captured.outbox.every((row) => row.event !== null && ['pending', 'claimed'].includes(row.state)), 'real admitted and terminal events retained while own history unavailable');
      const stable = captured.outbox.map((row) => ({ id: row.delivery_id, event: row.event, fingerprint: hash(row.event) }));
      await runtime.crash(); await start(); await unchangedCompute(id, { input: params, value: captured, count: 1 });
      const afterRestart = await summary(captured.request.requestId); assert.ok(afterRestart.outbox.every((row) => stable.some((old) => old.id === row.delivery_id && old.fingerprint === hash(row.event))), 'immutable events through coordinator restart');
      await historyActor('START_OWN_HISTORY'); historyMayBeStopped = false;
      await until(() => summary(captured.request.requestId), (value) => value.outbox.every((row) => row.state === 'acknowledged'), 'Actual history delivery did not resume');
      const ajv = new Ajv({ strict: false }); addFormats(ajv); ajv.addSchema(historyCommon); ajv.addSchema(historyMessages); const valid = ajv.getSchema(`${historyMessages.$id}#/definitions/getResponse`);
      for (const entry of stable) {
        const reply = await natsJson(historyReader, 'brai.history.v1.query.get', { user_id: principal.scopeId, source: 'transcription', id: entry.id });
        assert.ok(valid(reply) && reply.event.source === 'transcription' && reply.event.id === entry.id && Object.entries(entry.event).every(([key, value]) => same(reply.event[key], value)), 'real immutable source/id/event delivered exactly');
      }
      await unchangedCompute(id, { input: params, value: captured, count: 1 });
      // Новое явное client key разрешает новую работу; recovery/delivery никогда не создают её сами.
      const explicit = { ...params, clientIdempotencyKey: randomUUID() }; const added = await api('request.submit', explicit);
      assert.ok(added.request.requestId !== captured.request.requestId, 'explicit new request'); await done(added.request.requestId); await observer.flush(); ensureObserver();
      const addedMetadata = await summary(added.request.requestId); assert.ok(count(id) === 2 && addedMetadata.attempts.length === 1 && addedMetadata.request.currentAttemptId !== captured.request.currentAttemptId, 'one new invocation solely for explicit new key'); await runtime.close();
    });
    ensureObserver();
  } catch { throw new Error(`Guarded restart fixture failed in ${phase}; payload and credentials suppressed`); }
});
