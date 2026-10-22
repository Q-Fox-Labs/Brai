// ABOUTME: Измеряет только ingress/egress Local AI между service endpoint и actual engine handoff.
// ABOUTME: Model wait исключён; сохраняет лишь forwarding ms, outcomes и неизменяемую identity.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { channel } from 'node:diagnostics_channel';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const app = input.appRoot;
const require = createRequire(join(app, 'package.json'));
const pg = require('pg');
const { connect } = require('nats');
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
const originalParse = JSON.parse;
const scope = new AsyncLocalStorage();
const pendingRpc = new Map();
const spans = [];
const now = () => performance.now();
const rounded = value => Math.round(value * 1000) / 1000;
const safeCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(error.code) ? error.code : 'FORWARDING_FAILED';
const json = value => Buffer.from(JSON.stringify(value));
const config = input.config;
const ownerId = randomUUID();
const deadline = () => new Date(Date.now() + config.transport.maxRequestMs - 1000).toISOString();
let client, peers, local, server;
const fixtureDirectories = [];
let stage = 'initialize';
let activeProfileId = null;
const errorMetadata = error => ({ code: safeCode(error), origin: ['nats-client','service'].includes(error?.origin) ? error.origin : 'harness', errorStatus: Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null });
const expectedOperations = ['embed','transcribe'];
const report = { formatVersion: 2, measurement: 'microservice-forwarding-only', status: 'running', identity: input.identity, samples: [], errors: [], expectedOperations, expectedSamples: expectedOperations.length * 5,
  acceptance: { limitMs: 50, criterion: 'each-operation-empirical-p95-max-at-n5', populationGuarantee: false },
  methodology: { ingress: 'endpoint-entry-to-engine-handoff-minus-tokenize-model-wait', egress: 'engine-raw-response-to-message-respond-completion',
    replyCompletion: 'local-NATS-publish-return-not-consumer-receipt', embeddingNativeBoundary: 'undici-request-bodySent-to-request-trailers', asrNativeBoundary: 'stdin-write-to-last-raw-stdout-chunk-before-matching-parse', modelWaitMeasuredAsPerformance: false,
    loading: 'prerequisite-not-measured', shortRequestsPerOperation: 5, percentile: 'nearest-rank-exploratory-max-at-n5',
    excludesBrokerLatencyOutsideService: true, peers: 'fixture-artifacts-http-nats-and-history-nats', productionPeerLatencyIncluded: false,
    deadlineGuardMs: 1000, configRequestLimitMs: config.transport.maxRequestMs } };
const save = () => writeFile(input.output, JSON.stringify(report, null, 2) + '\n', { flush: true });

// AIDEV-NOTE: Raw timestamp chunk берём до framing/parse; ID сверяем тем же original parse.
JSON.parse = function (...args) {
  const value = originalParse.apply(this, args);
  if (value?.jsonrpc === '2.0' && typeof value.id === 'string') {
    const pending = pendingRpc.get(value.id);
    if (pending) { pending.span.t2 = pending.rawTimestamp(); pending.span.responses++; pendingRpc.delete(value.id); }
  }
  return value;
};
childProcess.spawn = function (executable, args, options) {
  const child = originalSpawn(executable, args, options);
  if (executable.includes('/.venv/bin/python')) {
    let rawChunkAt;
    // AIDEV-NOTE: Listener регистрируется до adapter: framing/decode/parse входят в egress.
    child.stdout.on('data', () => { rawChunkAt = now(); });
    const originalWrite = child.stdin.write;
    child.stdin.write = function (...args) {
      const span = scope.getStore();
      let tracked = false;
      if (span) {
        let request; try { request = originalParse(args[0].toString()); } catch {}
        if (request?.method === 'transcribe' && typeof request.id === 'string') {
          tracked = true; pendingRpc.set(request.id, { span, rawTimestamp: () => rawChunkAt });
        }
      }
      const result = originalWrite.apply(this, args);
      if (tracked) { span.t1 = now(); span.handoffs++; }
      return result;
    };
  }
  return child;
};
syncBuiltinESMExports();
const load = relative => import(pathToFileURL(join(app, relative)).href);
const { startLocalAi, supportedProfiles } = await load('src/main.mjs');
const { startLocalAiNats } = await load('dist/transport/index.js');
const { validateError } = await load('contracts/index.mjs');

// AIDEV-NOTE: Built-in undici channels доступны в current Node v24.22.1 runtime.
// Request WeakMap хранит только correlation metadata; payload не читается/не сохраняется.
const nativeRequests = new WeakMap();
const diagnosticHooks = [
  ['undici:request:create', ({ request }) => {
    const span = scope.getStore();
    if (!span || span.operation !== 'embed' || String(request.origin) !== `http://${config.runtime.llama_cpp.host}:${config.runtime.llama_cpp.port}` || !['/tokenize','/v1/embeddings'].includes(request.path)) return;
    const kind = request.path === '/tokenize' ? 'tokenize' : 'useful';
    if (kind === 'tokenize') span.tokenCreates++;
    nativeRequests.set(request, { span, kind });
  }],
  ['undici:request:bodySent', ({ request }) => {
    const native = nativeRequests.get(request); if (!native) return;
    native.sentAt = now();
    if (native.kind === 'tokenize') native.span.tokenSends++;
    else { native.span.t1 = native.sentAt; native.span.handoffs++; }
  }],
  ['undici:request:trailers', ({ request }) => {
    const native = nativeRequests.get(request); if (!native) return;
    const receivedAt = now();
    if (native.kind === 'tokenize') { native.span.excludedTokenWaitMs += receivedAt-native.sentAt; native.span.tokenResponses++; }
    else { native.span.t2 = receivedAt; native.span.responses++; }
    nativeRequests.delete(request);
  }],
];
for (const [name, listener] of diagnosticHooks) channel(name).subscribe(listener);

/** Захватить реальный endpoint entry до parse/admission; respond измерять после original publish. */
function forwardingConnection(nc) {
  const services = new Proxy(nc.services, { get(target, key) {
    if (key === 'add') return async (...args) => {
      const service = await target.add(...args);
      const originalEndpoint = service.addEndpoint.bind(service);
      service.addEndpoint = (name, options) => {
        if (!['brai.local_ai.v1.invoke.embed', 'brai.local_ai.v1.invoke.transcribe'].includes(options.subject)) return originalEndpoint(name, options);
        const originalHandler = options.handler;
        return originalEndpoint(name, { ...options, handler(error, message) {
          const span = { t0: now(), operation: options.subject.endsWith('.embed') ? 'embed' : 'transcribe', handoffs: 0, responses: 0, replies: 0, excludedTokenWaitMs: 0, tokenCreates: 0, tokenSends: 0, tokenResponses: 0 };
          spans.push(span);
          const wrappedMessage = new Proxy(message, { get(target, key) {
            if (key === 'respond' || key === 'respondError') return (...args) => {
              const result = target[key](...args);
              span.t3 = now(); span.replies++; span.errorReply = key === 'respondError';
              return result;
            };
            const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
          } });
          return scope.run(span, () => originalHandler(error, wrappedMessage));
        } });
      };
      return service;
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return new Proxy(nc, { get(target, key) {
    if (key === 'services') return services;
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

async function request(subject, body) {
  let message;
  try { message = await client.request('brai.local_ai.v1.' + subject, json(body), { timeout: config.transport.maxRequestMs }); }
  catch (error) {
    throw Object.assign(new Error(), { code: error?.code === '503' ? 'NO_RESPONDERS' : safeCode(error), origin: 'nats-client', status: typeof error?.code === 'string' && /^[0-9]{3}$/.test(error.code) ? Number(error.code) : null });
  }
  const statusHeader = message.headers?.get('Nats-Service-Error-Code');
  if (statusHeader) {
    let errorBody; try { errorBody = originalParse(Buffer.from(message.data).toString()); } catch {}
    const code = validateError(errorBody) ? safeCode(errorBody) : 'SERVICE_ERROR_BODY_UNAVAILABLE';
    throw Object.assign(new Error(), { code, origin: 'service', status: /^[0-9]{3}$/.test(statusHeader) ? Number(statusHeader) : null });
  }
  return JSON.parse(Buffer.from(message.data).toString());
}
function stats(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return { n: sorted.length, p50Ms: sorted.length ? rounded(sorted[Math.ceil(sorted.length * .5)-1]) : null,
    p95Ms: sorted.length ? rounded(sorted[Math.ceil(sorted.length * .95)-1]) : null };
}

/** Не допустить passed при потерянных/невалидных/ошибочных фазовых samples. */
function forwardingComplete(report) {
  return report.errors.length === 0 && report.samples.length === report.expectedSamples
    && report.expectedOperations.every(operation => {
      const rows = report.samples.filter(row => row.operation === operation);
      return rows.length === 5 && new Set(rows.map(row => row.round)).size === 5 && rows.every(row => Number.isInteger(row.round) && row.round >= 0 && row.round < 5);
    }) && report.samples.every(row => row.status === 'passed' && [row.ingressMs,row.egressMs,row.forwardingMs].every(value => Number.isFinite(value) && value >= 0)
      && row.forwardingMs <= report.acceptance.limitMs);
}

try {
  await save();
  const pool = new pg.Pool({ connectionString: config.postgres.connectionString });
  await pool.query(await readFile(join(app, 'migrations/001.sql'), 'utf8')); await pool.end();
  peers = await connect({ servers: config.nats.servers, user: config.nats.user, pass: config.nats.password });
  client = await connect({ servers: config.nats.servers, user: config.nats.user, pass: config.nats.password });
  const fixture = input.fixtures[0];
  const bytes = await readFile(fixture.path);
  const directory = await mkdtemp(join(config.artifacts.tempRoot, 'forwarding-fixture-'));
  fixtureDirectories.push(directory);
  fixture.path = join(directory, 'audio.wav'); await writeFile(fixture.path, bytes); fixture.artifactId = randomUUID();
  const hash = createHash('sha256').update(bytes).digest('hex');
  server = createServer((req, res) => { if (req.url !== '/files/' + fixture.artifactId || req.method !== 'GET') { res.writeHead(404).end(); return; } res.writeHead(200, { 'content-length': bytes.length, 'content-type': 'audio/wav' }); res.end(bytes); });
  await new Promise(resolve => server.listen(19080, '127.0.0.1', resolve));
  peers.subscribe('brai.artifacts.v1.get', { callback: (_error, message) => message.respond(json({ artifactId: fixture.artifactId, ownerId, status: 'ready', mimeType: 'audio/wav', sizeBytes: bytes.length, sha256: hash, internalUrl: 'http://127.0.0.1:19080/files/' + fixture.artifactId })) });
  // AIDEV-NOTE: Новый publish не ждёт history; fixture только принимает факт без reply.
  peers.subscribe('brai.history.v1.append.local_ai', { callback: () => {} });
  await peers.flush();
  stage = 'startup';
  local = await startLocalAi(config, { factories: {
    startLocalAiNats: (nc, options, handlers) => startLocalAiNats(forwardingConnection(nc), options, handlers),
  } });
  // AIDEV-NOTE: SUB readiness barrier на service connection до request с другой connection.
  await local.nc.flush();
  const profiles = supportedProfiles(config);
  report.identity.models = profiles.map(profile => ({ modelId: profile.modelId, revision: profile.revision, profileId: profile.profileId, files: profile.record.files }));
  for (const profile of profiles) {
    activeProfileId = profile.profileId;
    const model = { modelId: profile.modelId, revision: profile.revision, profileId: profile.profileId };
    stage = 'load'; await request('models.load', { ...model, ownerId, deadlineAt: deadline() });
    await request('models.configure', { ...model, ownerId, idleUnloadSeconds: null });
    stage = 'forwarding';
    for (let round = 0; round < 5; round++) {
      const operation = profile.profileId === 'llama_cpp' ? 'embed' : 'transcribe';
      const before = spans.length;
      let outcome;
      try {
        const common = { requestId: randomUUID(), operationId: randomUUID(), ownerId, model, deadlineAt: deadline() };
        await request('invoke.'+operation, operation === 'embed' ? { ...common, texts: ['Как сохранить документ?'], purpose: 'query' } : { ...common, audioArtifactId: fixture.artifactId });
        const span = spans[before];
        const valid = spans.length === before + 1 && span && span.handoffs === 1 && span.responses === 1 && span.replies === 1 && !span.errorReply
          && [span.t0,span.t1,span.t2,span.t3,span.excludedTokenWaitMs].every(Number.isFinite)
          && (operation !== 'embed' || span.tokenCreates === 1)
          && span.tokenCreates === span.tokenSends && span.tokenSends === span.tokenResponses
          && span.t0 <= span.t1 && span.t1 <= span.t2 && span.t2 <= span.t3 && span.excludedTokenWaitMs >= 0 && span.excludedTokenWaitMs <= span.t1-span.t0;
        if (!valid) throw Object.assign(new Error(), { code: 'FORWARDING_MEASUREMENT_UNAVAILABLE' });
        const ingress = span.t1-span.t0-span.excludedTokenWaitMs;
        const egress = span.t3-span.t2;
        // AIDEV-NOTE: Порог сравнивается с точной суммой одного вызова до округления отчёта.
        outcome = { status: 'passed', ingressMs: rounded(ingress), egressMs: rounded(egress), forwardingMs: ingress+egress };
      } catch (error) { outcome = { status: 'failed', ...errorMetadata(error), ingressMs: null, egressMs: null, forwardingMs: null }; }
      report.samples.push({ operation, round, ...outcome });
      spans.length = 0; await save(); console.log(JSON.stringify({ stage: 'sample', operation, round, ...outcome }));
      if (outcome.status !== 'passed') throw Object.assign(new Error(), { code: outcome.code, origin: outcome.origin, status: outcome.errorStatus });
    }
    stage = 'unload'; await request('models.unload', { ...model, ownerId, deadlineAt: deadline() });
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.errors.push({ stage, profileId: activeProfileId, ...errorMetadata(error) }); }
finally {
  stage = 'cleanup';
  try { await local?.close(); } catch (error) { report.errors.push({ stage, profileId: activeProfileId, ...errorMetadata(error) }); report.status = 'failed'; }
  const cleanups = await Promise.allSettled([
    Promise.resolve().then(() => client?.drain()), Promise.resolve().then(() => peers?.drain()), server ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : undefined,
    ...fixtureDirectories.map(directory => Promise.resolve().then(() => rm(directory, { recursive: true, force: true }))),
  ]);
  for (const result of cleanups) if (result.status === 'rejected') { report.errors.push({ stage, code: safeCode(result.reason) }); report.status = 'failed'; }
  for (const [name, listener] of diagnosticHooks) channel(name).unsubscribe(listener);
  pendingRpc.clear(); JSON.parse = originalParse; childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  if (!forwardingComplete(report)) {
    report.status = 'failed';
    if (!report.errors.length) report.errors.push({ stage: 'metrics', code: report.samples.some(row => row.forwardingMs > report.acceptance.limitMs) ? 'FORWARDING_BUDGET_EXCEEDED' : 'INCOMPLETE_FORWARDING_SAMPLES' });
  }
  report.summaries = expectedOperations.map(operation => {
    const rows = report.samples.filter(row => row.operation === operation && row.status === 'passed');
    return { operation, ingress: stats(rows.map(row => row.ingressMs)), egress: stats(rows.map(row => row.egressMs)), forwarding: stats(rows.map(row => row.forwardingMs)) };
  });
  await save(); console.log(JSON.stringify({ stage: 'report', status: report.status, errors: report.errors, summaries: report.summaries }));
  // AIDEV-NOTE: Own process exit не заменяет Ansible cleanup/verify и product SIGTERM acceptance.
  process.exit(report.status === 'passed' ? 0 : 2);
}
