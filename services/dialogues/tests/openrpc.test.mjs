// ABOUTME: Проверяет OpenRPC-описание стандартной границы MCP Диалогов.
// ABOUTME: Сверяет реестр инструментов с каноническими схемами сервиса.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toolDefinitions} from '../dist/api.js';
import {createOpenRpc} from '../dist/openrpc.js';

test('OpenRPC описывает MCP-методы и использует единые схемы инструментов',()=>{
 const document=createOpenRpc();assert.equal(document.openrpc,'1.2.6');
 assert.deepEqual(document.methods.map(method=>method.name),['initialize','notifications/initialized','ping','tools/list','tools/call']);
 assert.deepEqual(document['x-mcp-tools'],toolDefinitions);
 assert.deepEqual(document.methods.find(method=>method.name==='tools/call').params[0].schema.enum,toolDefinitions.map(tool=>tool.name));
 assert.deepEqual(JSON.parse(JSON.stringify(document)),document);
});
