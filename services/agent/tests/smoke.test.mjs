// ABOUTME: Проверяет запрет wire bypass и безопасное отображение native history.
// ABOUTME: Не обращается к серверу Codex и не запускает модель.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand, bytes } from '../contracts/index.mjs';
import { display } from '../dist/display.js';
test('команда не пропускает cwd, неверный model и неизвестное действие', () => {
  assert.equal(validateCommand({ action: 'open', projectId: 'p', threadId: 't', cwd: '/other' }), false);
  assert.equal(validateCommand({ action: 'turn/start', projectId: 'p' }), false);
  assert.equal(validateCommand({ action: 'create', projectId: 'p', generation: 'g', operationId: 'o', model: 42 }), false);
});
test('история сохраняет phase, скрывает raw reasoning и ограничивает JSON bytes', () => {
  assert.equal(display({ id: 'r', type: 'reasoning', summary: ['public'], content: ['private'] }, 't').text, 'public');
  assert.equal(display({ id: 'a', type: 'agentMessage', text: 'done', phase: 'final_answer' }, 't').phase, 'final_answer');
  assert.ok(bytes(display({ id: 'c', type: 'commandExecution', aggregatedOutput: '\0'.repeat(10000) }, 't', true)) <= 4096);
});
