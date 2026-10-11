// ABOUTME: Проверяет долговечность, изоляцию и порядок прочтения через реальное хранилище.
// ABOUTME: Использует временные файлы и закрытый fake Codex; пользовательские данные не читает.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import Ajv from 'ajv';
import { openReadState } from '../dist/read-state.js';
import { createApplication } from '../dist/application.js';
import { validateCommand, validateReadState, commandSchema } from '../contracts/index.mjs';
import schema from '../schemas/messages.schema.json' with { type: 'json' };
import artifacts from '../../artifacts/schemas/messages.schema.json' with { type: 'json' };

async function fixture(t) {
  const directory = await mkdtemp(fileURLToPath(new URL('../../../tmp/read-state-', import.meta.url)));
  const path = join(directory, 'read-state.sqlite');
  const store = await openReadState(path);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, path, directory };
}
const mark = (messageId, lastMessageAt, extra = {}) => ({ ownerId: 'owner', projectId: 'p', threadId: 't', messageId, lastMessageAt, ...extra });

test('read marks survive restart, isolate owners/projects and return detached snapshots', async t => {
  const f = await fixture(t);
  await f.store.mark(mark('one', 10));
  await f.store.mark(mark('other', 20, { ownerId: 'other' }));
  await f.store.mark(mark('two', 20, { projectId: 'other' }));
  const view = await f.store.read('owner');
  assert.deepEqual(view, { marks: { 'p:t': ['one'], 'other:t': ['two'] } });
  view.marks['p:t'].push('mutated');
  assert.deepEqual(await f.store.read('nobody'), { marks: {} });
  await f.store.close();
  const reopened = await openReadState(f.path); t.after(() => reopened.close());
  assert.deepEqual(await reopened.read('owner'), { marks: { 'p:t': ['one'], 'other:t': ['two'] } });
  assert.deepEqual(await reopened.read('other'), { marks: { 'p:t': ['other'] } });
});
test('older reads and zero-time local imports cannot undo a newer final; ties and retries preserve IDs', async t => {
  const { store } = await fixture(t);
  await store.mark(mark('legacy', 0));
  await store.mark(mark('new', 20));
  await store.mark(mark('legacy', 0));
  await store.mark(mark('old', 10));
  await store.mark(mark('new', 20));
  assert.deepEqual(await store.read('owner'), { marks: { 'p:t': ['new', 'legacy', 'old'] } });
  await store.mark(mark('tie', 20));
  assert.deepEqual(await store.read('owner'), { marks: { 'p:t': ['new', 'legacy', 'old', 'tie'] } });
  await store.mark(mark('latest', 21));
  assert.deepEqual(await store.read('owner'), { marks: { 'p:t': ['latest'] } });
});
test('later final read from history can have a lower clock without losing either read', async t => {
  const { store } = await fixture(t);
  await store.mark(mark('live-old-final', 100));
  await store.mark(mark('history-new-final', 80));
  await store.mark(mark('live-old-final', 120));
  assert.deepEqual(await store.read('owner'), { marks: { 'p:t': ['live-old-final', 'history-new-final'] } });
});
test('concurrent marks serialize without losing chats', async t => {
  const { store } = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.mark(mark('id-' + i, i, { threadId: 't-' + i }))));
  assert.equal(Object.keys((await store.read('owner')).marks).length, 20);
});
test('two independent adapters see shared commits and preserve a newer mark', async t => {
  const f = await fixture(t);
  const second = await openReadState(f.path); t.after(() => second.close());
  await Promise.all([f.store.mark(mark('new', 50)), second.mark(mark('old', 10))]);
  assert.deepEqual(await second.read('owner'), { marks: { 'p:t': ['new', 'old'] } });
  await Promise.all([f.store.mark(mark('a', 20, { threadId: 'a' })), second.mark(mark('b', 20, { threadId: 'b' }))]);
  assert.deepEqual(await f.store.read('owner'), await second.read('owner'));
  assert.equal(Object.keys((await second.read('owner')).marks).length, 3);
});
test('two OS processes commit to the same SQLite state without replacing other chats', async t => {
  const f = await fixture(t);
  const program = `const {openReadState}=await import(process.argv[1]); const store=await openReadState(process.argv[2]);
    for(let i=0;i<12;i++) await store.mark({ownerId:'owner',projectId:'p',threadId:process.argv[3]+i,messageId:'m',lastMessageAt:1});
    await store.close();`;
  const worker = prefix => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, new URL('../dist/read-state.js', import.meta.url).href, f.path, prefix], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(error || 'worker failed: ' + code)));
  });
  await Promise.all([worker('dev-'), worker('prod-')]);
  assert.equal(Object.keys((await f.store.read('owner')).marks).length, 24);
});
test('locked storage has a bounded failure, keeps state and allows a later retry', async t => {
  const f = await fixture(t);
  await f.store.mark(mark('persisted', 1));
  const lock = new DatabaseSync(f.path);
  try {
    lock.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    await assert.rejects(f.store.mark(mark('rejected', 2)), error => error.code === 'UPSTREAM_UNAVAILABLE' && error.outcome === 'not-sent');
    assert.ok(performance.now() - started < 2000);
    assert.deepEqual(await f.store.read('owner'), { marks: { 'p:t': ['persisted'] } });
    lock.exec('ROLLBACK');
    await f.store.mark(mark('retry', 2));
    assert.deepEqual(await f.store.read('owner'), { marks: { 'p:t': ['retry'] } });
  } finally { lock.close(); }
});
test('capacity failure retains the previously persisted state', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 128; i++) await f.store.mark(mark('id-' + i, 1));
  await assert.rejects(f.store.mark(mark('overflow', 1)), error => error.code === 'CAPACITY_EXHAUSTED' && error.outcome === 'not-sent');
  assert.equal((await f.store.read('owner')).marks['p:t'].length, 128);
  await f.store.mark(mark('fresh', 2));
  assert.deepEqual(await f.store.read('owner'), { marks: { 'p:t': ['fresh'] } });
});
test('existing corrupt storage fails startup without replacing its bytes', async t => {
  const directory = await mkdtemp(fileURLToPath(new URL('../../../tmp/read-state-corrupt-', import.meta.url)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'invalid.sqlite');
  await writeFile(path, 'corrupt');
  await assert.rejects(openReadState(path));
  assert.equal((await readFile(path)).toString(), 'corrupt');
  await assert.rejects(openReadState('relative'));
});
test('read state belongs to the trusted owner, works with offline Codex and checks project scope', async t => {
  const f = await fixture(t);
  const codex = { status: () => ({ generation: 'offline', connection: 'disconnected', authorization: 'unavailable' }), subscribe: () => () => {}, call: () => assert.fail('read state must not call Codex') };
  const app = createApplication(codex, { ownerId: 'owner', projects: [{ projectId: 'p', name: 'P', cwd: '/tmp/p' }] }, () => {}, undefined, undefined, f.store);
  t.after(() => app.close());
  const command = { action: 'readMark', ...mark('id', 10) };
  assert.deepEqual(await app.request(command), { marks: { 'p:t': ['id'] } });
  assert.deepEqual(await app.request({ action: 'readState', ownerId: 'owner' }), { marks: { 'p:t': ['id'] } });
  await assert.rejects(app.request({ ...command, ownerId: 'other' }), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(app.request({ action: 'readState', ownerId: 'other' }), error => error.code === 'INVALID_ARGUMENT');
  await assert.rejects(app.request({ ...command, projectId: 'missing' }), error => error.code === 'NOT_FOUND');
  assert.deepEqual(await f.store.read('other'), { marks: {} });
});
test('DTO runtime and published schemas agree on closed read commands and bounded marks', () => {
  const ajv = new Ajv({ strict: false, schemas: [artifacts] });
  const validCommand = ajv.compile(commandSchema);
  const validState = ajv.compile({ ...schema, $ref: '#/definitions/ReadState' });
  assert.deepEqual(schema.definitions.Command.oneOf, commandSchema.oneOf);
  for (const command of [{ action: 'readState', ownerId: 'owner' }, { action: 'readMark', ...mark('m', 0) }]) {
    assert.equal(validateCommand(command), true); assert.equal(validCommand(command), true);
  }
  for (const command of [{ action: 'readState' }, { action: 'readState', ownerId: 'owner', generation: 'g' }, { action: 'readMark', ...mark('m', -1) }, { action: 'readMark', ...mark('m', 0.5) }, { action: 'readMark', ...mark('m', undefined) }, { action: 'readMark', ...mark('', 0) }]) {
    assert.equal(validateCommand(command), false); assert.equal(validCommand(command), false);
  }
  for (const state of [{ marks: {} }, { marks: { 'p:t': ['m'] } }]) { assert.equal(validateReadState(state), true); assert.equal(validState(state), true); }
  for (const state of [{ marks: { 'p:t': [] } }, { marks: { 'p:t': ['m', 'm'] } }, { marks: { 'p:t': 3 } }, { marks: {}, ownerId: 'other' }]) { assert.equal(validateReadState(state), false); assert.equal(validState(state), false); }
});
