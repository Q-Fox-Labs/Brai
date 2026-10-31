// ABOUTME: Проверяет настоящий MCP listener и привязку вызовов к владельцу оператора.
// ABOUTME: Тест использует только синтетический объект предметной области.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMcp } from "../dist/mcp.js";

test("MCP перечисляет инструменты, не принимает владельца от модели и передаёт доверенный контекст", async () => {
  const calls = [];
  const domain = {
    async overview(owner) {calls.push({owner});return {focus:null};},
    async change(...args) {calls.push({args});return {id:args[5],version:"1"};},
  };
  const cfg = {host:"127.0.0.1",port:0,owner:"synthetic-owner",hosts:["initial"],origins:["http://initial"],token:"synthetic-only-token-0123456789abcdef"};
  const server = await startMcp(domain,cfg);
  const url = new URL(server.url);cfg.hosts.push(url.host);cfg.origins.push(url.origin);
  const client = new Client({name:"goals-test",version:"1"});
  const directory = await mkdtemp(join(tmpdir(),"brai-goals-mcp-test-"));
  const tokenFile = join(directory,"token");
  await writeFile(tokenFile,cfg.token,{mode:0o600});
  const proxy = new Client({name:"goals-proxy-test",version:"1"});
  try {
    const unauthorized = await fetch(server.url,{method:"POST"});
    assert.equal(unauthorized.status,401);
    await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:"Bearer " + cfg.token}}}),{timeout:1000});
    assert.match(client.getInstructions(),/только по явным словам пользователя/);
    const tools = (await client.listTools()).tools.map(item => item.name);
    for (const name of ["goals_overview","goals_goal_put","goals_resource_put","goals_focus_put","goals_history","goals_restore","goals_delete"]) assert.ok(tools.includes(name));
    const overview = await client.callTool({name:"goals_overview",arguments:{}});
    assert.deepEqual(overview.structuredContent,{focus:null});
    assert.deepEqual(calls[0],{owner:"synthetic-owner"});
    const proxyPath = fileURLToPath(new URL("../dist/stdio-proxy.js",import.meta.url));
    await proxy.connect(new StdioClientTransport({command:process.execPath,args:[proxyPath],env:{PATH:process.env.PATH ?? "",GOALS_MCP_URL:server.url,GOALS_MCP_TOKEN_FILE:tokenFile}}),{timeout:5_000});
    assert.match(proxy.getInstructions(),/только по явным словам пользователя/);
    assert.ok((await proxy.listTools()).tools.some(item => item.name === "goals_overview"));
    assert.deepEqual((await proxy.callTool({name:"goals_overview",arguments:{}})).structuredContent,{focus:null});
    assert.deepEqual(calls[1],{owner:"synthetic-owner"});
    const id = "00000000-0000-4000-8000-000000000001", request_id = "00000000-0000-4000-8000-000000000002";
    const result = await client.callTool({name:"goals_goal_put",arguments:{id,request_id,expected_version:null,source:"synthetic",data:{title:"Goal",meaning:"Purpose",achievement:"Result",status:"discussing"}}});
    assert.equal(result.structuredContent.item.id,id);
    assert.equal(calls[2].args[0],"synthetic-owner");
    assert.equal(calls[2].args[1],"agent");
    const denied = await client.callTool({name:"goals_goal_put",arguments:{id,request_id,expected_version:null,source:"synthetic",data:{title:"Goal",meaning:"Purpose",achievement:"Result",status:"discussing"},user_id:"other-owner"}});
    assert.equal(denied.isError,true);
    assert.equal(calls.length,3);
    const deleted = await client.callTool({name:"goals_delete",arguments:{entity:"goals",id,request_id,expected_version:"1",source:"synthetic"}});
    assert.equal(deleted.isError,undefined);
    assert.equal(calls[3].args[0],"synthetic-owner");
    assert.deepEqual(calls[3].args[7],{deleted:true});
    assert.equal(calls[3].args[8],"delete");
  } finally {await proxy.close();await client.close();await server.close();await rm(directory,{recursive:true,force:true});}
});
