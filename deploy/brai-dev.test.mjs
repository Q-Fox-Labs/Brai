// ABOUTME: Проверяет выбор компонентов и полный путь DEV-выпуска через изолированные порты.
// ABOUTME: Не вызывает привилегированные helper, Docker, live DEV, PROD или пользовательскую БД.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {assertSource, assertAncestry, schemaRef, manifestInfo, selectComponents, release, preview, main, parseArguments, waitForOperation, localPorts} from './brai-dev.mjs';
import {execFileSync} from 'node:child_process';
import {packageComponent, verifyPackage} from './components/package-runtime.mjs';
import {createHash} from 'node:crypto';

const source = 'a'.repeat(40), oldSource = 'b'.repeat(40), digest = 'd'.repeat(64);
const releaseId = '2f72cb35-62f6-47b8-8bde-83005bf2e6de', base = '3794fd23-d27d-45e9-a952-607b4a59b6c4';
const keys = suffix => ({build: `build-${suffix}`, artifact: `artifact-${suffix}`, runtime: `runtime-${suffix}`, checks: `checks-${suffix}`});
const component = (id, deps = []) => ({id, status: 'active', environments: ['dev'], dependencies: deps.map(id => ({id})), directory: `services/${id}`});

test('candidate pins exact commit without replacing an existing release ref', async t => {
  const root=mkdtempSync('/tmp/brai-release-pin-');t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
  git('init','-q');writeFileSync(join(root,'file'),'one');git('add','file');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const commit=git('rev-parse','HEAD'),ports=await localPorts();
  await ports.saveCandidate(root,{sourceSha:commit,releaseId});
  assert.equal(git('rev-parse',`refs/brai-dev/releases/${releaseId}`),commit);
  await assert.rejects(ports.saveCandidate(root,{sourceSha:commit,releaseId}));
});

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
    assertAncestry: async (_root, accepted, candidate) => {calls.push(['ancestry', accepted, candidate]);},
    graph: async (_root, ref) => {calls.push(['graph', ref]); return graph;},
    fingerprint: async (_root, c) => next[c.id],
    sourceFingerprints: async (_root, ref, scoped) => {calls.push(['baseline', ref, [...scoped.components.keys()]]); return Object.fromEntries(scoped.order.map(id => [id, keys(id)]));},
    execute: async (_root, action, ids, options) => {calls.push([action, ids, options]); return ids.map(id => ({id, checked: action === 'run', checkProof: 'executed', artifact: action === 'run' ? {path: `/packages/${id}`, payloadHash: digest} : undefined}));},
    manifestInfo: async () => ({sha256:'e'.repeat(64),schemaRef:'schema-v1'}),
    saveCandidate: async (_root, candidate) => {state.candidate = candidate; calls.push(['candidate', candidate]); return '/candidate.json';},
    operator: async (action, arg) => {
      calls.push(['operator', action, arg]);
      if (action === 'status') return {current: state.current, previous: state.previous, operation: state.operation, supportedComponents};
      if (action === 'seal') return state.candidate;
      if (action === 'apply') {state.operation = {releaseId, action:'apply', sourceSha:source, state: 'accepted', timings: [{phase: 'smoke', durationMs: 4}]}; state.current = {releaseId, sourceSha: source, components: state.candidate.components}; return {releaseId, state: 'queued'};}
      if (action === 'rollback') {state.operation = {releaseId, action:'rollback', sourceSha:state.previous.sourceSha, targetReleaseId:state.previous.releaseId, state: 'rolled-back'}; state.current = state.previous; return {releaseId};}
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
  assert.deepEqual(state.calls.filter(c => c[0] === 'run').map(c => c.slice(0, 2)), [
    ['run', ['auth']], ['run', ['web']],
  ]);
  for (const call of state.calls.filter(c => c[0] === 'run')) assert.deepEqual(call[2], {base: oldSource, includeDependencies: false});
  assert.equal(state.candidate.components[0].artifact.digest, `sha256:${digest}`);
  assert.deepEqual(state.candidate.components[0].checks, [{kind: 'artifact-manifest', sha256: 'e'.repeat(64)}]);
  assert.deepEqual(state.candidate.components[0].schema, {before: 'schema-v1', after: 'schema-v1', rollbackCompatible: true});
  assert.ok(result.timings.some(t => t.phase === 'prepare' && t.component === 'auth'));
  assert.deepEqual(result.operatorTimings, [{phase: 'smoke', durationMs: 4}]); assert.equal(state.report.state, 'accepted');
});

test('prepare-only returns the actual candidate without applying or waiting', async () => {
  const {ports,state}=fixture();
  const result=await release({root:'/repository',source,prepareOnly:true},ports);
  assert.equal(result.state,'prepared');assert.equal(result.releaseId,releaseId);
  assert.equal(result.expectedBase,base);assert.equal(result.candidatePath,'/candidate.json');
  assert.deepEqual(result.components,['auth','web']);
  assert.ok(!state.calls.some(call=>call[0]==='operator'&&call[1]!=='status'));
  assert.equal(state.current.releaseId,base);
});

test('release reports its historical acceptance when a later release is already current', async () => {
  const {ports,state}=fixture(), original=ports.operator;
  const later='2c7836fe-e0c0-4224-a1f4-9d845c1f5010';
  ports.operator=async (action,id)=>{
    const value=await original(action,id);
    if(action==='status' && id===releaseId) return {...value,current:{...value.current,releaseId:later}};
    return value;
  };
  const result=await release({root:'/repository',source},ports);
  assert.equal(result.state,'accepted');assert.equal(result.releaseId,releaseId);assert.equal(result.currentDesiredReleaseId,later);
  assert.ok(state.calls.some(row=>row[0]==='operator'&&row[1]==='status'&&row[2]===releaseId));
});

test('historical acceptance must match the source and action', async () => {
  for(const field of ['sourceSha','action']) {
    const {ports}=fixture(), original=ports.operator;
    ports.operator=async (action,id)=>{
      const value=await original(action,id);
      return action==='status'&&id===releaseId?{...value,operation:{...value.operation,[field]:'wrong'}}:value;
    };
    await assert.rejects(release({root:'/repository',source},ports),/OPERATION_IDENTITY_MISMATCH/);
  }
});

test('candidate uses accepted migration ref before and packaged migration ref after', async () => {
  const {ports,state}=fixture();
  ports.manifestInfo=async (_path,id)=>({sha256:'e'.repeat(64),schemaRef:id==='auth'?'sha256:new':'schema-v1'});
  await release({root:'/repository',source},ports);
  assert.deepEqual(state.candidate.components[0].schema,{before:'schema-v1',after:'sha256:new',rollbackCompatible:true});
});

test('migration ref matches Root encoding and includes only migration rows', () => {
  const row=(path,letter,size,mode)=>({path,sha256:letter.repeat(64),size,mode});
  const rows=[row('services/тест/migrations/001.sql','a',7,420),row('services/x/migrate.mjs','b',8,493),row('services/x/aux.sql','c',9,420),row('services/x/migrations/readme.md','d',10,420)];
  const manifest={files:[rows[0],row('services/x/main.mjs','e',3,420),...rows.slice(1)]};
  assert.equal(schemaRef(manifest),'sha256:ec71034d31652a1503299214a9412eaa0975ff0960d617beb424af7ee14ecadf');
  assert.equal(schemaRef({files:[]}), 'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
  assert.notEqual(schemaRef({...manifest,files:[...manifest.files].reverse()}),schemaRef(manifest));
  assert.notEqual(schemaRef({files:[{...rows[0],mode:493}]}),schemaRef({files:[rows[0]]}));
  assert.throws(()=>schemaRef({files:[{}]}),/ARTIFACT_MANIFEST_INVALID/);
});

test('accepted fingerprint fallback uses the accepted source, never remote branch', async () => {
  const {ports, state} = fixture(); delete state.current.components.auth.fingerprints;
  await release({root: '/repository', source}, ports);
  assert.ok(state.calls.some(c => c[0] === 'baseline' && c[1] === oldSource));
  assert.ok(!JSON.stringify(state.calls).includes('origin/dev'));
});

test('mixed observed baseline requires explicit initial composition reconciliation', async () => {
  const {ports, state} = fixture(), otherSource = 'c'.repeat(40);
  state.current.sourceSha = null;
  state.current.provenance = {kind: 'observed-dev-baseline-v1'};
  state.current.components.auth = {sourceSha: oldSource};
  state.current.components.web = {sourceSha: oldSource};
  state.current.components.timer = {sourceSha: otherSource};
  state.graph.components.set('new-service', component('new-service'));
  state.graph.order.push('new-service'); state.next['new-service'] = keys('new-service');
  state.supportedComponents['new-service'] = {supported: true, handler: 'compose-payload'};
  state.next.auth = keys('auth');
  await assert.rejects(release({root: '/repository', source}, ports), /INITIAL_COMPOSITION_RECONCILE_REQUIRED/);
  assert.ok(!state.calls.some(c => ['graph', 'baseline', 'run', 'candidate'].includes(c[0])));
});

test('installed component without valid source provenance fails before build', async () => {
  for (const invalid of ['dev']) {
    const {ports, state} = fixture();
    state.current.components.auth.sourceSha = invalid;
    await assert.rejects(release({root: '/repository', source}, ports), /ACCEPTED_SOURCE_INVALID: auth/);
    assert.ok(!state.calls.some(call => call[0] === 'run' || call[0] === 'baseline'));
  }
});

test('divergent source is rejected before graph, build and apply', async () => {
  const {ports,state}=fixture();
  ports.assertAncestry=async()=>{throw Error('SOURCE_NOT_DESCENDANT');};
  await assert.rejects(release({root:'/repository',source},ports),/SOURCE_NOT_DESCENDANT/);
  assert.ok(!state.calls.some(c=>['graph','run','candidate'].includes(c[0])));
  assert.ok(!state.calls.some(c=>c[0]==='operator' && c[1]==='apply'));
});

test('actual Git history permits descendants and rejects a diverged branch', t => {
  const root=mkdtempSync('/tmp/brai-ancestry-');t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const commit=message=>git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm',message);
  git('init','-q');writeFileSync(join(root,'file'),'base');git('add','file');commit('base');
  const baseCommit=git('rev-parse','HEAD');
  writeFileSync(join(root,'file'),'accepted');git('add','file');commit('accepted');const accepted=git('rev-parse','HEAD');
  writeFileSync(join(root,'file'),'descendant');git('add','file');commit('descendant');const descendant=git('rev-parse','HEAD');
  assert.doesNotThrow(()=>assertAncestry(root,accepted,descendant));
  git('checkout','--detach','-q',baseCommit);writeFileSync(join(root,'file'),'divergent');git('add','file');commit('divergent');
  assert.throws(()=>assertAncestry(root,accepted,git('rev-parse','HEAD')),/SOURCE_NOT_DESCENDANT/);
  assert.throws(()=>assertAncestry(root,'f'.repeat(40),descendant),/ANCESTRY_CHECK_FAILED/);
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
  assert.equal(state.candidate, null); assert.ok(!state.calls.some(c => c[0] === 'run'));
});

test('unsupported changed handler fails before build, candidate, seal or apply', async () => {
  const {ports, state} = fixture(); state.supportedComponents.web = {supported: false, handler: 'native-program'};
  await assert.rejects(release({root: '/repository', source}, ports), /UNSUPPORTED_HANDLER: web/);
  assert.equal(state.candidate, null); assert.ok(!state.calls.some(c => c[0] === 'run'));
});

test('retired accepted component cannot disappear into successful unchanged result', async () => {
  const {ports, state} = fixture(); state.graph.components.get('auth').status = 'retired'; state.graph.order = ['web', 'timer'];
  await assert.rejects(release({root: '/repository', source}, ports), /UNSUPPORTED_RETIREMENT: auth/);
  assert.equal(state.candidate, null); assert.ok(!state.calls.some(c => c[0] === 'run'));
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
  assert.ok(!state.calls.some(c => c[0] === 'run'));
});

test('base changing during build blocks candidate and apply', async () => {
  const {ports, state} = fixture(), original = ports.execute;
  ports.execute = async (...args) => {const result = await original(...args); state.current = {...state.current, releaseId: 'new-base'}; return result;};
  await assert.rejects(release({root: '/repository', source}, ports), /STALE_BASE/);
  assert.equal(state.candidate, null); assert.ok(!state.calls.some(c => c[0] === 'operator' && c[1] === 'apply'));
});

test('failed component check stops before package and apply with recorded duration', async () => {
  const {ports, state} = fixture(), original = ports.execute;
  ports.execute = async (...args) => {if (args[1] === 'run') throw Error('CHECK_FAILED'); return original(...args);};
  await assert.rejects(release({root: '/repository', source}, ports), error => {assert.equal(error.report.timings.at(-1).state, 'failed'); return /CHECK_FAILED/.test(error.message);});
  assert.equal(state.candidate, null); assert.ok(!state.calls.some(c => c[0] === 'operator' && c[1] === 'apply'));
});

test('release accepts a verified cached check and rejects an unproven result', async () => {
  const {ports} = fixture(), original = ports.execute;
  ports.execute = async (...args) => (await original(...args)).map(row => ({...row, checkProof: 'cached'}));
  assert.equal((await release({root: '/repository', source}, ports)).state, 'accepted');
  const missing = fixture(), execute = missing.ports.execute;
  missing.ports.execute = async (...args) => (await execute(...args)).map(row => ({...row, checkProof: undefined}));
  await assert.rejects(release({root: '/repository', source}, missing.ports), /CHECK_NOT_EXECUTED/);
  assert.equal(missing.state.candidate, null);
});

test('package corruption never reaches apply', async () => {
  const {ports, state} = fixture(); ports.execute = () => {throw Error('IMMUTABLE_OUTPUT_MISMATCH');};
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
  assert.ok(!state.calls.some(c => c[0] === 'run'));
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

test('rollback verifies historical target when a later release is current', async () => {
  const {ports,state}=fixture(),original=ports.operator;
  state.previous={releaseId:base,sourceSha:oldSource};
  ports.operator=async (action,id)=>{
    const value=await original(action,id);
    return action==='status'&&id===releaseId?{...value,current:{releaseId:'later'}}:value;
  };
  const result=await main(['rollback','--release',base],ports,'/repository');
  assert.equal(result.operation.targetReleaseId,base);assert.equal(result.currentDesiredReleaseId,'later');
});

test('rollback requires target proof even if global current matches', async () => {
  const {ports,state}=fixture(),original=ports.operator;
  state.previous={releaseId:base,sourceSha:oldSource};
  ports.operator=async (action,id)=>{
    const value=await original(action,id);
    return action==='status'&&id===releaseId?{...value,operation:{...value.operation,targetReleaseId:undefined}}:value;
  };
  await assert.rejects(main(['rollback','--release',base],ports,'/repository'),/ROLLBACK_NOT_ACCEPTED/);
});

test('reconcile requires matching operation and passes its ID to the locked helper', async () => {
  const {ports, state} = fixture(); state.operation = {releaseId, state: 'recovery-required'};
  await assert.rejects(main(['reconcile', base], ports), /RECONCILE_RELEASE_MISMATCH/);
  const result = await main(['reconcile', releaseId], ports);
  assert.equal(result.releaseId, releaseId); assert.ok(state.calls.some(c => c[0] === 'operator' && c[1] === 'reconcile' && c[2] === releaseId));
});

test('reconcile addresses accepted program history after a newer instruction release', async () => {
  const {ports, state} = fixture();
  const calls = [];
  state.operation = {releaseId, state: 'accepted'};
  ports.operator = async (action, id) => {
    calls.push([action, id]);
    if (action === 'status') {
      assert.equal(id, base);
      return {current: {releaseId}, operation: {releaseId: base, state: 'accepted'}};
    }
    assert.equal(action, 'reconcile'); assert.equal(id, base);
    return {releaseId: base, pendingReconcile: 'queued'};
  };
  assert.deepEqual(await main(['reconcile', base], ports), {releaseId: base, pendingReconcile: 'queued'});
  assert.deepEqual(calls, [['status', base], ['reconcile', base]]);
});

test('reconcile rejects absent or incorrectly scoped history without a privileged effect', async () => {
  for (const operation of [null, {releaseId, state: 'accepted'}]) {
    const {ports} = fixture();
    const calls = [];
    ports.operator = async (action, id) => {
      calls.push([action, id]);
      assert.equal(action, 'status'); assert.equal(id, base);
      return {operation};
    };
    await assert.rejects(main(['reconcile', base], ports), /RECONCILE_RELEASE_MISMATCH/);
    assert.deepEqual(calls, [['status', base]]);
  }
});

test('preview builds only web then seals, prepares and updates requested empty slot', async () => {
  const {ports, state} = fixture();
  const result = await preview({root: '/repository', source, slot: '02'}, ports);
  assert.equal(result.status, 'ready'); assert.equal(result.slot, '02');
  assert.deepEqual(state.calls.filter(c => c[0] === 'run').map(c => c[1]), [['web']]);
  assert.ok(!state.calls.some(c => c[0] === 'operator' && c[1] === 'apply'));
  assert.deepEqual(state.calls.filter(c => c[0] === 'preview').map(c => c[1].action), ['status', 'prepare', 'update']);
  assert.deepEqual(state.calls.filter(c => c[0] === 'preview').at(-1)[1], {action: 'update', source, slot: '02', expected: null});
});

test('occupied preview slot requires explicit exact expected ID before build', async () => {
  const {ports, state} = fixture(); state.slot = {status: 'ready', current: {release_id: digest}};
  await assert.rejects(preview({root: '/repository', source, slot: '01'}, ports), /PREVIEW_EXPECTED_REQUIRED/);
  await assert.rejects(preview({root: '/repository', source, slot: '01', expected: 'wrong'}, ports), /PREVIEW_STALE_BASE/);
  assert.ok(!state.calls.some(c => c[0] === 'run'));
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
    mkdirSync(join(root, 'services/fixture/migrations'));
    writeFileSync(join(root, 'services/fixture/migrations/001.sql'), 'CREATE TABLE fixture (id integer);\n');
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, packages: {'': {name: 'fixture'}}}));
    const c = {id: 'fixture', directory: 'services/fixture', npm: {workspaces: []}, delivery: {kind: 'ready-files', files: ['services/fixture/main.mjs','services/fixture/migrations'], entrypoints: ['services/fixture/main.mjs'], smokeImports: []}};
    const artifact = await packageComponent(root, c, join(root, 'tmp/packages'));
    assert.equal(verifyPackage(artifact.path, 'fixture').payloadHash, artifact.payloadHash);
    const manifest = readFileSync(join(artifact.path, 'artifact-manifest.json'));
    const manifestSha = createHash('sha256').update(manifest).digest('hex'); assert.equal(manifestSha.length, 64);
    assert.deepEqual(manifestInfo(artifact.path,'fixture',artifact.payloadHash),{sha256:manifestSha,schemaRef:schemaRef(JSON.parse(manifest))});
    assert.notEqual(manifestInfo(artifact.path,'fixture',artifact.payloadHash).schemaRef,schemaRef({files:[]}));
    assert.throws(()=>manifestInfo(artifact.path,'other',artifact.payloadHash),/ARTIFACT_MANIFEST_INVALID/);
    writeFileSync(join(artifact.path, 'services/fixture/main.mjs'), 'export const value = 43;\n');
    assert.throws(() => verifyPackage(artifact.path, 'fixture'), /IMMUTABLE_OUTPUT_MISMATCH/);
  } finally {rmSync(root, {recursive: true, force: true});}
});


test('planner compares logical fingerprints while retaining actual program fingerprints', async () => {
  const {ports, state} = fixture();
  state.current.components.auth.fingerprints = keys('previous-program');
  state.current.components.auth.comparisonFingerprints = state.next.auth;
  const result = await release({root:'/repo', source}, ports);
  assert.equal(result.state, 'unchanged');
  assert.equal(state.current.components.auth.fingerprints.build, keys('previous-program').build);
});
