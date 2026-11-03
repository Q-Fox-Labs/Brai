// ABOUTME: Проверяет настоящий MCP и восстановление proxy на синтетической области.
// ABOUTME: Не использует учётные данные или переписку владельца.
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,rm} from "node:fs/promises";
import {resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {startMcp} from "../dist/mcp.js";
test("MCP привязан к оператору; stdio восстанавливает чтение после restart",async()=>{
  const calls=[];
  const store={
    async context(owner,args){calls.push({owner,args});return {dialogues:[],next_cursor:null};},
    async append(owner,args){calls.push({owner,args});return {saved:true};},
    async summary(){return {version:"1"};},async message(){return {text:"synthetic"};}
  };
  const cfg={host:"127.0.0.1",port:0,owner:"test-owner",hosts:[],origins:[],token:"synthetic-token-012345678901234567890123456789"};
  cfg.hosts.push("initial");cfg.origins.push("http://initial");
  let listener=await startMcp(store,cfg);
  const url=new URL(listener.url);cfg.hosts.push(url.host);cfg.origins.push(url.origin);
  const client=new Client({name:"direct-test",version:"1"});
  const proxy=new Client({name:"proxy-test",version:"1"});
  const projectTmp=fileURLToPath(new URL("../../../tmp/",import.meta.url));
  await mkdir(projectTmp,{recursive:true});
  const dir=await mkdtemp(join(projectTmp,"dialogues-mcp-"));
  const token=join(dir,"synthetic-token");
  await writeFile(token,cfg.token,{mode:0o600});
  try {
    assert.equal((await fetch(listener.url,{method:"POST"})).status,401);
    await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:"Bearer "+cfg.token}}}));
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),["dialogues_context_ack","dialogues_context_get","dialogues_context_pull","dialogues_message_get","dialogues_messages_append","dialogues_summary_put"]);
    await client.callTool({name:"dialogues_context_get",arguments:{}});
    assert.equal(calls.at(-1).owner,"test-owner");
    await proxy.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL("../dist/stdio-proxy.js",import.meta.url))],env:{...process.env,DIALOGUES_MCP_URL:listener.url,DIALOGUES_MCP_TOKEN_FILE:token}}));
    assert.equal((await proxy.listTools()).tools.length,6);
    await client.close();await listener.close();
    cfg.port=Number(url.port);listener=await startMcp(store,cfg);
    assert.equal((await proxy.callTool({name:"dialogues_context_get",arguments:{}})).isError,undefined);
    assert.equal(calls.at(-1).owner,"test-owner");
  } finally {await client.close().catch(()=>{});await proxy.close().catch(()=>{});await listener.close();await rm(dir,{recursive:true,force:true});}
});
