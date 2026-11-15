// ABOUTME: Сверяет bootstrap-схемы Hermes с действующим MCP Диалогов.
// ABOUTME: Каталог содержит только публичные схемы без владельцев и данных.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { toolDefinitions } from '../dist/api.js';
test('Hermes bootstrap catalog exactly matches the current Dialogues API', async()=>{
 const catalog=JSON.parse(await readFile(new URL('../../hermes/identity/dialogues-tools.json',import.meta.url)));
 assert.deepEqual(catalog,toolDefinitions);
});
