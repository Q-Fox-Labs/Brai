// ABOUTME: Проверяет отдельный поток названия и сохранение ручного имени.
// ABOUTME: Fake Codex воспроизводит ранние события, отказ, timeout и disconnect без моделей.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nameThread } from '../dist/title.js';
import { createApplication } from '../dist/application.js';
function fixture(options = {}) {
  const calls = [], listeners = new Set(); let generation = 'g1', name = options.name ?? null;
  const send = (method, params) => { for (const observer of listeners) observer({ type: 'notification', method, params }); };
  const finish = () => {
    if (options.rename) name = options.rename;
    send('item/completed', { threadId: 'temporary', turnId: 'title-turn', item: { id: 'title', type: 'agentMessage', text: options.output ?? '{"title":"Настроить уведомления"}' } });
    send('turn/completed', { threadId: 'temporary', turn: { id: 'title-turn', status: options.failure ? 'failed' : 'completed', ...(options.failure ? { error: { message: 'private upstream details', codexErrorInfo: options.failure } } : {}) } });
  };
  const port = {
    status: () => ({ generation, connection: 'connected', authorization: 'ready' }),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    call: async (method, params, flags) => {
      calls.push({ method, params, flags });
      if (method === 'thread/read') return { thread: { id: 'main', name, preview: options.preview ?? '', cwd: '/tmp/demo', updatedAt: 1, model: 'gpt-6-luna' } };
      if (method === 'thread/resume') return { ...(await port.call('thread/read', params)), model: 'gpt-6-luna' };
      if (method === 'thread/turns/list') return { data: options.turn ? [options.turn] : [] };
      if (method === 'thread/items/list') return { data: [] };
      if (method === 'config/read') return { config: { mcp_servers: { index: { command: 'private' }, data: { http_headers: { token: 'private' } } } } };
      if (method === 'account/rateLimits/read') return { rateLimits: null };
      if (method === 'thread/start') return { thread: { id: params.ephemeral ? 'temporary' : 'main', name, preview: '', cwd: '/tmp/demo', updatedAt: 1 }, model: 'gpt-6-luna' };
      if (method === 'turn/start') {
        if (params.threadId === 'temporary') {
          if (options.disconnect) {
            generation = 'g2'; for (const observer of listeners) observer({ type: 'connection', status: port.status() });
          } else if (!options.hold) finish();
          return { turn: { id: 'title-turn', status: 'inProgress' } };
        }
        if (options.rejectMain) throw Object.assign(new Error('rejected'), { outcome: 'not-sent' });
        send('turn/started', { threadId: 'main', turn: { id: 'main-turn', status: 'inProgress' } });
        return { turn: { id: 'main-turn', status: 'inProgress' } };
      }
      if (method === 'thread/name/set') { name = params.name; send('thread/name/updated', { threadId: params.threadId, threadName: name }); return {}; }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
      if (method === 'turn/interrupt') return {};
      throw new Error('Unexpected method: ' + method);
    },
  };
  return { port, calls, listeners, finish, send, name: () => name };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('one Luna request saves a semantic title and cleans its ephemeral conversation; early events are retained', async () => {
  const f = fixture();
  assert.equal(await nameThread(f.port, 'main', 'Пожалуйста, посмотри проект и настрой уведомления'), 'Настроить уведомления');
  assert.equal(f.name(), 'Настроить уведомления');
  const start = f.calls.find(c => c.method === 'thread/start');
  assert.equal(start.params.ephemeral, true); assert.equal(start.params.model, 'gpt-6-luna'); assert.equal(start.params.allowProviderModelFallback, false);
  assert.equal(start.params.config.model_reasoning_effort, 'low'); assert.equal(start.params.developerInstructions, ''); assert.ok(start.params.baseInstructions.length < 150);
  assert.deepEqual(start.params.config.mcp_servers, { index: { enabled: false }, data: { enabled: false } });
  for (const key of ['skills.include_instructions', 'skills.bundled.enabled', 'include_permissions_instructions', 'include_apps_instructions', 'include_collaboration_mode_instructions', 'include_environment_context', 'agents.enabled', 'tools.update_plan.enabled', 'tools.experimental_request_user_input.enabled']) assert.equal(start.params.config[key], false);
  for (const key of ['apps', 'plugins', 'remote_plugin', 'multi_agent', 'multi_agent_v2', 'shell_tool', 'unified_exec', 'hooks', 'code_mode', 'code_mode_host']) assert.equal(start.params.config[`features.${key}`], false);
  for (const key of ['dynamicTools', 'selectedCapabilityRoots', 'environments']) assert.deepEqual(start.params[key], []);
  const turn = f.calls.find(c => c.method === 'turn/start'); assert.equal(turn.params.effort, 'low'); assert.equal(turn.params.model, 'gpt-6-luna');
  assert.deepEqual(JSON.parse(turn.params.input[0].text), { request: 'Пожалуйста, посмотри проект и настрой уведомления' });
  const long = fixture(); await nameThread(long.port, 'main', 'x'.repeat(8192)); assert.equal(JSON.parse(long.calls.find(c => c.method === 'turn/start').params.input[0].text).request.length, 2048);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'thread/name/set').length, 1);
  assert.equal(f.calls.at(-1).method, 'thread/unsubscribe'); assert.equal(f.listeners.size, 0);
});
test('existing and concurrently changed native names are preserved', async () => {
  const named = fixture({ name: 'Ручное название' });
  assert.equal(await nameThread(named.port, 'main', 'Другая задача'), null);
  assert.equal(named.calls.length, 1);
  const changed = fixture({ rename: 'Выбранное вручную' });
  assert.equal(await nameThread(changed.port, 'main', 'Другая задача'), null);
  assert.equal(changed.name(), 'Выбранное вручную'); assert.equal(changed.calls.some(c => c.method === 'thread/name/set'), false); assert.equal(changed.listeners.size, 0);
});
test('invalid output has no rename; timeout interrupts only the temporary turn and releases observers', async () => {
  for (const output of ['invalid', '{"title":""}', '{"title":"Две\\nстроки"}']) {
    const f = fixture({ output }); await assert.rejects(nameThread(f.port, 'main', 'task')); assert.equal(f.calls.some(c => c.method === 'thread/name/set'), false); assert.equal(f.listeners.size, 0);
  }
  const f = fixture({ hold: true }); await assert.rejects(nameThread(f.port, 'main', 'task', 5), /TITLE_TIMEOUT/);
  assert.deepEqual(f.calls.find(c => c.method === 'turn/interrupt').params, { threadId: 'temporary', turnId: 'title-turn' });
  assert.equal(f.calls.at(-1).method, 'thread/unsubscribe'); assert.equal(f.listeners.size, 0);
});
test('a long semantic title is bounded without another inference', async () => {
  const f = fixture({ output: JSON.stringify({ title: 'Настроить ежедневные уведомления об ошибках приложения и отправлять сводку по почте' }) });
  assert.equal(await nameThread(f.port, 'main', 'task'), 'Настроить ежедневные уведомления об ошибках приложения и');
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
  const schema = f.calls.find(c => c.method === 'turn/start').params.outputSchema;
  assert.equal(schema.properties.title.maxLength, 60);
});
test('RPC and generation failures identify their stage without losing native codes', async () => {
  const f = fixture();
  const call = f.port.call;
  f.port.call = async (...args) => {
    if (args[0] === 'thread/start') throw Object.assign(new Error('private upstream details'), { code: 'UPSTREAM_UNAVAILABLE', upstreamCode: -32600 });
    return call(...args);
  };
  await assert.rejects(nameThread(f.port, 'main', 'task'), e => e.titleStage === 'thread/start' && e.code === 'UPSTREAM_UNAVAILABLE' && e.upstreamCode === -32600);
  const invalid = fixture({ output: 'invalid' });
  await assert.rejects(nameThread(invalid.port, 'main', 'task'), e => e.titleStage === 'result' && e.code === 'TITLE_INVALID_RESULT');
  const failed = fixture({ failure: 'usageLimitExceeded' });
  await assert.rejects(nameThread(failed.port, 'main', 'task'), e => e.titleStage === 'generation' && e.code === 'TITLE_TURN_FAILED' && e.nativeCode === 'usageLimitExceeded');
});
test('reopened unnamed chats are named once after an accepted start using the original request', async t => {
  for (const turn of [undefined, { id: 'old-turn', status: 'completed' }]) {
    const f = fixture({ turn, preview: turn ? 'Настроить уведомления' : '' });
    const app = createApplication(f.port, { projects: [{ projectId: 'demo', name: 'Demo', cwd: '/tmp/demo' }], allowedModels: ['gpt-6-luna'] }, () => {});
    t.after(() => app.close());
    await app.request({ action: 'open', projectId: 'demo', threadId: 'main' });
    const command = { action: 'start', projectId: 'demo', threadId: 'main', generation: 'g1', operationId: 'first', text: 'Продолжить работу' };
    await app.request(command); await tick(); await tick();
    const titleTurns = f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === 'temporary');
    assert.equal(titleTurns.length, 1);
    assert.equal(JSON.parse(titleTurns[0].params.input[0].text).request, turn ? 'Настроить уведомления' : command.text);
    f.send('turn/completed', { threadId: 'main', turn: { id: 'main-turn', status: 'completed' } });
    await app.request({ ...command, operationId: 'second' }); await tick();
    assert.equal(f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === 'temporary').length, 1);
  }
});
test('a failed name waits for another accepted user task and keeps the first request', async t => {
  const options = { failure: 'serverOverloaded' }, f = fixture(options);
  const app = createApplication(f.port, { projects: [{ projectId: 'demo', name: 'Demo', cwd: '/tmp/demo' }], allowedModels: ['gpt-6-luna'] }, () => {});
  t.after(() => app.close());
  await app.request({ action: 'create', projectId: 'demo', generation: 'g1', operationId: 'create' });
  const command = { action: 'start', projectId: 'demo', threadId: 'main', generation: 'g1', operationId: 'first', text: 'Настроить уведомления' };
  await app.request(command); await tick(); await tick();
  await app.request(command); await tick();
  assert.equal(f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === 'temporary').length, 1);
  options.failure = undefined;
  f.send('turn/completed', { threadId: 'main', turn: { id: 'main-turn', status: 'completed' } });
  await app.request({ ...command, operationId: 'second', text: 'Продолжить работу' }); await tick(); await tick();
  const attempts = f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === 'temporary');
  assert.equal(attempts.length, 2);
  assert.equal(JSON.parse(attempts[1].params.input[0].text).request, command.text);
  assert.equal(f.name(), 'Настроить уведомления');
});
test('disconnect rejects old generation without sending cleanup or rename to a new generation', async () => {
  const f = fixture({ disconnect: true }); await assert.rejects(nameThread(f.port, 'main', 'task'), /TITLE_CONNECTION_LOST/);
  assert.equal(f.calls.some(c => ['thread/name/set', 'turn/interrupt', 'thread/unsubscribe'].includes(c.method)), false); assert.equal(f.listeners.size, 0);
});
test('first accepted start is not blocked by naming; operation replay and later turns do not create more title turns', async t => {
  const f = fixture({ hold: true }), app = createApplication(f.port, { projects: [{ projectId: 'demo', name: 'Demo', cwd: '/tmp/demo' }], allowedModels: ['gpt-6-luna'] }, () => {});
  t.after(() => app.close());
  await app.request({ action: 'create', projectId: 'demo', generation: 'g1', operationId: 'create' });
  const command = { action: 'start', projectId: 'demo', threadId: 'main', generation: 'g1', operationId: 'start', text: 'Пожалуйста, настрой уведомления' };
  const results = await Promise.all([app.request(command), app.request(command)]); assert.equal(results[0].outcome, 'accepted');
  await tick(); assert.equal(f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === 'temporary').length, 1);
  f.finish(); await tick(); await tick();
  const snapshot = await app.request({ action: 'open', projectId: 'demo', threadId: 'main' }); assert.equal(snapshot.thread.title, 'Настроить уведомления'); assert.equal(snapshot.turn.id, 'main-turn');
  f.send('turn/completed', { threadId: 'main', turn: { id: 'main-turn', status: 'completed' } });
  await app.request({ ...command, operationId: 'second', text: 'Ещё одна задача' }); await tick();
  assert.equal(f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === 'temporary').length, 1);
});
test('rejected first start has no paid title effect and may be sent again after correction', async t => {
  const options = { rejectMain: true }, f = fixture(options), app = createApplication(f.port, { projects: [{ projectId: 'demo', name: 'Demo', cwd: '/tmp/demo' }] }, () => {}); t.after(() => app.close());
  await app.request({ action: 'create', projectId: 'demo', generation: 'g1', operationId: 'create' });
  const command = { action: 'start', projectId: 'demo', threadId: 'main', generation: 'g1', operationId: 'first', text: 'task' };
  await assert.rejects(app.request(command)); await tick(); assert.equal(f.calls.some(c => c.method === 'thread/start' && c.params.ephemeral), false);
  options.rejectMain = false; await app.request({ ...command, operationId: 'retry' }); await tick(); await tick();
  assert.equal(f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === 'temporary').length, 1);
});
