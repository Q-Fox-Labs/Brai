// ABOUTME: Проверяет закрытую конфигурацию личного MCP proxy Дневника.
// ABOUTME: Не читает рабочие конфиги и не использует настоящие credentials.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {proxyConfiguration} from '../src/stdio-proxy.mjs';
const cfg={url:'http://127.0.0.1:19376/mcp',token:'synthetic-token-012345678901234567890123'};
test('personal proxy rejects external endpoints and caller owner selection',()=>{
 assert.deepEqual(proxyConfiguration(cfg),cfg);
 for(const url of ['https://example.invalid/mcp','http://127.0.0.1/mcp?owner=b','http://user:secret@127.0.0.1/mcp','http://127.0.0.1/other'])assert.throws(()=>proxyConfiguration({...cfg,url}));
 assert.throws(()=>proxyConfiguration({...cfg,ownerId:'foreign'}));assert.throws(()=>proxyConfiguration({...cfg,token:'short'}));
});
