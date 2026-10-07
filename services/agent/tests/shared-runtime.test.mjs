// ABOUTME: Проверяет два Agent на разных NATS с общим native backend и artifacts транспортом.
// ABOUTME: Использует только явные loopback fixtures и собственные socket/proxy; Codex и inference не запускает.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { connect, headers, ServiceErrorHeader, ServiceErrorCodeHeader } from 'nats';
import { startAgent } from '../dist/main.js';
import { subjects as agentSubjects } from '../contracts/index.mjs';
import { subjects, validateRequest, validateResponse } from '../../artifacts/contracts/index.mjs';
const firstUrl = process.env.AGENT_TEST_NATS_A_URL, secondUrl = process.env.AGENT_TEST_NATS_B_URL;
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture resource did not close within five seconds')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); } throw new Error('Fixture did not recover within five seconds'); }

test('real two-broker Agent reserve, native lost ACK, dependencies and artifacts reconnect', { skip: !firstUrl || !secondUrl, timeout: 30000 }, async () => {
  for (const [value, port] of [[firstUrl, '24621'], [secondUrl, '24622']]) {
    const url = new URL(value); assert.equal(url.protocol, 'nats:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, port);
  }
  const directory = await mkdtemp(join(fileURLToPath(new URL('../../../tmp/', import.meta.url)), 'agent-shared-'));
  const nativeServer = createHttpServer(), sockets = new Set(), wss = new WebSocketServer({ server: nativeServer });
  const history = [], calls = [], refs = new Map(); let lostAck = false, lostReserve = false, turnStatus = 'completed';
  const thread = { id: 'shared-native', name: 'Shared fixture', cliVersion: 'test', createdAt: 1, cwd: '/fixture', ephemeral: false, model: 'vision', modelProvider: 'openai', preview: '', projectId: null, sessionId: 'fixture', source: 'appServer', status: { type: 'idle' }, turns: [], updatedAt: 1 };
  const response = { thread, model: 'vision', modelProvider: 'openai', cwd: '/fixture', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: { type: 'workspaceWrite' } };
  wss.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('message', raw => {
      const packet = JSON.parse(raw.toString()); if (!Object.hasOwn(packet, 'id')) return;
      const { method, params } = packet; let result;
      if (method === 'initialize') result = { codexHome: '/fixture', platformFamily: 'unix', platformOs: 'linux', userAgent: 'fixture' };
      else if (method === 'account/read') result = { account: { type: 'apiKey' }, requiresOpenaiAuth: false };
      else if (method === 'account/rateLimits/read') result = { rateLimits: {} };
      else if (method === 'thread/start' || method === 'thread/resume') result = response;
      else if (method === 'thread/read') result = { thread };
      else if (method === 'thread/goal/get') result = { goal: null };
      else if (method === 'thread/turns/list') result = { data: [{ id: 'turn', status: turnStatus, items: [] }], nextCursor: null };
      else if (method === 'thread/items/list') result = { data: history.slice().reverse(), nextCursor: null };
      else if (method === 'model/list') result = { data: [{ id: 'vision', model: 'vision', displayName: 'Vision', description: '', hidden: false, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }] }], nextCursor: null };
      else if (method === 'turn/start' || method === 'turn/steer') {
        calls.push({ method, params }); turnStatus = 'inProgress';
        history.push({ turnId: 'turn', item: { id: 'native-' + history.length, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input } });
        if (lostAck) { lostAck = false; socket.terminate(); return; }
        result = method === 'turn/start' ? { turn: { id: 'turn', status: 'inProgress', items: [] } } : { turnId: 'turn' };
      } else throw new Error(method);
      socket.send(JSON.stringify({ id: packet.id, result }));
    });
  });
  const proxySockets = new Set();
  const upstream = new URL(firstUrl);
  const proxy = createTcpServer(client => {
    const remote = tcpConnect({ host: upstream.hostname, port: Number(upstream.port) });
    proxySockets.add(client); proxySockets.add(remote);
    client.pipe(remote); remote.pipe(client);
    for (const socket of [client, remote]) { socket.on('error', () => {}); socket.on('close', () => { proxySockets.delete(socket); client.destroy(); remote.destroy(); }); }
  });
  let a, b, na, nb, service;
  const key = scope => JSON.stringify([scope.ownerId, scope.projectId, scope.threadId, scope.operationId]);
  const installArtifacts = async () => {
    service = await na.services.add({ name: 'brai_artifacts', version: '1.0.0', queue: 'agent_shared_fixture' });
    for (const subject of [subjects.referenceGet, subjects.referenceReserve, subjects.referenceConfirm, subjects.referenceUpdateState, subjects.referenceList]) service.addEndpoint(subject.split('.').at(-1), { subject, handler: (_error, message) => {
      const value = JSON.parse(Buffer.from(message.data).toString()); assert.ok(validateRequest(subject, value));
      const old = refs.get(key(value.scope)); let out, code;
      if (subject === subjects.referenceReserve) {
        if (old && (old.commandHash !== value.commandHash || old.clientUserMessageId !== value.clientUserMessageId)) code = 409;
        else { const reference = old ?? { ...value, state: 'pending', createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z' }; refs.set(key(value.scope), reference); out = { created: !old, reference }; }
      } else if (subject === subjects.referenceList) out = { items: [] };
      else if (!old) code = 404;
      else { if (subject === subjects.referenceConfirm) Object.assign(old, { state: 'confirmed', turnId: value.turnId, itemId: value.itemId }); if (subject === subjects.referenceUpdateState && old.state !== 'confirmed') old.state = value.state; out = { reference: old }; }
      if (code) { const h = headers(); h.set(ServiceErrorHeader, code === 404 ? 'NOT_FOUND' : 'CONFLICT'); h.set(ServiceErrorCodeHeader, String(code)); message.respond(Buffer.from('{}'), { headers: h }); }
      else { assert.ok(validateResponse(subject, out)); if (subject === subjects.referenceReserve && lostReserve) { lostReserve = false; return; } message.respond(Buffer.from(JSON.stringify(out))); }
    } });
    await na.flush();
  };
  try {
    await new Promise(resolve => nativeServer.listen(join(directory, 'native.sock'), resolve));
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    na = await connect({ servers: [firstUrl] }); nb = await connect({ servers: [secondUrl] }); await installArtifacts();
    const config = local => ({ codex: { socketUrl: `ws+unix:${join(directory, 'native.sock')}:/` }, nats: { servers: [local] }, projects: [{ projectId: 'shared', name: 'Shared', cwd: '/fixture' }], allowedModels: ['vision'], artifacts: { baseUrl: 'http://127.0.0.1', timeoutMs: 300, nats: { servers: [local === firstUrl ? firstUrl : `nats://127.0.0.1:${proxy.address().port}`] } } });
    a = await startAgent(config(firstUrl)); b = await startAgent(config(secondUrl));
    const rpc = async (nc, agent, value) => {
      const reply = await nc.request(agentSubjects.rpc, Buffer.from(JSON.stringify({ projectId: 'shared', threadId: thread.id, ownerId: 'owner', generation: agent.status().generation, ...value })), { timeout: 10000 });
      const result = JSON.parse(Buffer.from(reply.data).toString()); if (reply.headers?.get(ServiceErrorHeader)) throw Object.assign(new Error(result.code), result); return result;
    };
    await rpc(na, a, { action: 'create', operationId: 'create', threadId: undefined, ownerId: undefined });
    const start = { action: 'start', operationId: 'same-text', text: 'Shared' };
    const concurrent = await Promise.allSettled([rpc(na, a, start), rpc(nb, b, start)]);
    assert.ok(concurrent.some(result => result.status === 'fulfilled')); assert.equal(calls.length, 1);
    assert.equal((await rpc(nb, b, start)).outcome, 'accepted');
    await assert.rejects(rpc(nb, b, { ...start, text: 'Different' }), error => error.code === 'OPERATION_CONFLICT');
    lostAck = true;
    const steer = { action: 'steer', operationId: 'lost-native', text: 'ACK', expectedTurnId: 'turn' };
    await assert.rejects(rpc(na, a, steer), error => error.outcome === 'unknown');
    assert.equal((await rpc(nb, b, steer)).outcome, 'accepted'); assert.equal(calls.length, 2);
    await until(() => a.status().connection === 'connected');
    assert.equal((await rpc(na, a, steer)).outcome, 'accepted'); assert.equal(calls.length, 2);
    const question = { id: 'runtime-question', type: 'agentMessage', delivery: 'async', phase: 'final_answer', text: 'Continue?', questions: [{ title: 'Continue?', options: ['Yes', 'No'] }] };
    history.push({ turnId: 'turn', item: question });
    for (const socket of sockets) socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: thread.id, turnId: 'turn', item: question, completedAtMs: Date.now() } }));
    await new Promise(resolve => setTimeout(resolve, 100));
    const answers = { [JSON.stringify(['request_user_input_async', question.id, 0])]: { answers: ['Yes'] } };
    const asyncCommand = { action: 'answer', requestId: 'async:' + question.id, answer: { answers } };
    const responses = await Promise.allSettled([rpc(na, a, { ...asyncCommand, operationId: 'ui-a' }), rpc(nb, b, { ...asyncCommand, operationId: 'ui-b' })]);
    assert.ok(responses.some(value => value.status === 'fulfilled')); assert.equal(calls.length, 3);
    lostReserve = true;
    const reserveAck = { ...steer, operationId: 'lost-reserve' };
    await assert.rejects(rpc(nb, b, reserveAck), error => error.outcome === 'unknown');
    await assert.rejects(rpc(na, a, reserveAck), error => error.outcome === 'unknown'); assert.equal(calls.length, 3);
    await service.stop();
    const offline = { ...steer, operationId: 'artifacts-offline' };
    await assert.rejects(rpc(nb, b, offline), error => error.outcome === 'unknown'); assert.equal(calls.length, 3);
    await installArtifacts();

    for (const socket of proxySockets) socket.destroy();
    await until(() => proxySockets.size === 0);
    await until(() => proxySockets.size >= 2); await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await rpc(nb, b, offline)).outcome, 'accepted'); assert.equal(calls.length, 4);
    await bounded(b.close()); b = undefined; await until(() => proxySockets.size === 0);
    assert.equal(a.status().connection, 'connected'); assert.equal(sockets.size, 1);
  } finally {
    await bounded(a?.close()); await bounded(b?.close()); await bounded(service?.stop()); await bounded(na?.close()); await bounded(nb?.close());
    for (const socket of proxySockets) socket.destroy(); for (const socket of sockets) socket.terminate();
    await bounded(new Promise(resolve => proxy.close(resolve))); await bounded(new Promise(resolve => wss.close(resolve))); await bounded(new Promise(resolve => nativeServer.close(resolve))); await rm(directory, { recursive: true, force: true });
  }
});
