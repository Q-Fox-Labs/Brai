// ABOUTME: Сравнивает прямой движок, текущий adapter и полный local-ai NATS на одном runtime.
// ABOUTME: Использует отдельные DB/NATS и fixture peers; печатает только числовой отчёт и безопасные коды.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'node:path';

const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const app = input.appRoot;
const require = createRequire(join(app, 'package.json'));
const pg = require('pg');
const { connect } = require('nats');
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;
const children = new Map();
let decodeSamples = [];
const sqlScope = new AsyncLocalStorage();
const sql = { invoke: 0, background: 0, other: 0 };
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  sql[sqlScope.getStore() ?? 'other']++;
  return originalQuery.apply(this, args);
};
childProcess.spawn = function (executable, args, options) {
  const profile = executable.includes('llama-server') ? 'llama_cpp' : executable.includes('/.venv/bin/python') ? 'gigaam_pytorch' : null;
  if (profile === 'gigaam_pytorch') args = [input.decodeWrapper, isAbsolute(args[0]) ? args[0] : join(app, args[0]), ...args.slice(1)];
  const child = originalSpawn(executable, args, options);
  if (profile) {
    children.set(profile, child);
    let diagnostic = '';
    child.stderr.on('data', chunk => {
      // AIDEV-NOTE: Сырой stderr остаётся только в памяти и сразу отбрасывается.
      diagnostic += chunk.toString();
      const lines = diagnostic.split('\n');
      diagnostic = lines.pop().slice(-4096);
      for (const line of lines) if (line.startsWith('BASELINE_STAGE ')) {
        try {
          const value = JSON.parse(line.slice(15));
          if (['probe', 'decode'].includes(value.stage) && Number.isFinite(value.durationMs)) decodeSamples.push(value);
        } catch {}
      }
    });
  }
  return child;
};
syncBuiltinESMExports();
const load = relative => import(pathToFileURL(join(app, relative)).href);
const { startLocalAi, supportedProfiles } = await load('src/main.mjs');
const { createProfileRuntimeFactory } = await load('dist/lifecycle/runtime-factory.js');
const { createLifecycleManager } = await load('dist/lifecycle/manager.js');
const { createPostgresStore } = await load('dist/storage/postgres.js');
const { createArtifactsAdapter } = await load('dist/adapters/artifacts/index.js');
const { createHistoryDeliveryWorker } = await load('dist/adapters/history/index.js');

const config = input.config;
const ownerId = randomUUID();
const records = [];
const cold = [];
const runtimes = new Map();
const artifactTimes = new Map();
const fixtureDirectories = [];
let server, peers, client, local;
let stage = 'initialize';
const report = { formatVersion: 1, status: 'running', identity: input.identity, cold, samples: records, queue: [], limits: config.lifecycle, errors: [],
  host: { cpuModel: os.cpus()[0]?.model, visibleCpuCount: os.availableParallelism(), loadBefore: os.loadavg(), node: process.version },
  methodology: { warmupRounds: 1, order: 'latin-square', percentile: 'nearest-rank', coldOsPageCache: false,
    coldRunsPerProfile: 1, asrTail: 'exploratory-worst-sample-at-n3', directAsrBoundary: 'existing-runner-json-rpc',
    directTokenBoundsCheckedBeforeMeasurements: true, directMeasuredTokenizeCalls: 0, adapterMeasuredTokenizeCalls: 'one-per-text',
    peers: 'fixture-artifacts-http-nats-and-history-nats', productionPeerLatencyIncluded: false } };
const now = () => performance.now();
const rounded = value => Math.round(value * 1000) / 1000;
const deadline = () => new Date(Date.now() + config.transport.maxRequestMs - 1000).toISOString();
const context = operationId => ({ ownerId, operationId, deadlineAt: deadline(), signal: new AbortController().signal });
const json = value => Buffer.from(JSON.stringify(value));
const safeCode = error => typeof error?.code === 'string' && /^[A-Z_0-9]+$/.test(error.code) ? error.code : 'BASELINE_FAILED';

/** Запросить неизменённый публичный DTO, проверив service error до полезной нагрузки. */
async function request(subject, body) {
  const message = await client.request('brai.local_ai.v1.' + subject, json(body), { timeout: config.transport.maxRequestMs });
  const code = message.headers?.get('Nats-Service-Error');
  if (code) throw Object.assign(new Error(), { code });
  return JSON.parse(Buffer.from(message.data).toString());
}

/** Посчитать nearest-rank p50/p95 только успешных измерений, не подменяя отказы временем. */
function stats(values) {
  if (!values.length) return { n: 0, p50: null, p95: null };
  const sorted = values.toSorted((a, b) => a - b);
  return { n: sorted.length, p50: rounded(sorted[Math.ceil(sorted.length * .5) - 1]), p95: rounded(sorted[Math.ceil(sorted.length * .95) - 1]) };
}

/** Снять память процесса и cgroup без вывода аргументов или среды. */
async function memory(profile) {
  const pid = children.get(profile)?.pid;
  const status = pid ? await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '') : '';
  const value = key => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(status)?.[1] ?? 0) * 1024;
  return { engineRssBytes: value('VmRSS'), engineHwmBytes: value('VmHWM'), nodeRssBytes: process.memoryUsage().rss,
    cgroupBytes: Number(await readFile('/sys/fs/cgroup/memory.current', 'utf8').catch(() => '0')) };
}

/** Выполнить одиночный приватный RPC на том же child, который использует adapter. */
function directRpc(child, method, params) {
  const id = 'baseline-' + randomUUID();
  return new Promise((resolve, reject) => {
    let buffer = '';
    const finish = (error, result) => { clearTimeout(timer); child.stdout.off('data', receive); error ? reject(error) : resolve(result); };
    const receive = chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.id !== id) continue;
        if (value.error) finish(Object.assign(new Error(), { code: value.error.code === -32001 ? 'INVALID_ARGUMENT' : 'ENGINE_UNAVAILABLE' }));
        else finish(null, value.result);
      }
    };
    const timer = setTimeout(() => finish(Object.assign(new Error(), { code: 'DEADLINE_EXCEEDED' })), config.runtime.gigaam_pytorch.requestTimeoutMs);
    child.stdout.on('data', receive);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function directEmbed(model, texts, purpose) {
  const prepared = texts.map(text => purpose === 'query' ? `Instruct: ${config.runtime.llama_cpp.queryInstruction}\nQuery: ${text}` : text);
  const response = await fetch(`http://127.0.0.1:${config.runtime.llama_cpp.port}/v1/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model.modelId, input: prepared }), signal: AbortSignal.timeout(config.runtime.llama_cpp.requestTimeoutMs),
  });
  if (!response.ok) throw Object.assign(new Error(), { code: 'ENGINE_UNAVAILABLE' });
  return { vectors: (await response.json()).data.map(row => row.embedding) };
}

/** Чередовать три пути по Latin square; сохранять только длительность и размер результата. */
async function measureScenario(scenario, model, count, payload) {
  const paths = ['direct', 'adapter', 'nats'];
  // AIDEV-NOTE: Первый round прогревает все пути, но не входит в percentile.
  for (let round = -1; round < count; round++) {
    for (let position = 0; position < 3; position++) {
      const path = paths[(position + round + 3) % 3];
      const operationId = randomUUID();
      const base = { requestId: randomUUID(), operationId, ownerId, model, deadlineAt: deadline() };
      const before = { ...sql }; decodeSamples = [];
      const started = now();
      let outcome;
      try {
        const runtime = runtimes.get(model.profileId);
        let result;
        if (payload.texts) {
          const requestBody = { ...base, texts: payload.texts, purpose: payload.purpose };
          result = path === 'direct' ? await directEmbed(model, payload.texts, payload.purpose)
            : path === 'adapter' ? await runtime.embed(requestBody, context(operationId)) : await request('invoke.embed', requestBody);
          if (result.vectors.length !== payload.texts.length || result.vectors.some(v => v.length !== 1024 || v.some(x => !Number.isFinite(x)))) throw Object.assign(new Error(), { code: 'VECTOR_SHAPE' });
          outcome = { resultItems: result.vectors.length, dimensions: 1024 };
        } else {
          const requestBody = { ...base, audioArtifactId: payload.artifactId };
          result = path === 'direct' ? await directRpc(children.get(model.profileId), 'transcribe', { audio_path: payload.path })
            : path === 'adapter' ? await runtime.transcribe({ model, audioPath: payload.path }, context(operationId)) : await request('invoke.transcribe', requestBody);
          if (typeof result.text !== 'string') throw Object.assign(new Error(), { code: 'TEXT_SHAPE' });
          outcome = { resultCharacters: result.text.length, resultSegments: result.segments?.length ?? 0 };
        }
        outcome = { status: 'passed', durationMs: rounded(now() - started), ...outcome };
      } catch (error) { outcome = { status: 'failed', code: safeCode(error), elapsedUntilFailureMs: rounded(now() - started) }; }
      await new Promise(resolve => setImmediate(resolve));
      const sample = { scenario, round, path, ...outcome, sqlInvoke: sql.invoke - before.invoke, sqlBackground: sql.background - before.background,
        sqlOther: sql.other - before.other, acquisitionMs: artifactTimes.get(operationId) ?? null,
        audioProbeMs: decodeSamples.filter(s => s.stage === 'probe').reduce((a, b) => a + b.durationMs, 0),
        audioDecodeMs: decodeSamples.filter(s => s.stage === 'decode').reduce((a, b) => a + b.durationMs, 0), memory: await memory(model.profileId) };
      if (round >= 0 || sample.status === 'failed') records.push(sample);
      await writeFile(input.output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ stage: 'sample', scenario, round, path, status: sample.status, code: sample.code ?? null, durationMs: sample.durationMs ?? null }));
      // Не дать ёмкости исходного outbox исказить одиночные warm runs.
      if (path === 'nats') await new Promise(resolve => setTimeout(resolve, config.history.pollIntervalMs + 50));
      if (sample.status === 'failed' && sample.code === 'DEADLINE_EXCEEDED') {
        // После deadline исходная работа может жить; продолжение запрещено до close/exited.
        const runtime = runtimes.get(model.profileId);
        await runtime.close(); await runtime.exited;
        throw Object.assign(new Error(), { code: 'DEADLINE_EXCEEDED' });
      }
    }
  }
}

try {
  const pool = new pg.Pool({ connectionString: config.postgres.connectionString });
  await pool.query(await readFile(join(app, 'migrations/001.sql'), 'utf8'));
  await pool.end();
  peers = await connect({ servers: config.nats.servers, user: config.nats.user, pass: config.nats.password });
  client = await connect({ servers: config.nats.servers, user: config.nats.user, pass: config.nats.password });
  const fixtures = new Map();
  for (const fixture of input.fixtures) {
    const bytes = await readFile(fixture.path);
    const directory = await mkdtemp(join(config.artifacts.tempRoot, 'baseline-fixture-'));
    fixtureDirectories.push(directory);
    fixture.path = join(directory, 'audio.wav');
    await writeFile(fixture.path, bytes);
    fixture.artifactId = randomUUID();
    fixtures.set(fixture.artifactId, { ...fixture, bytes, hash: createHash('sha256').update(bytes).digest('hex') });
  }
  server = createServer((req, res) => {
    const fixture = fixtures.get(req.url?.slice('/files/'.length));
    if (!fixture) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-length': fixture.bytes.length, 'content-type': 'audio/wav' }); res.end(fixture.bytes);
  });
  await new Promise(resolve => server.listen(19080, '127.0.0.1', resolve));
  peers.subscribe('brai.artifacts.v1.get', { callback: (_error, message) => {
    const { artifactId } = JSON.parse(Buffer.from(message.data).toString());
    const fixture = fixtures.get(artifactId);
    message.respond(json({ artifactId, ownerId, status: 'ready', mimeType: 'audio/wav', sizeBytes: fixture.bytes.length, sha256: fixture.hash, internalUrl: `http://127.0.0.1:19080/files/${artifactId}` }));
  } });
  peers.subscribe('brai.history.v1.append.local_ai', { callback: (_error, message) => {
    const body = JSON.parse(Buffer.from(message.data).toString());
    message.respond(json({ event: { ...body, source: 'local_ai', recorded_at: new Date().toISOString() } }));
  } });
  const historyService = await peers.services.add({ name: 'service_history', version: '1.0.0' });
  void historyService;
  await peers.flush();
  stage = 'startup';
  const startupAt = now();
  local = await startLocalAi(config, { factories: {
    createPostgresStore(pool, options) {
      const store = createPostgresStore(pool, options);
      for (const name of ['claimBatch', 'acknowledge', 'fail']) if (typeof store[name] === 'function') {
        const original = store[name].bind(store); store[name] = (...args) => sqlScope.run('background', () => original(...args));
      }
      return store;
    },
    createHistoryDeliveryWorker(options) {
      const worker = createHistoryDeliveryWorker(options);
      const start = worker.start.bind(worker); worker.start = () => sqlScope.run('background', start);
      return worker;
    },
    createLifecycleManager(options) {
      const manager = createLifecycleManager(options);
      const invoke = manager.invoke.bind(manager); manager.invoke = (...args) => sqlScope.run('invoke', () => invoke(...args));
      return manager;
    },
    createArtifactsAdapter(options) {
      const adapter = createArtifactsAdapter(options);
      return { withReadyAudio(input, context, use) {
        const started = now();
        return adapter.withReadyAudio(input, context, resource => { artifactTimes.set(context.operationId, rounded(now() - started)); return use(resource); });
      } };
    },
    createProfileRuntimeFactory(options) {
      const factory = createProfileRuntimeFactory(options);
      return { async open(model, context) {
        const started = now();
        const runtime = await factory.open(model, context);
        runtimes.set(model.model.profileId, runtime);
        cold.push({ profileId: model.model.profileId, engineReadyMs: rounded(now() - started), ...await memory(model.model.profileId) });
        return runtime;
      } };
    },
  } });
  report.startupMs = rounded(now() - startupAt);
  report.initialStatus = await request('status', {});
  const profiles = supportedProfiles(config);
  for (const profile of profiles) {
    stage = 'load';
    const model = { modelId: profile.modelId, revision: profile.revision, profileId: profile.profileId };
    const started = now();
    await request('models.load', { ...model, ownerId, deadlineAt: deadline() });
    cold.at(-1).fullLoadMs = rounded(now() - started);
    await request('models.configure', { ...model, ownerId, idleUnloadSeconds: null });
    await new Promise(resolve => setTimeout(resolve, 2100));
    stage = 'measure';
    if (profile.profileId === 'llama_cpp') {
      const short = ['Как сохранить документ?'];
      const long = ['Документ содержит описание работы поиска и сохранения файлов. '.repeat(24)];
      const batch = Array.from({ length: 8 }, (_, i) => `Поиск документа номер ${i}`);
      // Проверить одинаковые bounds/prefixes заранее; direct не повторяет служебные /tokenize.
      for (const [scenario, texts] of [['embedding_short', short], ['embedding_long', long], ['embedding_batch', batch]]) {
        let tokens = 0;
        for (const text of texts) {
          const content = `Instruct: ${config.runtime.llama_cpp.queryInstruction}\nQuery: ${text}`;
          const reply = await fetch(`http://127.0.0.1:${config.runtime.llama_cpp.port}/tokenize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, add_special: true }) });
          const count = (await reply.json()).tokens.length;
          if (count > config.runtime.llama_cpp.contextTokens) throw Object.assign(new Error(), { code: 'INPUT_TOO_LARGE' });
          tokens += count;
        }
        if (tokens > config.runtime.llama_cpp.maxBatchTokens) throw Object.assign(new Error(), { code: 'INPUT_TOO_LARGE' });
        await measureScenario(scenario, model, input.embeddingRuns ?? 20, { texts, purpose: 'query' });
      }
      const queueTexts = long;
      report.queue = await Promise.all(Array.from({ length: 4 }, async () => {
        const start = now();
        try { await request('invoke.embed', { requestId: randomUUID(), operationId: randomUUID(), ownerId, deadlineAt: deadline(), model, texts: queueTexts, purpose: 'query' }); return { status: 'passed', durationMs: rounded(now() - start) }; }
        catch (error) { return { status: 'failed', code: safeCode(error), elapsedUntilFailureMs: rounded(now() - start) }; }
      }));
    } else for (const fixture of input.fixtures) await measureScenario('asr_' + fixture.name, model, input.asrRuns ?? 3, fixture);
    await request('models.unload', { ...model, ownerId, deadlineAt: deadline() });
    await new Promise(resolve => setTimeout(resolve, 2100));
  }
  report.status = records.some(row => row.status === 'failed') ? 'completed_with_failures' : 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push({ stage, code: safeCode(error) });
} finally {
  stage = 'cleanup';
  try { if (local) await local.close(); } catch (error) { report.errors.push({ stage, code: safeCode(error) }); report.status = 'failed'; }
  await client?.drain(); await peers?.drain();
  if (server) await new Promise(resolve => server.close(resolve));
  for (const directory of fixtureDirectories) await rm(directory, { recursive: true, force: true });
  childProcess.spawn = originalSpawn; pg.Client.prototype.query = originalQuery; syncBuiltinESMExports();
  report.sqlTotal = sql;
  report.host.loadAfter = os.loadavg();
  report.queueSummary = stats(report.queue.filter(row => row.status === 'passed').map(row => row.durationMs));
  report.summaries = [...new Set(records.map(row => row.scenario))].map(scenario => {
    const rows = records.filter(row => row.scenario === scenario);
    const paths = Object.fromEntries(['direct', 'adapter', 'nats'].map(path => [path, stats(rows.filter(row => row.path === path && row.status === 'passed').map(row => row.durationMs))]));
    const paired = path => rows.filter(row => row.path === path && row.status === 'passed').flatMap(row => {
      const direct = rows.find(peer => peer.path === 'direct' && peer.round === row.round && peer.status === 'passed');
      return direct ? [{ ms: row.durationMs - direct.durationMs, percent: (row.durationMs - direct.durationMs) / direct.durationMs * 100 }] : [];
    });
    return { scenario, paths, failures: rows.filter(row => row.status === 'failed').map(row => ({ path: row.path, code: row.code })), overhead: Object.fromEntries(['adapter', 'nats'].map(path => [path, { ms: stats(paired(path).map(x => x.ms)), percent: stats(paired(path).map(x => x.percent)) }])) };
  });
  await writeFile(input.output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ stage: 'report', status: report.status, errors: report.errors, summaries: report.summaries }));
  process.exitCode = ['passed', 'completed_with_failures'].includes(report.status) ? 0 : 2;
}
