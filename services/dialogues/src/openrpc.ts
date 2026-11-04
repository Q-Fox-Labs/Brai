// ABOUTME: Описывает MCP JSON-RPC границу сервиса и stdio-proxy в формате OpenRPC.
// ABOUTME: Схемы инструментов получает только из действующего реестра toolDefinitions.
import {pathToFileURL} from 'node:url';
import {toolDefinitions} from './api.js';

const object={type:'object',additionalProperties:true};
const parameter=(name:string,schema:Record<string,unknown>,required=false)=>({name,required,schema});
const result=(schema:Record<string,unknown>)=>({name:'result',schema});

/** Возвращает OpenRPC-конверт MCP; схемы аргументов инструментов не дублируются. */
export function createOpenRpc(){
 return {
  openrpc:'1.2.6',
  info:{title:'Brai Dialogues MCP',version:'0.3.0',description:'Стандартные методы MCP; точные схемы инструментов приведены в x-mcp-tools и получены из toolDefinitions.'},
  externalDocs:{url:'https://modelcontextprotocol.io/specification/2025-11-25',description:'Стандарт MCP и JSON-RPC 2.0'},
  methods:[
   {name:'initialize',params:[parameter('protocolVersion',{type:'string'},true),parameter('capabilities',object,true),parameter('clientInfo',object,true)],result:result(object)},
   {name:'notifications/initialized',description:'Уведомление без ответа JSON-RPC.',params:[],result:result({type:'null'}),'x-notification':true},
   {name:'ping',params:[],result:result(object)},
   {name:'tools/list',params:[parameter('cursor',{type:'string'})],result:result({type:'object',required:['tools'],properties:{tools:{type:'array',items:object},nextCursor:{type:'string'}}})},
   {name:'tools/call',description:'Аргументы каждого инструмента заданы в x-mcp-tools; ошибки операции возвращаются MCP-результатом isError.',params:[parameter('name',{type:'string',enum:toolDefinitions.map(tool=>tool.name)},true),parameter('arguments',object)],result:result({type:'object',properties:{content:{type:'array',items:object},structuredContent:object,isError:{type:'boolean'}}}),errors:[{code:-32601,message:'Method not found'},{code:-32602,message:'Invalid params'},{code:-32603,message:'Internal error'}]}
  ],
  'x-mcp-tools':toolDefinitions
 };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(createOpenRpc(),null,2));
