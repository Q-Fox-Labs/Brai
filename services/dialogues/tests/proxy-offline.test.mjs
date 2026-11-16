// ABOUTME: Проверяет живой stdio MCP при отсутствующем HTTP listener и его восстановлении.
// ABOUTME: Использует одноразовый token и локальный синтетический MCP без пользовательских данных.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startMcp} from '../dist/mcp.js';
test('offline startup retains tools; the next call reconnects without restarting stdio',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dialogues-offline-')),token='a'.repeat(40);
 const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 await writeFile(join(dir,'token'),token);
 const transport=new StdioClientTransport({command:process.execPath,args:[new URL('../dist/stdio-proxy.js',import.meta.url).pathname],env:{DIALOGUES_MCP_URL:`http://127.0.0.1:${port}/mcp`,DIALOGUES_MCP_TOKEN_FILE:join(dir,'token')},stderr:'pipe'});
 const client=new Client({name:'test',version:'1'});let server;
 try{
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['dialogues_exchange','dialogues_context_ack']);
  const down=await client.callTool({name:'dialogues_exchange',arguments:{}});
  assert.equal(down.isError,true);assert.equal(JSON.parse(down.content[0].text).applied,false);
  assert.equal((await client.listTools()).tools.length,2);
  // A genuine listener response proves recovery, even though this deliberately invalid request is rejected.
  server=await startMcp({}, {host:'127.0.0.1',port,owner:'test',hosts:[`127.0.0.1:${port}`],origins:['http://127.0.0.1'],token});
  const recovered=await client.callTool({name:'dialogues_exchange',arguments:{}});
  assert(!recovered.content[0].text.includes('DIALOGUES_UNAVAILABLE'));
 }finally{await client.close();await server?.close();await rm(dir,{recursive:true,force:true});}
});
