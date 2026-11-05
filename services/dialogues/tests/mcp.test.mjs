// ABOUTME: Проверяет новый MCP и восстановление proxy на синтетической области.
// ABOUTME: Не использует учётные данные или переписку владельца.
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdir,mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StreamableHTTPClientTransport} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {DialoguesFault} from "../dist/domain.js";
import {startMcp} from "../dist/mcp.js";
test("MCP предоставляет только обмен и ACK; stdio восстанавливает сессию",async()=>{
 const calls=[],ctx={consumer_id:'reader',context_instance_id:'instance'};
 const store={
  async pull(owner,args){calls.push({owner,args});return {context_status:'no_updates',items:[],delivery_id:null};},
  async logExchange(){},
  async append(owner,args){calls.push({owner,args});return {request_id:args.request_id,dialogue_id:args.dialogue.id,saved:true};},
  async turnInput(){throw new DialoguesFault('INVALID_ARGUMENT',{field:'messages'});},
  async turnFinish(){throw new DialoguesFault('PENDING_RESULTS',{pending:[{id:'x'}]});},
  async turnGet(){return {version:'1',text:'{}',next_cursor:null};},
  async ack(owner,args){calls.push({owner,args});return {acknowledged:true};}
 };
 const cfg={host:'127.0.0.1',port:0,owner:'test-owner',hosts:['initial'],origins:['http://initial'],token:'synthetic-token-012345678901234567890123456789'};
 let listener=await startMcp(store,cfg);const url=new URL(listener.url);cfg.hosts.push(url.host);cfg.origins.push(url.origin);
 const client=new Client({name:'direct-test',version:'1'}),proxy=new Client({name:'proxy-test',version:'1'});
 const projectTmp=fileURLToPath(new URL('../../../tmp/',import.meta.url));await mkdir(projectTmp,{recursive:true});
 const dir=await mkdtemp(join(projectTmp,'dialogues-mcp-')),token=join(dir,'synthetic-token');await writeFile(token,cfg.token,{mode:0o600});
 try{
  assert.equal((await fetch(listener.url,{method:'POST'})).status,401);
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+cfg.token}}}));
  const listed=(await client.listTools()).tools;
  assert.deepEqual(listed.map(t=>t.name).sort(),['dialogues_context_ack','dialogues_exchange']);
  const exchange=listed.find(t=>t.name==='dialogues_exchange');
  assert.deepEqual(exchange.inputSchema.properties.context.required,['consumer_id','context_instance_id']);
  assert.equal(exchange.inputSchema.oneOf,undefined);
  const input=exchange.inputSchema.properties.arguments.anyOf.find(v=>v.properties.dialogue&&v.properties.messages?.items?.required?.includes('text')&&!v.properties.messages.items.required.includes('turn_id'));
  assert.deepEqual(input.properties.dialogue.required,['id','channel']);
  assert.deepEqual(input.properties.messages.items.required,['id','text']);
  const old=await client.callTool({name:'dialogues_turn_input',arguments:{}});assert.equal(old.isError,true);assert.equal(JSON.parse(old.content[0].text).code,'UNKNOWN_OPERATION');
  const invalid=await client.callTool({name:'dialogues_exchange',arguments:{action:'input',arguments:{request_id:'invalid',dialogue:{id:'chat',channel:'synthetic'}},context:ctx}});
  assert.equal(invalid.isError,true);assert.equal(JSON.parse(invalid.content[0].text).field,'messages');
  const blocked=await client.callTool({name:'dialogues_exchange',arguments:{action:'finish',arguments:{request_id:'finish',dialogue_id:'chat',turn_id:'turn'},context:ctx}});
  assert.equal(blocked.structuredContent.status,'rejected');assert.equal(blocked.structuredContent.code,'PENDING_RESULTS');assert.equal(blocked.structuredContent.pending[0].id,'x');
  await proxy.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/stdio-proxy.js',import.meta.url))],env:{...process.env,DIALOGUES_MCP_URL:listener.url,DIALOGUES_MCP_TOKEN_FILE:token}}));
  assert.equal((await proxy.listTools()).tools.length,2);
  await client.close();await listener.close();cfg.port=Number(url.port);listener=await startMcp(store,cfg);
  const response=await proxy.callTool({name:'dialogues_exchange',arguments:{action:'import',arguments:{request_id:'same-id',dialogue:{id:'chat',channel:'synthetic'},messages:[]},context:ctx}});
  assert.equal(response.structuredContent.saved,true);assert.equal(calls.at(-2).owner,'test-owner');assert.equal(calls.at(-2).args.request_id,'same-id');
  const ack=await proxy.callTool({name:'dialogues_context_ack',arguments:{request_id:'ack',...ctx,delivery_id:'delivery'}});
  assert.equal(ack.structuredContent.acknowledged,true);
 }finally{await client.close().catch(()=>{});await proxy.close().catch(()=>{});await listener.close();await rm(dir,{recursive:true,force:true});}
});
