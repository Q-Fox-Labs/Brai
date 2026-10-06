// ABOUTME: Проверяет shutdown coordinator и owner lifecycle одного собственного синтетического артефакта.
// ABOUTME: Не создаёт transcription requests, не вызывает модель и выводит только закрытые признаки cleanup.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { connect } from 'nats';
import pg from 'pg';
import { startCoordinator } from '../../dist/coordinator/main.js';
import { loadCoordinatorConfig } from '../../dist/coordinator/config.js';
import { subjects, validateRequest, validateResponse } from '../../../artifacts/contracts/index.mjs';
import { subjects as localAiSubjects } from '../../../local-ai/contracts/index.mjs';

const operationMs = 5000;
async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture operation deadline')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function ownNats(settings, user, inboxPrefix) {
  const url = new URL(settings.servers);
  assert.ok(url.protocol === 'nats:' && url.hostname === '127.0.0.1' && url.port === '19680' &&
    !url.username && !url.password && !url.search && !url.hash && (!url.pathname || url.pathname === '/'), 'own isolated NATS only');
  assert.ok(settings.user === user && settings.inboxPrefix === inboxPrefix && typeof settings.pass === 'string' && settings.pass.length > 0 && !settings.token,
    'explicit own NATS principal required');
  return settings;
}
function envNats(prefix, user, inboxPrefix) {
  return ownNats({ servers: process.env[`${prefix}URL`], user: process.env[`${prefix}USER`], pass: process.env[`${prefix}PASSWORD`],
    token: process.env[`${prefix}TOKEN`], inboxPrefix: process.env[`${prefix}INBOX_PREFIX`] }, user, inboxPrefix);
}
async function request(nc, subject, input) {
  assert.ok(validateRequest(subject, input), 'published artifact request');
  const data = Buffer.from(JSON.stringify(input));
  assert.ok(data.length <= 4096, 'bounded own metadata request');
  const reply = await nc.request(subject, data, { timeout: operationMs });
  assert.ok(reply.data.length <= 65536, 'bounded artifact reply');
  return reply;
}
function success(subject, reply) {
  assert.ok(!reply.headers?.get('Nats-Service-Error'), 'artifact owner success');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reply.data));
  assert.ok(validateResponse(subject, value), 'published artifact response');
  return value;
}
function tinyWave() {
  const wav = Buffer.alloc(46);
  wav.write('RIFF', 0); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(2, 40);
  return wav;
}

test('guarded cleanup-only: pending conflict, ready upload, deletion and actual coordinator shutdown', { timeout: 90000 }, async t => {
  assert.equal(process.env.TRANSCRIPTION_TEST_CLEANUP_ONLY, '1', 'explicit own-fixture activation required');
  assert.ok(process.getuid() === 1002 && process.getgid() === 1002, 'fixture runs as own agent');
  const config = loadCoordinatorConfig({ ...process.env, TRANSCRIPTION_INSTANCE_ID: randomUUID() });
  ownNats(config.nats, 'transcription', '_INBOX.brai_transcription');
  assert.ok(config.localAi, 'own local-ai caller configuration required');
  ownNats(config.localAi, 'transcription_local_ai', '_INBOX.brai_transcription_local');
  assert.ok(config.http.host === '127.0.0.1' && config.http.port === 19682 && config.http.allowedHosts.includes('127.0.0.1:19682'), 'own coordinator listener only');
  assert.ok(config.children.helper.PGHOST === '127.0.0.1' && config.children.helper.PGPORT === '19679' &&
    config.children.helper.PGDATABASE === 'brai_transcription_acceptance' && config.children.helper.PGUSER === 'transcription_app', 'own APP database only');
  assert.ok(config.bindings.every(binding => binding.principal.scopeType === 'user' && binding.principal.ownerId.startsWith('transcription-acceptance-') &&
    binding.principal.scopeId.startsWith('transcription-acceptance-')), 'synthetic fixture identities only');
  const writer = config.bindings.find(binding => binding.principal.permissions.includes('transcription:use') && binding.principal.permissions.includes('transcription:settings:write'));
  assert.ok(writer, 'trusted own fixture principal required');
  const uploaderSettings = envNats('TRANSCRIPTION_TEST_ARTIFACT_NATS_', 'test_uploader', '_INBOX.brai_artifacts_test');
  const observerSettings = envNats('TRANSCRIPTION_TEST_LOCAL_AI_TAP_NATS_', 'transcription_restart_observer', '_INBOX.brai_transcription_restart_observer');
  const connections = [];
  let runtime;
  let uploader;
  let storage;
  let storageConnected = false;
  let readOnly = false;
  let artifactId;
  let completeUpload;
  let uploadCompleted = false;
  let artifactDeleted = false;
  let bodyCompleted = false;
  let invocations = 0;
  const open = async settings => {
    const nc = await connect({ ...settings, timeout: operationMs, reconnect: false });
    connections.push(nc);
    return nc;
  };
  t.after(async () => {
    const failures = new Set();
    try {
      try { await bounded(runtime?.close() ?? Promise.resolve(), 15000); assert.ok(invocations === 0, 'no model invocation during coordinator lifetime'); }
      catch { failures.add('COORDINATOR'); }
      if (artifactId && !artifactDeleted) {
        try {
          if (!uploadCompleted) await completeUpload();
          const deleted = success(subjects.delete, await request(uploader, subjects.delete, { requestId: randomUUID(), artifactId }));
          assert.ok(deleted.artifactId === artifactId && deleted.ownerId === writer.principal.ownerId && deleted.status === 'deleted', 'own fixture deleted');
          artifactDeleted = true;
        } catch { failures.add('ARTIFACT_DELETE'); }
      }
    } finally {
      try { if (storageConnected && readOnly) await storage.query('ROLLBACK'); }
      catch { failures.add('POSTGRES'); }
      try { if (storage) await bounded(storage.end(), operationMs); }
      catch { failures.add('POSTGRES'); }
      try {
        const stopped = await Promise.allSettled(connections.map(nc => bounded(nc.close(), operationMs)));
        if (stopped.some(result => result.status === 'rejected')) failures.add('NATS');
      } catch { failures.add('NATS'); }
    }
    process.stdout.write(`CLEANUP_FIXTURE bodyCompleted=${bodyCompleted} cleanup=${[...failures].join(',') || 'NONE'}\n`);
    assert.ok(failures.size === 0, 'own coordinator, artifact, database and NATS cleanup completed');
  });

  storage = new pg.Client({ host: config.children.helper.PGHOST, port: Number(config.children.helper.PGPORT), database: config.children.helper.PGDATABASE,
    user: config.children.helper.PGUSER, password: config.children.helper.PGPASSWORD, connectionTimeoutMillis: operationMs,
    statement_timeout: operationMs, query_timeout: operationMs, application_name: 'transcription-cleanup-only-readonly' });
  await storage.connect(); storageConnected = true;
  await storage.query('BEGIN READ ONLY'); readOnly = true;
  const nonterminal = await storage.query("SELECT count(*)::integer AS count FROM transcription.requests WHERE COALESCE(metadata->>'taskState','') NOT IN ('succeeded','failed','outcome_unknown','cancelled')");
  assert.ok(nonterminal.rows[0].count === 0, 'no durable task can dispatch during this cleanup-only fixture');
  const before = await storage.query('SELECT (SELECT count(*)::integer FROM transcription.requests) AS requests, (SELECT count(*)::integer FROM transcription.attempts) AS attempts');
  uploader = await open(uploaderSettings);
  const observer = await open(observerSettings);
  observer.subscribe(localAiSubjects.invokeTranscribe, { callback: () => { invocations += 1; } });
  await bounded(observer.flush(), operationMs);
  runtime = await startCoordinator(config);
  assert.ok((await runtime.status()).metadataReady, 'real coordinator metadata readiness');

  const prepareId = randomUUID();
  const prepared = success(subjects.prepare, await request(uploader, subjects.prepare, { requestId: prepareId, ownerId: writer.principal.ownerId, kind: 'original',
    metadata: { title: 'Cleanup-only fixture', filename: 'cleanup-only.wav', extension: 'wav', mimeType: 'audio/wav', source: 'transcription_cleanup_acceptance' } }));
  assert.ok(prepared.artifact.ownerId === writer.principal.ownerId && prepared.artifact.requestId === prepareId && prepared.artifact.status === 'pending', 'new own pending artifact');
  artifactId = prepared.artifact.artifactId;
  const upload = new URL(prepared.uploadUrl);
  assert.ok(upload.protocol === 'http:' && upload.hostname === '172.31.246.1' && upload.port === '19681' && upload.pathname.startsWith('/upload/') &&
    !upload.username && !upload.password && !upload.search && !upload.hash, 'own artifact upload endpoint only');
  const bytes = tinyWave();
  completeUpload = async () => {
    const response = await fetch(upload, { method: 'PUT', body: bytes, headers: { 'content-type': 'audio/wav' }, signal: AbortSignal.timeout(operationMs), redirect: 'error' });
    try {
      assert.ok(response.status === 201 && response.headers.get('x-artifact-id') === artifactId && response.headers.get('x-artifact-state') === 'ready' &&
        Number(response.headers.get('x-artifact-size')) === bytes.length, 'tiny own upload reaches ready');
      uploadCompleted = true;
    } finally { await response.body?.cancel(); }
  };
  const pendingDelete = await request(uploader, subjects.delete, { requestId: randomUUID(), artifactId });
  assert.ok(pendingDelete.headers?.get('Nats-Service-Error') === 'CONFLICT' && pendingDelete.headers?.get('Nats-Service-Error-Code') === '409',
    'owner refuses deletion of a pending artifact');
  await completeUpload();
  const deleted = success(subjects.delete, await request(uploader, subjects.delete, { requestId: randomUUID(), artifactId }));
  assert.ok(deleted.artifactId === artifactId && deleted.ownerId === writer.principal.ownerId && deleted.status === 'deleted', 'owner confirms ready artifact deletion');
  artifactDeleted = true;
  await bounded(observer.flush(), operationMs);
  const after = await storage.query('SELECT (SELECT count(*)::integer FROM transcription.requests) AS requests, (SELECT count(*)::integer FROM transcription.attempts) AS attempts');
  assert.ok(before.rows[0].requests === after.rows[0].requests && before.rows[0].attempts === after.rows[0].attempts && invocations === 0,
    'cleanup-only fixture creates no transcription request, attempt or model invocation');
  bodyCompleted = true;
});
