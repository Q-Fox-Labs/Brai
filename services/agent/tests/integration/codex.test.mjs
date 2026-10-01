// ABOUTME: Проверяет один собственный синтетический Codex thread и turn.
// ABOUTME: Требует явных socket и test-directory inputs; обычный запуск пропускает live test.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { createCodex } from '../../dist/codex.js';

const socketPath = process.env.AGENT_TEST_CODEX_SOCKET;
const cwdPrefix = process.env.AGENT_TEST_CODEX_CWD;
const allowedModels = new Set(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']);
const selectedModel = process.env.AGENT_TEST_MODEL ?? 'gpt-6.1-sol';
const enabled = Boolean(socketPath && cwdPrefix);

test('live app-server completes one own synthetic thread turn', { skip: !enabled }, async (t) => {
  assert.ok(socketPath.startsWith('/'), 'explicit absolute Unix socket path required');
  assert.ok(cwdPrefix.startsWith('/tmp/brai-agent-service-op1-'), 'test cwd prefix must stay under the operation scratch path');
  assert.ok(allowedModels.has(selectedModel), 'synthetic model is outside the approved allowlist');
  const cwd = await mkdtemp(cwdPrefix);
  const port = createCodex({ socketUrl: `ws+unix:${socketPath}:/` });
  let ownThreadId;
  let ownTurnId;
  let terminalEvent;
  let unsubscribe;
  let disconnected = false;
  const completionWaiters = new Set();
  const completedEvents = [];
  const notifyWaiters = (event) => {
    for (const waiter of completionWaiters) {
      if (event.threadId === waiter.threadId && (!waiter.turnId || event.turn.id === waiter.turnId)) {
        completionWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    }
  };
  const waitForTerminal = (timeoutMs) => {
    if (disconnected) return Promise.reject(new Error('Codex disconnected before terminal confirmation'));
    const found = completedEvents.find((event) => event.threadId === ownThreadId && (!ownTurnId || event.turn.id === ownTurnId));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { threadId: ownThreadId, turnId: ownTurnId, resolve, reject };
      waiter.timer = setTimeout(() => {
        completionWaiters.delete(waiter);
        reject(new Error('synthetic turn terminal state was not confirmed'));
      }, timeoutMs);
      completionWaiters.add(waiter);
    });
  };
  unsubscribe = port.subscribe((event) => {
    if (event.type === 'connection') {
      disconnected = event.status.connection === 'disconnected';
      if (disconnected) {
        for (const waiter of completionWaiters) {
          completionWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.reject(new Error('Codex disconnected before terminal confirmation'));
        }
      }
      return;
    }
    if (event.type !== 'notification') return;
    if (event.method === 'turn/started' && event.params.threadId === ownThreadId) ownTurnId = event.params.turn.id;
    if (event.method === 'turn/completed' && event.params.threadId === ownThreadId) {
      completedEvents.push(event.params);
      if (!ownTurnId || event.params.turn.id === ownTurnId) terminalEvent = event.params;
      notifyWaiters(event.params);
    }
  });

  t.after(async () => {
    if (ownThreadId && port.status().connection !== 'connected') {
      try {
        await port.connect();
        disconnected = false;
      } catch { /* недоступный daemon не позволяет подтвердить исход synthetic turn */ }
    }
    if (ownThreadId && ownTurnId && !terminalEvent) {
      try {
        await port.call('turn/interrupt', { threadId: ownThreadId, turnId: ownTurnId }, { mutation: true, timeoutMs: 12_000 });
      } catch { /* исход прерывания сверяется терминальным событием ниже */ }
      try { terminalEvent = await waitForTerminal(20_000); } catch { /* рабочий каталог оставляем при неизвестном исходе */ }
    }
    if (ownThreadId && !ownTurnId && !terminalEvent) {
      try {
        const page = await port.call('thread/turns/list', { threadId: ownThreadId, limit: 20 }, { mutation: false, timeoutMs: 10_000 });
        const active = page.data.find((turn) => turn.status === 'inProgress');
        if (active) {
          ownTurnId = active.id;
          try { await port.call('turn/interrupt', { threadId: ownThreadId, turnId: ownTurnId }, { mutation: true, timeoutMs: 12_000 }); } catch { /* сверка ниже */ }
          try { terminalEvent = await waitForTerminal(20_000); } catch { /* рабочий каталог оставляем при неизвестном исходе */ }
        } else {
          terminalEvent = { confirmedNoActiveTurn: true };
        }
      } catch { /* история недоступна: рабочий каталог оставляем */ }
    }
    if (ownThreadId && terminalEvent) {
      try { await port.call('thread/unsubscribe', { threadId: ownThreadId }, { mutation: true, timeoutMs: 10_000 }); } catch { /* завершённый ephemeral thread не требует архивирования */ }
    }
    unsubscribe?.();
    await port.close();
    if (!ownThreadId || terminalEvent) await rm(cwd, { recursive: true, force: true });
    else throw new Error('own synthetic turn did not reach a confirmed terminal state; temporary cwd was retained');
  });

  await port.connect();
  assert.equal(port.status().connection, 'connected');
  const thread = await port.call('thread/start', {
    cwd,
    model: selectedModel,
    allowProviderModelFallback: false,
    ephemeral: true,
    sandbox: 'read-only',
    approvalPolicy: 'never',
  }, { mutation: true });
  assert.ok(thread.thread && typeof thread.thread.id === 'string');
  ownThreadId = thread.thread.id;
  assert.ok(allowedModels.has(thread.model));
  assert.equal(thread.model, selectedModel);
  const input = 'Reply exactly BRAI_AGENT_ADAPTER_OK without tools.';
  const turnResult = await port.call('turn/start', {
    threadId: thread.thread.id,
    model: selectedModel,
    input: [{ type: 'text', text: input }],
  }, { mutation: true });
  assert.ok(typeof turnResult.turn?.id === 'string');
  ownTurnId = turnResult.turn.id;
  const event = await waitForTerminal(90_000);
  terminalEvent = event;
  assert.equal(event.threadId, thread.thread.id);
  assert.equal(event.turn.id, turnResult.turn.id);
  assert.equal(event.turn.status, 'completed');
  assert.ok(event.turn.items.some((item) => JSON.stringify(item).includes('BRAI_AGENT_ADAPTER_OK')));
});
