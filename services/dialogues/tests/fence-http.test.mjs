// ABOUTME: Проверяет Host в реальном тестовом MCP при внутреннем переключении.
// ABOUTME: Сервис слушает случайный порт и не использует пользовательские данные.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {hostFetch} from '../dist/fence-http.js';
import {startMcp} from '../dist/mcp.js';

test('внутренний MCP получает разрешённый Host, даже если URL содержит другой порт',async()=>{
 const token='synthetic-token-012345678901234567890123456789';
 const server=await startMcp({}, {host:'127.0.0.1',port:0,owner:'test',hosts:['127.0.0.1:19358'],origins:['http://127.0.0.1:19358'],token});
 const client=new Client({name:'fence-http-test',version:'1'});
 try{
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url),{fetch:hostFetch('127.0.0.1:19358'),requestInit:{headers:{Authorization:'Bearer '+token}}}));
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['dialogues_context_ack','dialogues_exchange']);
 }finally{await client.close();await server.close();}
});
