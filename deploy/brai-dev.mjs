#!/usr/bin/env node
// ABOUTME: Выпускает точный чистый commit в DEV через локальные проверенные поставки компонентов.
// ABOUTME: Собирает только изменённые компоненты и передаёт привилегированные операции фиксированным helper.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const operatorPath = '/usr/local/libexec/brai-dev-release/operator.py';
const previewPath = '/usr/local/sbin/brai-dev-preview';
const sha = /^[a-f0-9]{40}$/;
const hash = data => createHash('sha256').update(data).digest('hex');
const fail = message => { throw Error(message); };

/** Совпадает с Root storage.schema_ref: порядок и поля строк манифеста сохраняются. */
export function schemaRef(manifest) {
  if (!Array.isArray(manifest?.files) || manifest.files.some(row => !row || typeof row.path !== 'string')) fail('ARTIFACT_MANIFEST_INVALID');
  const rows=manifest.files.filter(row => (`/${row.path}`).includes('/migrations/') || posix.extname(row.path)==='.sql' || ['migrate.js','migrate.mjs','migrate.py'].includes(posix.basename(row.path)));
  return `sha256:${hash(JSON.stringify(rows))}`;
}

/** Вычислить hash и migration inputs из одних и тех же байтов manifest. */
export function manifestInfo(path, id, payloadHash) {
  const bytes=readFileSync(join(path,'artifact-manifest.json'));
  const manifest=JSON.parse(bytes.toString('utf8'));
  if(manifest.componentId!==id || manifest.payloadHash!==payloadHash)fail('ARTIFACT_MANIFEST_INVALID');
  return {sha256:hash(bytes),schemaRef:schemaRef(manifest)};
}

/** Проверяет неизменяемый source: принимается полный SHA текущего чистого HEAD, без разрешения branch/ref. */
export function assertSource(root, source, git = args => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'})) {
  if (!sha.test(source ?? '')) fail('SOURCE_SHA_REQUIRED: use a full 40-character commit SHA');
  if (git(['rev-parse', 'HEAD']).trim() !== source) fail('SOURCE_NOT_HEAD');
  if (git(['status', '--porcelain=v1', '--untracked-files=all']).trim()) fail('SOURCE_DIRTY');
  return source;
}

/** Не допустить установку источника, утратившего уже принятый DEV commit. */
export function assertAncestry(root, accepted, source) {
  if (!sha.test(accepted ?? '')) fail('ACCEPTED_SOURCE_INVALID');
  if (!sha.test(source ?? '')) fail('SOURCE_SHA_REQUIRED');
  try { execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', accepted, source], {stdio: 'ignore'}); }
  catch (error) {
    if (error.status === 1) fail('SOURCE_NOT_DESCENDANT: source must include the accepted DEV commit');
    fail('ANCESTRY_CHECK_FAILED: accepted and source commits must be available locally');
  }
}

/** Выбирает изменённые DEV-компоненты и всех их потребителей в топологическом порядке. */
export function selectComponents(graph, current, next, before) {
  const active = graph.order.filter(id => graph.components.get(id).environments.includes('dev'));
  const selected = new Set();
  for (const id of active) {
    const old = before[id];
    if (!current || !old || ['build', 'artifact', 'checks'].some(key => next[id][key] !== old[key])) selected.add(id);
  }
  // AIDEV-NOTE: Потребитель повторно проверяется даже при совпавшем локальном ключе: изменился его поставщик.
  for (const id of graph.order) if (active.includes(id) && graph.components.get(id).dependencies.some(dep => selected.has(dep.id))) selected.add(id);
  return active.filter(id => selected.has(id));
}

function assertReady(status) {
  if (!status || !Object.hasOwn(status, 'current') || !status.supportedComponents) fail('OPERATOR_STATUS_INVALID');
  if (status.operation && !['accepted', 'rolled-back', 'failed'].includes(status.operation.state)) fail(`RECONCILE_REQUIRED: ${status.operation.releaseId}`);
}

function baseId(status) { return status.current?.releaseId ?? null; }

function assertSameBase(status, expected) {
  assertReady(status);
  if (baseId(status) !== expected) fail('STALE_BASE: accepted DEV release changed; restart from status');
}

function phaseTimer(timings, ports) {
  return async (phase, work, component) => {
    const start = ports.now();
    try { const value = await work(); timings.push({phase, ...(component ? {component} : {}), durationMs: ports.now() - start, state: 'passed'}); return value; }
    catch (error) { timings.push({phase, ...(component ? {component} : {}), durationMs: ports.now() - start, state: 'failed'}); throw error; }
  };
}

function assertSupported(status, ids) {
  for (const id of ids) {
    const capability = status.supportedComponents[id];
    if (!capability?.supported) fail(`UNSUPPORTED_HANDLER: ${id}: ${capability?.handler ?? 'not configured'}`);
  }
}

async function prepareComponent(root, id, graph, status, ports, timed) {
  const rows = await timed('prepare', () => ports.execute(root, 'run', [id], {base: status.current?.sourceSha, includeDependencies: false}), id);
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].id !== id) fail(`COMPONENT_RESULT_INVALID: ${id}: run`);
  const result = rows[0];
  if (!result.checked || !['executed', 'cached'].includes(result.checkProof)) fail(`CHECK_NOT_EXECUTED: ${id}`);
  const artifact = result.artifact;
  if (!artifact?.path) fail(`ARTIFACT_INVALID: ${id}`);
  if (!/^[a-f0-9]{64}$/.test(artifact.payloadHash ?? '')) fail(`ARTIFACT_INVALID: ${id}`);
  const manifest = await ports.manifestInfo(artifact.path,id,artifact.payloadHash);
  const before = status.current?.components?.[id]?.schema?.after ?? status.supportedComponents[id].schemaRef ?? 'unchanged';
  return {id,
    artifact: {path: artifact.path, digest: `sha256:${artifact.payloadHash}`, metadata: {payloadHash: artifact.payloadHash}},
    schema: {before, after: manifest.schemaRef, rollbackCompatible: true},
    checks: [{kind: 'artifact-manifest', sha256: manifest.sha256}],
    fingerprints: await ports.fingerprint(root, graph.components.get(id))};
}

/** Выполняет выпуск через явные порты; ошибка никогда не превращается в accepted/успешный пустой выпуск. */
export async function release({root, source, prepareOnly = false}, ports) {
  const timings = [], started = ports.now();
  const timed = phaseTimer(timings, ports);
  let candidatePath, operationId;
  try {
    await timed('source', () => ports.assertSource(root, source));
    const status = await timed('status', () => ports.operator('status'));
    assertReady(status);
    const expectedBase = baseId(status);
    if (status.current) {
      if (status.current.sourceSha == null) fail('INITIAL_COMPOSITION_RECONCILE_REQUIRED');
      if (!sha.test(status.current.sourceSha)) fail('ACCEPTED_SOURCE_INVALID');
      await timed('ancestry', () => ports.assertAncestry(root, status.current.sourceSha, source));
    }
    const graph = await timed('graph', () => ports.graph(root, status.current?.sourceSha));
    for (const id of Object.keys(status.current?.components ?? {})) {
      if (graph.components.get(id)?.status !== 'active') fail(`UNSUPPORTED_RETIREMENT: ${id}: explicit lifecycle handler required`);
    }
    const next = {}, before = {};
    await timed('fingerprints', async () => {
      const groups = new Map();
      for (const id of graph.order) {
        next[id] = await ports.fingerprint(root, graph.components.get(id));
        const installed = status.current?.components?.[id];
        if (!installed) continue;
        const previousSource = installed.sourceSha ?? status.current.sourceSha;
        if (!sha.test(previousSource ?? '')) fail(`ACCEPTED_SOURCE_INVALID: ${id}`);
        if (installed.fingerprints) before[id] = installed.fingerprints;
        else {
          if (!groups.has(previousSource)) groups.set(previousSource, []);
          groups.get(previousSource).push(id);
        }
      }
      for (const [previousSource, ids] of groups) {
        const scoped = {...graph, order: ids, components: new Map(ids.map(id => [id, graph.components.get(id)]))};
        const baseline = await ports.sourceFingerprints(root, previousSource, scoped);
        for (const id of ids) if (baseline[id]) before[id] = baseline[id];
      }
    });
    const selected = selectComponents(graph, status.current, next, before);
    if (!selected.length) {
      await timed('unchanged-verify', async () => { await ports.assertSource(root, source); assertSameBase(await ports.operator('status'), expectedBase); });
      return {state: 'unchanged', releaseId: expectedBase, sourceSha: source,
        acceptedSourceSha: status.current.sourceSha, components: [], timings, durationMs: ports.now() - started};
    }
    assertSupported(status, selected);
    // AIDEV-NOTE: Проверка возможностей и базы предшествует сборке и импорту, а root повторно проверяет expectedBase под lock.
    await timed('preflight', async () => { await ports.assertSource(root, source); assertSameBase(await ports.operator('status'), expectedBase); });
    const components = [];
    for (const id of selected) components.push(await prepareComponent(root, id, graph, status, ports, timed));
    await timed('before-apply', async () => { await ports.assertSource(root, source); assertSameBase(await ports.operator('status'), expectedBase); });
    const candidate = {version: 1, target: 'dev', releaseId: ports.uuid(), sourceSha: source, expectedBase, components};
    operationId = candidate.releaseId;
    candidatePath = await timed('candidate', () => ports.saveCandidate(root, candidate));
    if (prepareOnly) return {state:'prepared',releaseId:candidate.releaseId,sourceSha:source,expectedBase,components:selected,candidatePath,timings,durationMs:ports.now()-started};
    const queued = await timed('apply', () => ports.operator('apply', candidatePath));
    if (queued.releaseId !== candidate.releaseId) fail('APPLY_RELEASE_MISMATCH');
    const accepted = await timed('wait', () => waitForOperation(candidate.releaseId, ports, {action:'apply', sourceSha:source}));
    if (accepted.operation?.state !== 'accepted') fail('RELEASE_NOT_ACCEPTED');
    const result = {releaseId: candidate.releaseId, sourceSha: source, state: 'accepted', components: selected, candidatePath,
      currentDesiredReleaseId: accepted.current?.releaseId ?? null,
      timings, operatorTimings: accepted.operation?.timings ?? [], durationMs: ports.now() - started};
    try { await ports.saveReport?.(root, candidate.releaseId, result); }
    catch (error) { result.reportError = error.message; }
    return result;
  } catch (error) {
    error.report = {state: 'failed', sourceSha: source, ...(operationId ? {releaseId: operationId} : {}), ...(candidatePath ? {candidatePath} : {}), error: error.message, timings, durationMs: ports.now() - started};
    throw error;
  }
}

/** Готовит только web, запечатывает пакет и обновляет ровно указанный preview с compare-and-swap слота. */
export async function preview({root, source, slot, expected}, ports) {
  const timings = [], started = ports.now(), timed = phaseTimer(timings, ports);
  try {
    await timed('source', () => ports.assertSource(root, source));
    const slotStatus = await timed('preview-status', () => ports.preview({action: 'status', slot}));
    const actual = slotStatus.current?.release_id ?? null;
    if (actual && expected === undefined) fail('PREVIEW_EXPECTED_REQUIRED: occupied slot requires --expected');
    expected ??= null;
    if (actual !== expected) fail('PREVIEW_STALE_BASE');
    if (!['ready', 'stopped'].includes(slotStatus.status)) fail('PREVIEW_RECONCILE_REQUIRED');
    const status = await timed('status', () => ports.operator('status')); assertReady(status);
    assertSupported(status, ['web']);
    const expectedBase = baseId(status), graph = await timed('graph', () => ports.graph(root, status.current?.sourceSha));
    if (graph.components.get('web')?.status !== 'active') fail('WEB_COMPONENT_MISSING');
    const component = await prepareComponent(root, 'web', graph, status, ports, timed);
    await timed('before-seal', async () => { await ports.assertSource(root, source); assertSameBase(await ports.operator('status'), expectedBase); });
    const candidate = {version: 1, target: 'dev', releaseId: ports.uuid(), sourceSha: source, expectedBase, components: [component]};
    const path = await timed('candidate', () => ports.saveCandidate(root, candidate));
    const sealed = await timed('seal', () => ports.operator('seal', path));
    if (sealed.releaseId !== candidate.releaseId || sealed.sourceSha !== source || !sealed.components?.some(c => c.id === 'web')) fail('SEAL_RESULT_INVALID');
    const prepared = await timed('preview-prepare', () => ports.preview({action: 'prepare', source, artifact: component.artifact.metadata.payloadHash}));
    if (prepared.status !== 'prepared' || prepared.source !== source) fail('PREVIEW_PREPARE_FAILED');
    const result = await timed('preview-update', () => ports.preview({action: 'update', source, slot, expected}));
    if (result.status !== 'ready' || result.current?.source !== source) fail('PREVIEW_NOT_READY');
    return {...result, timings, durationMs: ports.now() - started};
  } catch (error) {
    error.report = {state: 'failed', sourceSha: source, slot, error: error.message, timings, durationMs: ports.now() - started}; throw error;
  }
}

/** Ждёт терминальное состояние точной операции без скрытого срока; прерывание CLI не отменяет root-операцию. */
export async function waitForOperation(releaseId, ports, {action, sourceSha} = {}) {
  for (;;) {
    const status = await ports.operator('status', releaseId);
    const operation = status.operation;
    if (operation?.releaseId !== releaseId) fail('OPERATION_CHANGED: inspect brai-dev status');
    if ((action && operation.action !== action) || (sourceSha !== undefined && operation.sourceSha !== sourceSha)) fail('OPERATION_IDENTITY_MISMATCH: inspect brai-dev status');
    if (['accepted', 'rolled-back'].includes(operation.state)) return status;
    if (['failed', 'recovery-required'].includes(operation.state)) fail(`OPERATION_${operation.state.toUpperCase()}: ${releaseId}: ${operation.error ?? 'inspect status'}`);
    await ports.pause();
  }
}

function run(program, args, input) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, {stdio: ['pipe', 'pipe', 'inherit']});
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stdin.on('error', reject);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveRun(Buffer.concat(chunks).toString('utf8')) : reject(Error(`HELPER_FAILED: ${program}: ${code}`)));
    child.stdin.end(input);
  });
}

/** Подключает Git, чистый component runner и фиксированные root helper; зависимости не устанавливает. */
export async function localPorts() {
  const {discover, fingerprints} = await import('./components/graph.mjs');
  const {execute} = await import('./components/cli.mjs');
  return {
    now: () => performance.now(), uuid: () => randomUUID(), assertSource, assertAncestry,
    graph: (root, base) => discover(root, {base, allowMissingBuildOutputs: true}), fingerprint: fingerprints,
    execute,
    manifestInfo,
    operator: async (...args) => JSON.parse(await run('/usr/bin/sudo', ['-n', '/usr/bin/python3', '-B', operatorPath, ...args])),
    preview: async request => JSON.parse(await run('/usr/bin/sudo', ['-n', previewPath], JSON.stringify(request))),
    pause: () => new Promise(done => setTimeout(done, 1000)),
    sourceFingerprints: async (root, source, graph) => {
      if (!sha.test(source ?? '')) fail('ACCEPTED_SOURCE_INVALID');
      const temporary = join(root, 'tmp'); mkdirSync(temporary, {recursive: true});
      const stage = mkdtempSync(join(temporary, 'dev-release-base-'));
      try {
        const archive = join(stage, 'source.tar'), checkout = join(stage, 'source'); mkdirSync(checkout);
        await run('git', ['-C', root, 'archive', '--format=tar', '--output', archive, source]);
        await run('tar', ['-xf', archive, '-C', checkout]);
        const result = {};
        for (const [id, component] of graph.components) {
          const descriptor = join(checkout, component.descriptor);
          if (existsSync(descriptor)) {
            const previous = JSON.parse(readFileSync(descriptor, 'utf8'));
            if (previous.id === id && previous.status === 'active') result[id] = fingerprints(checkout, {...previous, directory: component.directory});
          }
        }
        return result;
      } finally { rmSync(stage, {recursive: true, force: true}); }
    },
    saveCandidate: async (root, candidate) => {
      if (!sha.test(candidate.sourceSha ?? '') || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate.releaseId ?? '')) fail('CANDIDATE_ID_INVALID');
      await run('git', ['-C', root, 'update-ref', `refs/brai-dev/releases/${candidate.releaseId}`, candidate.sourceSha, '0'.repeat(40)]);
      const directory = join(root, 'tmp', 'dev-release', candidate.releaseId); mkdirSync(directory, {recursive: true});
      const path = join(directory, 'candidate.json'); writeFileSync(path, JSON.stringify(candidate, null, 2) + '\n', {flag: 'wx', mode: 0o644}); return path;
    },
    saveReport: (root, id, report) => writeFileSync(join(root, 'tmp', 'dev-release', id, 'report.json'), JSON.stringify(report, null, 2) + '\n'),
  };
}

/** Разбирает только документированные команды; unknown/missing/duplicate options отклоняются до внешних действий. */
export function parseArguments(args) {
  const [command, ...rest] = args;
  const allowed = {release: ['source'], status: [], reconcile: [], rollback: ['release'], preview: ['slot', 'source', 'expected'], 'preview-stop': ['slot', 'expected']};
  if (!Object.hasOwn(allowed, command ?? '')) fail('USAGE: brai-dev release --source SHA | status [operation-id] | reconcile <operation-id> | rollback --release ID | preview --slot 01|02 --source SHA [--expected ID|none] | preview-stop --slot 01|02 [--expected ID|none]');
  const result = {command};
  if (['status', 'reconcile'].includes(command) && rest.length && !rest[0].startsWith('--')) result.operation = rest.shift();
  if (command === 'reconcile' && !result.operation) fail('OPERATION_ID_REQUIRED');
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, '');
    if (rest[i] !== `--${key}` || !allowed[command].includes(key) || Object.hasOwn(result, key) || !rest[i + 1] || rest[i + 1].startsWith('--')) fail(`INVALID_OPTION: ${rest[i]}`);
    result[key] = rest[i + 1];
  }
  const required = {release: ['source'], rollback: ['release'], preview: ['slot', 'source'], 'preview-stop': ['slot']};
  for (const key of required[command] ?? []) if (!Object.hasOwn(result, key)) fail(`OPTION_REQUIRED: --${key}`);
  if (result.source && !sha.test(result.source)) fail('SOURCE_SHA_REQUIRED');
  if (result.slot && !['01', '02'].includes(result.slot)) fail('INVALID_SLOT');
  if (result.expected === 'none') result.expected = null;
  return result;
}

/** Выполняет CLI и возвращает структурированный результат для журналирования и тестов. */
export async function main(args = process.argv.slice(2), ports, root = process.cwd()) {
  const options = parseArguments(args); ports ??= await localPorts(); root = resolve(root);
  if (options.command === 'release') return release({root, source: options.source}, ports);
  if (options.command === 'status') {
    const status = await ports.operator('status', ...(options.operation ? [options.operation] : []));
    if (options.operation) return status;
    const previews = {};
    for (const slot of ['01', '02']) {
      try { previews[slot] = await ports.preview({action: 'status', slot}); }
      catch (error) { previews[slot] = {status: 'unavailable', error: error.message}; }
    }
    return {...status, previews};
  }
  if (options.command === 'reconcile') {
    const current = await ports.operator('status');
    if (current.operation?.releaseId !== options.operation) fail('RECONCILE_RELEASE_MISMATCH');
    return ports.operator('reconcile', options.operation);
  }
  if (options.command === 'rollback') {
    const status = await ports.operator('status'); assertReady(status);
    if (!status.current || status.previous?.releaseId !== options.release) fail('ROLLBACK_RELEASE_NOT_PREVIOUS');
    const queued = await ports.operator('rollback', status.current.releaseId);
    const result = await waitForOperation(queued.releaseId, ports, {action:'rollback',sourceSha:status.previous.sourceSha});
    if (result.operation?.targetReleaseId !== options.release || result.operation?.state !== 'rolled-back') fail('ROLLBACK_NOT_ACCEPTED');
    return {...result,currentDesiredReleaseId:result.current?.releaseId ?? null};
  }
  if (options.command === 'preview') {
    return preview({root, ...options}, ports);
  }
  const status = await ports.preview({action: 'status', slot: options.slot});
  const actual = status.current?.release_id ?? null;
  if (actual && options.expected === undefined) fail('PREVIEW_EXPECTED_REQUIRED: occupied slot requires --expected');
  if (actual !== (options.expected ?? null)) fail('PREVIEW_STALE_BASE');
  return ports.preview({action: 'stop', slot: options.slot, expected: options.expected ?? null});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify(error.report ?? {state: 'failed', error: error.message}, null, 2)); process.exitCode = 1;
  });
}
