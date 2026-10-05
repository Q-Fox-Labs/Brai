// ABOUTME: Предоставляет schema-valid Unix WebSocket fixture протокола Codex 0.160.
// ABOUTME: Сохраняет тестовые threads/items; не запускает модель или inference.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { schemaDirectory, validateEvent, validateParams, validateResult } from './native-contract.mjs';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const runId = process.env.BRAI_ACCEPTANCE_RUN_ID ?? '';
if (process.env.BRAI_ACCEPTANCE_GATE !== 'accepted' || !/^[0-9a-f]{40}$/.test(process.env.BRAI_ACCEPTANCE_SOURCE_REVISION ?? '')) throw new Error('Acceptance gate or exact source revision is missing');
assert.match(runId, /^[a-z0-9][a-z0-9-]{2,40}$/);
const root = resolve('tmp/artifacts-acceptance', runId, 'native-fixture');
const explicitSocket = process.env.BRAI_NATIVE_FIXTURE_SOCKET;
const socketPath = explicitSocket ? resolve(explicitSocket) : resolve(root, 'codex-v160.sock');
if (explicitSocket) assert.equal(socketPath, `/tmp/brai-native-${runId}/codex-v160.sock`);
assert.ok(Buffer.byteLength(socketPath) < 108, 'Use scoped BRAI_NATIVE_FIXTURE_SOCKET with a pre-created private directory');
const statePath = resolve(root, 'threads.json');
const schemaPath = schemaDirectory;
const holdMs = Number(process.env.BRAI_NATIVE_FIXTURE_HOLD_MS ?? 60000);
assert.ok(Number.isSafeInteger(holdMs) && holdMs >= 1000 && holdMs <= 60000);
const cwd = resolve(process.env.BRAI_NATIVE_FIXTURE_CWD ?? process.cwd());
let state = { threads: {} };
let sequence = 0;
const sockets = new Set();
const scheduledTurns = new Set();

await mkdir(root, { recursive: true, mode: 0o700 });
const socketDirectory = await lstat(dirname(socketPath));
assert.ok(socketDirectory.isDirectory() && !socketDirectory.isSymbolicLink() && socketDirectory.uid === process.getuid() && (socketDirectory.mode & 0o777) === 0o700);
try { const value = await lstat(socketPath); assert.ok(value.isSocket() && !value.isSymbolicLink() && value.uid === process.getuid()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
await rm(socketPath, { force: true });
try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
assert.ok(state && typeof state.threads === 'object' && !Array.isArray(state.threads));
sequence = Object.values(state.threads).reduce((count, record) => count + record.items.length, 0);
const http = createServer();
const wss = new WebSocketServer({ server: http, maxPayload: 2 * 1024 * 1024 });
wss.on('connection', socket => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
  socket.on('message', raw => void handle(socket, raw));
});
await new Promise((accept, reject) => {
  http.once('error', reject);
  http.listen(socketPath, () => { http.removeListener('error', reject); accept(); });
});
await chmod(socketPath, 0o600);
console.info(JSON.stringify({ fixture: 'fake-codex-native-v160', event: 'ready', runId, socketPath, durable: statePath, schema: schemaPath, inference: false }));

let stopping;
const stop = () => stopping ??= (async () => {
  for (const socket of sockets) socket.close(1001, 'fixture stopping');
  await new Promise(accept => wss.close(() => http.close(accept)));
  await rm(socketPath, { force: true });
})();
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
await new Promise(accept => { process.once('SIGINT', accept); process.once('SIGTERM', accept); });
await stop();

async function persist() {
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, statePath);
}

function reply(socket, id, method, result) {
  validateResult(method, result);
  socket.send(JSON.stringify({ id, result }));
}

function event(method, params) {
  const packet = { method, params };
  validateEvent(method, params);
  const encoded = JSON.stringify(packet);
  for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(encoded);
}

async function handle(socket, raw) {
  let message;
  try { message = JSON.parse(raw.toString()); } catch { socket.close(1007, 'invalid JSON'); return; }
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') return;
  if (message.id === undefined && ['initialized', 'notifications/cancelled'].includes(message.method)) return;
  try { validateParams(message.method, message.params); } catch (error) {
    if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, error: { code: -32602, message: error.message } }));
    return;
  }
  try {
    if (message.method === 'initialize') {
      reply(socket, message.id, message.method, { codexHome: root, platformFamily: 'unix', platformOs: process.platform, userAgent: 'codex-cli 0.160.0 acceptance fixture' });
    } else if (message.method === 'account/read') {
      reply(socket, message.id, message.method, { account: { type: 'apiKey' }, requiresOpenaiAuth: false, workspaceRouting: null });
    } else if (message.method === 'account/rateLimits/read') {
      reply(socket, message.id, message.method, { rateLimits: { credits: null, individualLimit: null, limitId: null, limitName: null, normalModelSlug: null, planType: null, primary: null, rateLimitReachedType: null, secondary: null, spendControlReached: null } });
    } else if (message.method === 'config/read') {
      reply(socket, message.id, message.method, { config: {}, origins: {} });
    } else if (message.method === 'model/list') {
      reply(socket, message.id, message.method, { data: [{ defaultReasoningEffort: 'medium', description: 'Synthetic fixture model; no inference.', displayName: 'Fixture model', hidden: false, id: 'fixture-model', inputModalities: ['text', 'image'], isDefault: true, model: 'fixture-model', supportedReasoningEfforts: [{ description: 'Fixture setting', reasoningEffort: 'medium' }] }], nextCursor: null });
    } else if (message.method === 'thread/list') {
      reply(socket, message.id, message.method, { data: Object.values(state.threads).map(record => record.thread), nextCursor: null, backwardsCursor: null });
    } else if (message.method === 'thread/start') {
      const id = randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const thread = {
        cliVersion: '0.160.0', createdAt: now, cwd: message.params.cwd ?? cwd, ephemeral: false,
        id, model: message.params.model ?? 'fixture-model', modelProvider: 'fixture', name: 'Acceptance fixture',
        preview: '', projectId: null, sessionId: randomUUID(), source: 'appServer',
        status: { type: 'idle' }, turns: [], updatedAt: now,
      };
      state.threads[id] = { thread, items: [], activeTurn: null, goal: null };
      await persist();
      reply(socket, message.id, message.method, {
        approvalPolicy: message.params.approvalPolicy ?? 'never', approvalsReviewer: message.params.approvalsReviewer ?? 'user',
        cwd: thread.cwd, model: thread.model, modelProvider: thread.modelProvider,
        sandbox: { type: 'readOnly', networkAccess: false }, thread,
      });
    } else if (message.method === 'thread/resume') {
      const record = threadRecord(message.params.threadId);
      reply(socket, message.id, message.method, {
        approvalPolicy: message.params.approvalPolicy ?? 'never', approvalsReviewer: message.params.approvalsReviewer ?? 'user',
        cwd: record.thread.cwd, model: record.thread.model ?? 'fixture-model', modelProvider: record.thread.modelProvider,
        sandbox: { type: 'readOnly', networkAccess: false }, thread: { ...record.thread, turns: message.params.excludeTurns ? [] : record.thread.turns },
      });
      if (record.activeTurn) {
        const active = record.thread.turns.find(turn => turn.id === record.activeTurn);
        assert.ok(active && active.status === 'inProgress');
        scheduleFinish(record, active);
      }
    } else if (message.method === 'thread/read') {
      const record = threadRecord(message.params.threadId);
      const thread = { ...record.thread, turns: message.params.includeTurns ? record.thread.turns : [] };
      reply(socket, message.id, message.method, { thread });
    } else if (message.method === 'thread/turns/list') {
      const record = threadRecord(message.params.threadId);
      reply(socket, message.id, message.method, { data: record.thread.turns, nextCursor: null, backwardsCursor: null });
    } else if (message.method === 'thread/items/list') {
      const record = threadRecord(message.params.threadId);
      reply(socket, message.id, message.method, itemPage(record, message.params));
    } else if (message.method === 'thread/name/set') {
      const record = threadRecord(message.params.threadId);
      record.thread.name = message.params.name;
      await persist();
      reply(socket, message.id, message.method, {});
    } else if (message.method === 'thread/archive') {
      const record = threadRecord(message.params.threadId);
      record.thread.status = { type: 'notLoaded' };
      await persist();
      reply(socket, message.id, message.method, {});
    } else if (message.method === 'thread/goal/get') {
      reply(socket, message.id, message.method, { goal: threadRecord(message.params.threadId).goal ?? null });
    } else if (message.method === 'thread/goal/set') {
      const record = threadRecord(message.params.threadId);
      const goal = fixtureGoal(record, message.params);
      validateResult('thread/goal/set', { goal });
      record.goal = goal;
      await persist();
      reply(socket, message.id, message.method, { goal });
    } else if (message.method === 'thread/goal/clear') {
      const record = threadRecord(message.params.threadId);
      const cleared = (record.goal ?? null) !== null;
      record.goal = null;
      await persist();
      reply(socket, message.id, message.method, { cleared });
    } else if (message.method === 'thread/settings/update') {
      reply(socket, message.id, message.method, {});
    } else if (message.method === 'thread/unsubscribe') {
      reply(socket, message.id, message.method, { status: 'unsubscribed' });
    } else if (message.method === 'turn/start') {
      const turnId = randomUUID();
      const record = threadRecord(message.params.threadId);
      const turn = { id: turnId, items: [], status: 'inProgress', startedAt: Math.floor(Date.now() / 1000) };
      record.activeTurn = turnId;
      record.thread.status = { type: 'active', activeFlags: [] };
      record.thread.updatedAt = Math.floor(Date.now() / 1000);
      record.thread.preview ||= 'Acceptance fixture message';
      record.thread.turns.push(turn);
      const inputItem = await appendInput(record, turnId, message.params);
      event('turn/started', { threadId: record.thread.id, turn });
      event('item/started', { threadId: record.thread.id, turnId, item: inputItem, startedAtMs: Date.now() });
      reply(socket, message.id, message.method, { turn });
      scheduleFinish(record, turn);
    } else if (message.method === 'turn/steer') {
      const record = threadRecord(message.params.threadId);
      if (!record.activeTurn || record.activeTurn !== message.params.expectedTurnId) {
        socket.send(JSON.stringify({ id: message.id, error: { code: -32602, message: 'Expected active turn does not match' } }));
        return;
      }
      const inputItem = await appendInput(record, record.activeTurn, message.params);
      event('item/started', { threadId: record.thread.id, turnId: record.activeTurn, item: inputItem, startedAtMs: Date.now() });
      reply(socket, message.id, message.method, { turnId: record.activeTurn });
    } else if (message.method === 'turn/interrupt') {
      const record = threadRecord(message.params.threadId);
      if (record.activeTurn === message.params.turnId) record.activeTurn = null;
      reply(socket, message.id, message.method, {});
    }
  } catch (error) {
    if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, error: { code: -32603, message: error.message } }));
  }
}

function threadRecord(threadId) {
  const record = state.threads[threadId];
  if (!record) throw new Error('Thread not found in fixture store');
  return record;
}

function fixtureGoal(record, params) {
  const previous = record.goal ?? null;
  const now = Math.floor(Date.now() / 1000);
  const objective = params.objective ?? previous?.objective;
  assert.equal(typeof objective, 'string', 'An explicit objective is required for a new goal');
  return {
    ...(previous ?? { createdAt: now, timeUsedSeconds: 0, tokensUsed: 0 }),
    objective, status: params.status ?? previous?.status ?? 'active',
    threadId: record.thread.id, updatedAt: now,
    ...(Object.hasOwn(params, 'tokenBudget') ? { tokenBudget: params.tokenBudget } : {}),
  };
}

async function appendInput(record, turnId, params) {
  const id = `fixture-item-${++sequence}`;
  const item = { id, type: 'userMessage', clientId: params.clientUserMessageId ?? null, content: params.input };
  record.items.push({ item, turnId });
  const turn = record.thread.turns.find(entry => entry.id === turnId);
  turn.items.push(item);
  await persist();
  return item;
}

function scheduleFinish(record, turn) {
  const turnId = turn.id;
  if (scheduledTurns.has(turnId)) return;
  scheduledTurns.add(turnId);
  const remainingHold = Math.max(0, holdMs - (Date.now() - turn.startedAt * 1000));
  setTimeout(async () => {
    scheduledTurns.delete(turnId);
    if (!record.activeTurn || record.activeTurn !== turnId) return;
    turn.status = 'completed';
    turn.completedAt = Math.floor(Date.now() / 1000);
    record.activeTurn = null;
    record.thread.status = { type: 'idle' };
    record.thread.updatedAt = Math.floor(Date.now() / 1000);
    await persist();
    for (const entry of record.items.filter(item => item.turnId === turnId)) {
      event('item/completed', { threadId: record.thread.id, turnId, item: entry.item, completedAtMs: Date.now() });
    }
    event('turn/completed', { threadId: record.thread.id, turn: { ...turn, status: 'completed' } });
  }, remainingHold).unref();
}

function itemPage(record, params) {
  const direction = params.sortDirection ?? 'asc';
  const limit = params.limit ?? 100;
  assert.ok(direction === 'asc' || direction === 'desc');
  assert.ok(Number.isSafeInteger(limit) && limit >= 0);
  const turnId = params.turnId ?? null;
  const visible = record.items.filter(entry => turnId === null || entry.turnId === turnId);
  const ordered = direction === 'desc' ? [...visible].reverse() : visible;
  let anchorId;
  if (typeof params.cursor === 'string') {
    assert.ok(params.cursor.startsWith('fixture-items-v1:') && params.cursor.length <= 2048);
    const encoded = params.cursor.slice('fixture-items-v1:'.length);
    const bytes = Buffer.from(encoded, 'base64url');
    assert.equal(bytes.toString('base64url'), encoded);
    const cursor = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(Object.keys(cursor).sort(), ['itemId', 'threadId', 'turnId']);
    assert.equal(cursor.threadId, record.thread.id);
    assert.equal(cursor.turnId, turnId);
    assert.equal(typeof cursor.itemId, 'string');
    anchorId = cursor.itemId;
  } else if (params.cursor !== undefined && params.cursor !== null) {
    assert.ok(turnId && params.cursor.type === 'item');
    anchorId = params.cursor.itemId;
  }
  let offset = 0;
  if (anchorId !== undefined) {
    const position = ordered.findIndex(entry => entry.item.id === anchorId);
    assert.ok(position >= 0, 'Cursor item is outside the requested visible history');
    offset = position + 1;
  }
  const page = ordered.slice(offset, offset + limit);
  const encode = entry => `fixture-items-v1:${Buffer.from(JSON.stringify({ threadId: record.thread.id, turnId, itemId: entry.item.id })).toString('base64url')}`;
  return {
    data: page.map(entry => ({ item: entry.item, turnId: entry.turnId })),
    nextCursor: page.length && offset + page.length < ordered.length ? encode(page.at(-1)) : null,
    backwardsCursor: page.length ? encode(page[0]) : null,
  };
}
