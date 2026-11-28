// ABOUTME: Публикует контракт Диалогов независимо от доступности HTTP-сервиса.
// ABOUTME: Лениво восстанавливает соединение, не повторяя неизвестную запись.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { agentInstructions, toolDefinitions } from './api.js';
import { callWithRecovery } from './proxy-recovery.js';
try {
 const url = new URL(process.env.DIALOGUES_MCP_URL ?? '');
 if (url.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') throw Error('INVALID_ENDPOINT');
 const token = readFileSync(process.env.DIALOGUES_MCP_TOKEN_FILE ?? '', 'utf8').trim();
 if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw Error('INVALID_TOKEN');
 let client: Client | undefined, opening: Promise<Client> | undefined, closed = false, unavailable = false;
 function status(down: boolean) {
  if (unavailable !== down) console.error(JSON.stringify({service:'dialogues-mcp',event:down?'backend_unavailable':'backend_recovered'}));
  unavailable = down;
 }
 async function connect(): Promise<Client> {
  if (closed) throw Error('CLOSED');
  if (client) return client;
  if (!opening) opening = (async () => {
   const next = new Client({name:'brai-dialogues-proxy',version:'0.2.0'});
   next.onclose = () => { if (client === next) client = undefined; };
   try {
    await next.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+token}}}),{timeout:5000});
    if (closed) throw Error('CLOSED');
    client = next; status(false); return next;
   } catch (e) { await next.close().catch(()=>{}); status(true); throw e; }
  })().finally(()=>{opening=undefined;});
  return opening;
 }
 async function discard(previous: Client) {
  if (client === previous) client = undefined;
  await previous.close().catch(()=>{});
 }
 const server = new Server({name:'brai-dialogues',version:'0.2.0'},{capabilities:{tools:{listChanged:false}},instructions:agentInstructions+' При временном отказе продолжай разрешённую работу. Не упоминай пользователю внутренний сервис; сообщай только понятные последствия для его просьбы. Не утверждай чтение или сохранение без квитанции.'});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:structuredClone(toolDefinitions)}));
 server.setRequestHandler(CallToolRequestSchema,async req=>{
  let current: Client;
  try { current = await connect(); }
  catch (error) {
   const forbidden = error instanceof StreamableHTTPError && (error.code === 401 || error.code === 403);
   return {isError:true,content:[{type:'text',text:JSON.stringify({code:forbidden?'FORBIDDEN':'DIALOGUES_UNAVAILABLE',applied:false,
    next_action:forbidden?'Доступ к Диалогам отклонён. Проверьте авторизацию; ожидание восстановления сервиса не исправит доступ.':'Продолжай работу. Не сообщай пользователю внутренние подробности; объясняй только последствия для его просьбы. Повтори обращение после восстановления сервиса.'})}]};
  }
  const stale = (e:unknown) => e instanceof StreamableHTTPError && e.code === 404;
  // AIDEV-NOTE: HTTP 404 listener гарантирует отказ до выполнения операции.
  return callWithRecovery(req.params.name,async()=>{
   try { return await current.callTool(req.params); }
   catch(e) { await discard(current); status(true); throw e; }
  },async()=>{await discard(current); await connect();},async()=>{
   const next=await connect();
   try{return await next.callTool(req.params);}catch(e){await discard(next);status(true);throw e;}
  },stale);
 });
 async function close(){closed=true;await opening?.catch(()=>{});await client?.close();}
 server.onclose=()=>{void close();};
 process.stdin.once('end',()=>{void server.close().finally(close);});
 await server.connect(new StdioServerTransport());
} catch { console.error('DIALOGUES_MCP_PROXY_UNAVAILABLE'); process.exitCode=1; }
