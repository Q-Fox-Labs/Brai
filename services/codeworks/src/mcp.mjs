// ABOUTME: Даёт Codex локальный MCP stdio клиент того же NATS API Codeworks.
// ABOUTME: Не открывает БД и не создаёт второй исполнитель; broker ACL связывают executor и credentials.
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {methods,expanded,outputNames} from './contracts.mjs';
import {connectClient} from './client.mjs';
import {Fault} from './errors.mjs';
const client=await connectClient({server:process.env.CODEWORKS_NATS_URL,credsFile:process.env.CODEWORKS_NATS_CREDS_FILE,executorId:process.env.CODEWORKS_EXECUTOR_ID});
const server=new Server({name:'codeworks',version:'1.0.0'},{capabilities:{tools:{}}});
const names=Object.fromEntries(methods.map(m=>['codeworks_'+m.replaceAll(/[.-]/g,'_'),m]));
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:Object.entries(names).map(([name,method])=>({name,description:'Codeworks '+method,inputSchema:expanded(method),outputSchema:expanded(outputNames[method])}))}));
server.setRequestHandler(CallToolRequestSchema,async request=>{
  try {
    const method=names[request.params.name];if(!method)throw new Fault('INVALID_ARGUMENT');
    const body=await client.call(method,request.params.arguments??{});
    return {structuredContent:body,content:[{type:'text',text:JSON.stringify(body)}]};
  }catch(error){return {isError:true,content:[{type:'text',text:error instanceof Fault?JSON.stringify(error.dto()):'Codeworks request failed or timed out; inspect operation-status or retry with the same idempotency key.'}]};}
});
server.onclose=()=>{void client.close();};
await server.connect(new StdioServerTransport());
