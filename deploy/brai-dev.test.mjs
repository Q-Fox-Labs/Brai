// ABOUTME: Проверяет выбор компонентов и полный путь DEV-выпуска через изолированные порты.
// ABOUTME: Не вызывает привилегированные helper, Docker, live DEV, PROD или пользовательскую БД.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {assertSource, selectComponents, release, preview, main, parseArguments, waitForOperation} from './brai-dev.mjs';
import {packageComponent, verifyPackage} from './components/package-runtime.mjs';
import {createHash} from 'node:crypto';

const source = 'a'.repeat(40), oldSource = 'b'.repeat(40), digest = 'd'.repeat(64);
const releaseId = '2f72cb35-62f6-47b8-8bde-83005bf2e6de', base = '3794fd23-d27d-45e9-a952-607b4a59b6c4';
const keys = suffix => ({build: `build-${suffix}`, artifact: `artifact-${suffix}`, runtime: `runtime-${suffix}`, checks: `checks-${suffix}`});
const component = (id, deps = []) => ({id, status: 'active', environments: ['dev'], dependencies: deps.map(id => ({id})), directory: `services/${id}`});

function fixture() {
  const graph = {components: new Map([['auth', component('auth')], ['web', component('web', ['auth'])], ['timer', component('timer')]]), order: ['auth', 'web', 'timer']};
  let current = {releaseId: base, sourceSha: oldSource, components: Object.fromEntries(graph.order.map(id => [id, {fingerprints: keys(id), schema: {after: 'schema-v1'}}]))};
  const next = Object.fromEntries(graph.order.map(id => [id, keys(id)])); next.auth = keys('changed');
  const supportedComponents = Object.fromEntries(graph.order.map(id => [id, {supported: true, handler: 'compose-payload', schemaRef: 'schema-v1'}]));
  const calls = [], state = {graph, current, supportedComponents, next, candidate: null, operation: null, calls};
  let tick = 0;
  const ports = {
    now: () => ++tick, uuid: () => releaseId,
    assertSource: async (_root, value) => {calls.push(['source', value]); if (value !== source) throw Error('SOURCE_NOT_HEAD');},
    graph: async (_root, ref) => {calls.push(['graph', ref]); return graph;},
    fingerprint: async (_root, c) => next[c.id],
    sourceFingerprints: async (_root, ref) => {calls.push(['baseline', ref]); return Object.fromEntries(graph.order.map(id => [id, keys(id)]));},
    execute: async (_root, action, ids, options) => {calls.push([action, ids, options]); return ids.map(id => ({id, checked: action === 'check', artifact: action === 'package' ? {path: `/packages/${id}`} : undefined}));},
    verify: async (path, id) => {calls.push(['verify', path, id]); return {path, payloadHash: digest};},
    manifestHash: async () => 'e'.repeat(64),
    saveCandidate: async (_root, candidate) => {state.candidate = candidate; calls.push(['candidate', candidate]); return '/candidate.json';},
    operator: async (action, arg) => {
      calls.push(['operator', action, arg]);
      if (action === 'status') return {current: state.current, previous: state.previous, operation: state.operation, supportedComponents};
      if (action === 'seal') return state.candidate;
      if (action === 'apply') {state.operation = {releaseId, state: 'accepted', timings: [{phase: 'smoke', durationMs: 4}]}; state.current = {releaseId, sourceSha: source, components: state.candidate.components}; return {releaseId, state: 'queued'};}
      if (action === 'rollback') {state.operation = {releaseId, state: 'rolled-back'}; state.current = state.previous; return {releaseId};}
      if (action === 'reconcile') return {state: 'reconciled', releaseId: arg};
      throw Error('unexpected operator command');
    },
    pause: async () => {calls.push(['pause']);}, saveReport: async (_root, _id, report) => {state.report = report;},
    preview: async request => {
      calls.push(['preview', request]);
      if (request.action === 'status') return state.slot ?? {status: 'stopped', current: null};
      if (request.action === 'prepare') return {status: 'prepared', source, release_id: digest};
      if (request.action === 'stop') return {status: 'stopped', current: null};
      return {status: 'ready', slot: request.slot, current: {source, release_id: digest}};
    },
  };
  return {ports, state};
}

test('source rejects branch refs, wrong HEAD and dirty worktree before doing work', () => {
  const git = args => args[0] === 'rev-parse' ? `${source}\n` : '';
  assert.throws(() => assertSource('/root', 'dev', git), /SOURCE_SHA_REQUIRED/);
  assert.throws(() => assertSource('/root', oldSource, git), /SOURCE_NOT_HEAD/);
  assert.throws(() => assertSource('/root', source, args => args[0] === 'rev-parse' ? source : '?? untracked'), /SOURCE_DIRTY/);
  assert.equal(assertSource('/root', source, git), source);
});

test('select includes affected consumers but leaves unrelated component out', () => {
  const {state} = fixture();
  assert.deepEqual(selectComponents(state.graph, state.current, state.next, Object.fromEntries(state.graph.order.map(id => [id, keys(id)]))), ['auth', 'web']);
});

test('generated runtime fingerprint alone does not trigger source rebuild', () => {
  const {state} = fixture(); state.next.auth = {...keys('auth'), runtime: 'unbuilt'};
  assert.deepEqual(selectComponents(state.graph, state.current, state.next, Object.fromEntries(state.graph.order.map(id => [id, keys(id)]))), []);
});

test('release executes exact changed closure, manifests, CAS and accepted wait', async () => {
  const {ports, state} = fixture();
  const result = await release({root: '/repository', source}, ports);
  assert.equal(result.state, 'accepted'); assert.deepEqual(result.components, ['auth', 'web']);
  assert.equal(state.candidate.expectedBase, base); assert.equal(state.candidate.sourceSha, source);
  assert.equal(state.candidate.target, 'dev'); assert.equal(state.candidate.version, 1);
  assert.deepEqual(state.calls.filter(c => ['build', 'check', 'package'].includes(c[0])).map(c => c.slice(0, 2)), [
    ['build', ['auth']], ['check', ['auth']], ['package', ['auth']], ['build', ['web']], ['check', ['web']], ['package', ['web']],
  ]);
  for (const call of state.calls.filter(c => ['build', 'check', 'package'].includes(c[0]))) assert.deepEqual(call[2], {base: oldSource, includeDependencies: false});
  assert.equal(state.candidate.components[0].artifact.digest, `sha256:${digest}`);
  assert.deepEqual(state.candidate.components[0].checks, [{kind: 'artifact-manifest', sha256: 'e'.repeat(64)}]);
  assert.deepEqual(state.candidate.components[0].schema, {before: 'schema-v1', after: 'schema-v1', rollbackCompatible: true});
  assert.ok(result.timings.some(t => t.phase === 'build' && t.component === 'auth'));
  assert.deepEqual(result.operatorTimings, [{phase: 'smoke', durationMs: 4}]); assert.equal(state.report.state, 'accepted');
});

test('accepted fingerprint fallback uses the accepted source, never remote branch', async () => {
  const {ports, state} = fixture(); delete state.current.components.auth.fingerprints;
  await release({root: '/repository', source}, ports);
  assert.ok(state.calls.some(c => c[0] === 'baseline' && c[1] === oldSource));
  assert.ok(!JSON.stringify(state.calls).includes('origin/dev'));
});

test('report write failure does not misreport an already accepted runtime release', async () => {
  const {ports} = fixture(); ports.saveReport = async () => {throw Error('REPORT_WRITE_FAILED');};
  const result = await release({root: '/repository', source}, ports);
  assert.equal(result.state, 'accepted'); assert.equal(result.reportError, 'REPORT_WRITE_FAILED');
});

test('no source changes returns honest unchanged state with accepted source and no apply/build', async () => {
  const {ports, state} = fixture(); state.next.auth = keys('auth');
  const result = await release({root: '/repository', source}, ports);
  assert.equal(result.state, 'unchanged'); assert.equal(result.acceptedSourceSha, oldSource); assert.equal(result.releaseId, base);
  assert.equal(state.candidate, null); assert.ok(!state.calls.some(c => c[0] === 'build'));
});

test('unsupported changed handler fails before build, candidate, seal or apply', async () => {
  const {ports, state} = fixture(); state.supportedComponents.web = {supported: false, handler: 'native-program'};
  await assert.rejects(release({root: '/repository', source}, ports), /UNSUPPORTED_HANDLER: web/);
  assert.equal(state.candidate, null); assert.ok(!state.calls.some(c => c[0] === 'build'));
});

test('retired accepted component cannot disappear into successful unchanged result', async () => {
  const {ports, state} = fixture(); state.graph.components.get('auth').status = 'retired'; state.graph.order = ['web', 'timer'];
  await assert.rejects(release({root: '/repository', source}, ports), /UNSUPPORTED_RETIREMENT: auth/);
  assert.equal(state.candidate, null); assert.ok(!state.calls.some(c => c[0] === 'build'));
});

test('wrong source failure precedes even operator status', async () => {
  const {ports, state} = fixture();
  await assert.rejects(release({root: '/repository', source: oldSource}, ports), /SOURCE_NOT_HEAD/);
  assert.deepEqual(state.calls, [['source', oldSource]]);
});

test('stale accepted base is rejected before build', async () => {
  const {ports, state} = fixture(), original = ports.operator; let statuses = 0;
  ports.operator = async (...args) => {const result = await original(...args); if (args[0] === 'status' && ++statuses === 2) return {...result, current: {...result.current, releaseId: 'new-base'}}; return result;};
  await assert.rejects(release({root: '/repository', source}, ports), /STALE_BASE/);
  assert.ok(!state.calls.some(c => c[0] === 'build'));
});

test('base changing during build blocks candidate and apply', async () => {
  const {ports, state} = fixture(), original = ports.execute;
  ports.execute = async (...args) => {const result = await original(...args); state.current = {...state.current, releaseId: 'new-base'}; return result;};
  await assert.rejects(release({root: '/repository', source}, ports), /STALE_BASE/);
  assert.equal(state.candidate, null); assert.ok(!state.calls.some(c => c[0] === 'operator' && c[1] === 'apply'));
});

test('failed component check stops before package and apply with recorded duration', async () => {
  const {ports, state} = fixture(), original = ports.execute;
  ports.execute = async (...args) => {if (args[1] === 'check') throw Error('CHECK_FAILED'); return original(...args);};
  await assert.rejects(release({root: '/repository', source}, ports), error => {assert.equal(error.report.timings.at(-1).state, 'failed'); return /CHECK_FAILED/.test(error.message);});
  assert.ok(!state.calls.some(c => c[0] === 'package')); assert.equal(state.candidate, null);
});

test('package corruption never reaches apply', async () => {
  const {ports, state} = fixture(); ports.verify = () => {throw Error('IMMUTABLE_OUTPUT_MISMATCH');};
  await assert.rejects(release({root: '/repository', source}, ports), /IMMUTABLE_OUTPUT_MISMATCH/);
  assert.equal(state.candidate, null);
});

test('wait distinguishes queued, failed and changed operation without success', async () => {
  const {ports, state} = fixture();
  state.operation = {releaseId, state: 'queued'};
  ports.pause = async () => {state.operation = {releaseId, state: 'failed', error: 'smoke failed'};};
  await assert.rejects(waitForOperation(releaseId, ports), /smoke failed/);
  state.operation = {releaseId: base, state: 'accepted'};
  await assert.rejects(waitForOperation(releaseId, ports), /OPERATION_CHANGED/);
});

test('new release refuses unreconciled operation before build', async () => {
  const {ports, state} = fixture(); state.operation = {releaseId, state: 'recovery-required'};
  await assert.rejects(release({root: '/repository', source}, ports), /RECONCILE_REQUIRED/);
  assert.ok(!state.calls.some(c => c[0] === 'build'));
});

test('parser enforces public commands, exact source and explicit option values', () => {
  assert.deepEqual(parseArguments(['status', releaseId]), {command: 'status', operation: releaseId});
  assert.deepEqual(parseArguments(['reconcile', releaseId]), {command: 'reconcile', operation: releaseId});
  assert.throws(() => parseArguments(['reconcile']), /OPERATION_ID_REQUIRED/);
  assert.throws(() => parseArguments(['release', '--source', 'HEAD']), /SOURCE_SHA_REQUIRED/);
  assert.throws(() => parseArguments(['release', '--source', source, '--source', source]), /INVALID_OPTION/);
  assert.throws(() => parseArguments(['preview', '--slot', '03', '--source', source]), /INVALID_SLOT/);
  assert.deepEqual(parseArguments(['preview', '--slot', '01', '--source', source, '--expected', 'none']), {command: 'preview', slot: '01', source, expected: null});
});

test('status exposes both preview IDs without hiding operator status on slot read failure', async () => {
  const {ports, state} = fixture(); state.slot = {status: 'ready', current: {release_id: digest}};
  const original = ports.preview; ports.preview = request => request.slot === '02' ? Promise.reject(Error('UNMANAGED')) : original(request);
  const result = await main(['status'], ports);
  assert.equal(result.current.releaseId, base); assert.equal(result.previews['01'].current.release_id, digest);
  assert.equal(result.previews['02'].status, 'unavailable');
});

test('rollback identifies requested previous release and uses current release CAS', async () => {
  const {ports, state} = fixture(); state.current = {...state.current, releaseId: 'current'}; state.previous = {releaseId: base, sourceSha: oldSource};
  const result = await main(['rollback', '--release', base], ports, '/repository');
  assert.equal(result.current.releaseId, base); assert.ok(state.calls.some(c => c[0] === 'operator' && c[1] === 'rollback' && c[2] === 'current'));
});

test('reconcile requires matching operation and passes its ID to the locked helper', async () => {
  const {ports, state} = fixture(); state.operation = {releaseId, state: 'recovery-required'};
  await assert.rejects(main(['reconcile', base], ports), /RECONCILE_RELEASE_MISMATCH/);
  const result = await main(['reconcile', releaseId], ports);
  assert.equal(result.releaseId, releaseId); assert.ok(state.calls.some(c => c[0] === 'operator' && c[1] === 'reconcile' && c[2] === releaseId));
});

test('preview builds only web then seals, prepares and updates requested empty slot', async () => {
  const {ports, state} = fixture();
  const result = await preview({root: '/repository', source, slot: '02'}, ports);
  assert.equal(result.status, 'ready'); assert.equal(result.slot, '02');
  assert.deepEqual(state.calls.filter(c => c[0] === 'build').map(c => c[1]), [['web']]);
  assert.ok(!state.calls.some(c => c[0] === 'operator' && c[1] === 'apply'));
  assert.deepEqual(state.calls.filter(c => c[0] === 'preview').map(c => c[1].action), ['status', 'prepare', 'update']);
  assert.deepEqual(state.calls.filter(c => c[0] === 'preview').at(-1)[1], {action: 'update', source, slot: '02', expected: null});
});

test('occupied preview slot requires explicit exact expected ID before build', async () => {
  const {ports, state} = fixture(); state.slot = {status: 'ready', current: {release_id: digest}};
  await assert.rejects(preview({root: '/repository', source, slot: '01'}, ports), /PREVIEW_EXPECTED_REQUIRED/);
  await assert.rejects(preview({root: '/repository', source, slot: '01', expected: 'wrong'}, ports), /PREVIEW_STALE_BASE/);
  assert.ok(!state.calls.some(c => c[0] === 'build'));
});

test('preview rolled_back result exits with failure instead of claiming ready', async () => {
  const {ports} = fixture(), original = ports.preview;
  ports.preview = request => request.action === 'update' ? {status: 'rolled_back', current: {source: oldSource}} : original(request);
  await assert.rejects(preview({root: '/repository', source, slot: '01'}, ports), /PREVIEW_NOT_READY/);
});

test('real ready-files package integrates exact manifest hash and payload verification', async () => {
  const scratch = resolve('tmp'); mkdirSync(scratch, {recursive: true}); const root = mkdtempSync(join(scratch, 'dev-release-test-'));
  try {
    mkdirSync(join(root, 'services/fixture'), {recursive: true});
    writeFileSync(join(root, 'services/fixture/main.mjs'), 'export const value = 42;\n');
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages: {'': {name: 'fixture'}}}));
    const c = {id: 'fixture', directory: 'services/fixture', npm: {workspaces: []}, delivery: {kind: 'ready-files', files: ['services/fixture/main.mjs'], entrypoints: ['services/fixture/main.mjs'], smokeImports: []}};
    const artifact = await packageComponent(root, c, join(root, 'tmp/packages'));
    assert.equal(verifyPackage(artifact.path, 'fixture').payloadHash, artifact.payloadHash);
    const manifest = readFileSync(join(artifact.path, 'artifact-manifest.json'));
    const manifestSha = createHash('sha256').update(manifest).digest('hex'); assert.equal(manifestSha.length, 64);
    writeFileSync(join(artifact.path, 'services/fixture/main.mjs'), 'export const value = 43;\n');
    assert.throws(() => verifyPackage(artifact.path, 'fixture'), /IMMUTABLE_OUTPUT_MISMATCH/);
  } finally {rmSync(root, {recursive: true, force: true});}
});
