// ABOUTME: Даёт обычным native Codex-чатам файловые инструменты существующего Codeworks host.
// ABOUTME: Берёт identity только из metadata каждого MCP вызова; не исполняет команды и не повторяет мутации.
import {createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import Ajv from 'ajv';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {socketCall} from './agent-host.mjs';

const tool=JSON.parse(await readFile(new URL('./agent-tools.json',import.meta.url),'utf8'));
const validArguments=new Ajv({strict:false}).compile(tool.inputSchema);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail=code=>{throw new Error(code);};

/**
 * Создаёт stdio MCP frontend существующего host; controlSocket задаёт доверенный launcher.
 * Каждый вызов подписывает native _meta.threadId и исходные валидные arguments.
 * Не хранит текущую identity, не повторяет вызовы; таймаут/разрыв не отменяет мутацию.
 */
export function createAgentMcpServer({controlSocket,call=socketCall}={}){
  if(typeof controlSocket!=='string'||!controlSocket.startsWith('/')||controlSocket.includes('\0'))fail('CODEWORKS_CONTROL_SOCKET_REQUIRED');
  const server=new Server({name:'codeworks-agent',version:'1.0.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[tool]}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    try{
      const identity=request.params._meta?.threadId;
      if(typeof identity!=='string'||!uuid.test(identity))fail('NATIVE_THREAD_ID_REQUIRED');
      if(request.params.name!==tool.name||!validArguments(request.params.arguments))fail('INVALID_ARGUMENT');
      const adapter=await call(controlSocket,{action:'adapter',executor_id:'codex'});
      if(typeof adapter?.socket!=='string'||!adapter.socket.startsWith('/')||typeof adapter.key!=='string'||!/^[0-9a-f]{64}$/.test(adapter.key))fail('ADAPTER_DESCRIPTOR_INVALID');
      // AIDEV-NOTE: sessionId принадлежит native процессу; threadId различает чаты и subagents общего MCP.
      const payload=JSON.stringify({native_session_id:identity,request:request.params.arguments});
      const body=await call(adapter.socket,{payload,signature:createHmac('sha256',Buffer.from(adapter.key,'hex')).update(payload).digest('hex')});
      return {structuredContent:body,content:[{type:'text',text:JSON.stringify(body)}]};
    }catch(error){
      const code=['EACCES','EPERM'].includes(error?.code)?'CODEWORKS_ACCESS_DENIED':/^[A-Z][A-Z0-9_]{0,79}$/.test(error?.message??'')?error.message:'CODEWORKS_UNAVAILABLE';
      return {isError:true,content:[{type:'text',text:code+': inspect status before repeating a mutation; repeat commit/release only with the same request_key.'}]};
    }
  });
  return server;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{
    await createAgentMcpServer({controlSocket:process.env.CODEWORKS_CONTROL_SOCKET}).connect(new StdioServerTransport());
  }catch{
    console.error('CODEWORKS_MCP_START_FAILED: trusted control socket configuration is required.');
    process.exitCode=1;
  }
}
