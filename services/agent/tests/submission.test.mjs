// ABOUTME: Проверяет точное подтверждение ввода после потери ответа транспорта.
// ABOUTME: Совпадение текста или чужой native clientId не подтверждает операцию.
import assert from 'node:assert/strict';
import test from 'node:test';
import { display } from '../dist/display.js';

test('persisted user clientId projects the exact submission ID for text and images', () => {
  for (const content of [[{ type: 'text', text: 'same' }], [{ type: 'image', url: 'private' }]]) {
    const item = display({ id: 'native', type: 'userMessage', clientId: 'brai:agent:v3:operation', content }, 'turn');
    assert.equal(item.operationId, 'operation');
    assert.ok(!JSON.stringify(item).includes('private'));
  }
  for (const clientId of [undefined, '', 'another:operation', 'brai:agent:v3:', 'brai:agent:v3:' + 'x'.repeat(129)]) {
    assert.equal(display({ id: 'native', type: 'userMessage', clientId, content: [] }, 'turn').operationId, undefined);
  }
  assert.equal(display({ id: 'assistant', type: 'agentMessage', clientId: 'brai:agent:v3:operation', text: 'same' }, 'turn').operationId, undefined);
});
