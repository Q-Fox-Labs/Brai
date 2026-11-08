// ABOUTME: Подключает личный MCP Дневника к агенту через стандартный stdio.
// ABOUTME: Bearer берётся только из защищённого файла; owner не задаётся аргументами tools.
import {lstat,readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const allowed=new Set(['diary_list','diary_get','diary_create_text']);
/** Принимает только локальный endpoint и личный bearer; произвольный principal запрещён. */
export function proxyConfiguration(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='token,url'||typeof value.token!=='string'||value.token.length<32||/\s/.test(value.token))throw Error('INVALID_DIARY_PROXY');
 const url=new URL(value.url);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/mcp'||url.username||url.password||url.search||url.hash)throw Error('INVALID_DIARY_PROXY');
 return {url:url.href,token:value.token};
}
/** Передаёт только три инструмента владельца; ошибки не раскрывают credentials. */
export async function startProxy(path){
 if(typeof path!=='string'||!path.startsWith('/'))throw Error('CONFIG_REQUIRED');
 const meta=await lstat(path);
 if(!meta.isFile()||meta.uid!==0||(meta.mode&0o027))throw Error('UNSAFE_CONFIG');
 const cfg=proxyConfiguration(JSON.parse(await readFile(path,'utf8')));
 const client=new Client({name:'brai-diary-personal',version:'1.0.0'},{capabilities:{}});
 await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url),{requestInit:{headers:{authorization:'Bearer '+cfg.token}}}));
 const server=new Server({name:'brai-diary',version:'1.0.0'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:(await client.listTools()).tools.filter(t=>allowed.has(t.name))}));
 server.setRequestHandler(CallToolRequestSchema,async request=>{
  if(!allowed.has(request.params.name))return {isError:true,content:[{type:'text',text:'UNKNOWN_TOOL'}]};
  try{return await client.callTool(request.params);}
  catch{return {isError:true,content:[{type:'text',text:'DIARY_UNAVAILABLE'}]};}
 });
 await server.connect(new StdioServerTransport());
 const close=async()=>{await server.close();await client.close();};
 process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());return {close};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 startProxy(process.argv[2]).catch(()=>{console.error('DIARY_PROXY_UNAVAILABLE');process.exitCode=1;});
}
