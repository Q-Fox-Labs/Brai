// ABOUTME: Адаптирует ограниченный Chat Completions HTTP/SSE к общему durable ядру.
// ABOUTME: Bearer identity задаёт owner/connection; не вызывает модель и не исполняет tools.
import {createServer,type IncomingMessage} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {boundedJson,type Operations} from './operations.js';
import {Failure} from './core.js';
import {v1Validator,validChatRequest,validChatResult} from './v1-schema.js';
import type {ChatRequest,ChatResult,StreamEvent} from './chat.js';
const valid=v1Validator('httpChatRequest'),keyValid=v1Validator('operationKey');
export type HttpIdentity={token:string;ownerId:string;connectionId:string};
const uuid=/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const terminal=(phase:string)=>phase!=='accepted'&&phase!=='dispatching';
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
function usage(r:ChatResult){return r.usage?{prompt_tokens:r.usage.inputTokens,completion_tokens:r.usage.outputTokens,total_tokens:r.usage.inputTokens+r.usage.outputTokens}:null;}
function tool(call:ChatResult['toolCalls'][number]){return {id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.arguments)}};}
function completed(op:Awaited<ReturnType<Operations['get']>>){
  if(op.phase!=='succeeded'||!validChatResult(op.result))throw new Failure(op.errorCode??(op.resultExpired?'RESULT_EXPIRED':'RESULT_UNAVAILABLE'),op.phase==='outcome_unknown'?'unknown':'failed');
  const r=op.result as unknown as ChatResult;
  return {id:op.operationId,object:'chat.completion',created:Math.floor(op.createdAt/1000),model:r.actualModel,choices:[{index:0,message:{role:'assistant',content:r.text||null,...(r.toolCalls.length?{tool_calls:r.toolCalls.map(tool)}:{})},finish_reason:r.finishReason}],usage:usage(r),brai:{operationId:op.operationId,phase:op.phase,continuation:{operationId:op.operationId}}};
}
function status(code:string){return code==='UNAUTHORIZED'?401:code==='NOT_FOUND'?404:code==='OVERLOADED'?429:code==='IDEMPOTENCY_CONFLICT'?409:['INVALID_REQUEST','INVALID_CONTINUATION','MODEL_NOT_ALLOWED','UNSUPPORTED_OPERATION'].includes(code)?400:503;}
/** Создаёт сервер для внутренней сети. identities приходят из защищённой runtime конфигурации; до listen вызывающий задаёт адрес. */
export function createChatHttp(operations:Operations,identities:readonly HttpIdentity[]) {
  if(!identities.length||identities.length>16||new Set(identities.map(i=>i.token)).size!==identities.length||identities.some(i=>typeof i.token!=='string'||i.token.length<32||i.token.length>256||!/^[a-zA-Z0-9_-]{1,64}$/.test(i.connectionId)||!keyValid({ownerId:i.ownerId,operationId:'00000000-0000-0000-0000-000000000000'})))throw new Error('INVALID_HTTP_CONFIGURATION');
  const credentials=identities.map(i=>({...i,bytes:Buffer.from(i.token)}));
  let active=0;
  const server=createServer(async(req,res)=>{
    let held=false;
    const send=(code:number,body:unknown)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
    try{
      const header=req.headers.authorization;
      const supplied=typeof header==='string'&&header.startsWith('Bearer ')?Buffer.from(header.slice(7)):Buffer.alloc(0);
      const identity=credentials.find(i=>supplied.length===i.bytes.length&&timingSafeEqual(supplied,i.bytes));
      if(!identity)throw new Failure('UNAUTHORIZED','not_sent');
      if(active>=8)throw new Failure('OVERLOADED','not_sent');active++;held=true;
      const recover=/^\/v1\/operations\/([0-9a-fA-F-]{36})$/.exec(req.url??'');
      if(req.method==='GET'&&recover&&uuid.test(recover[1])){
        const op=await operations.get(identity.ownerId,recover[1]);
        // AIDEV-NOTE: Recovery показывает lifecycle, а полный chat выдаёт в том же формате, что POST. Opaque provider state остаётся только в PG.
        const value=op.phase==='succeeded'?completed(op):{id:op.operationId,phase:op.phase,errorCode:op.errorCode,resultExpired:op.resultExpired};
        send(200,value);return;
      }
      if(req.method!=='POST'||req.url!=='/v1/chat/completions'){send(404,{error:{code:'NOT_FOUND'}});return;}
      if(req.headers['content-type']?.split(';')[0].trim()!=='application/json'||req.headers['content-encoding'])throw new Failure('INVALID_REQUEST','not_sent');
      const operationId=req.headers['x-request-id'],deadlineAt=req.headers['x-brai-deadline-at'],continuation=req.headers['x-brai-continuation'];
      if(typeof operationId!=='string'||!uuid.test(operationId)||typeof deadlineAt!=='string'||continuation!==undefined&&(typeof continuation!=='string'||!uuid.test(continuation))||req.headers['idempotency-key']!==undefined&&req.headers['idempotency-key']!==operationId)throw new Failure('INVALID_REQUEST','not_sent');
      res.setHeader('x-request-id',operationId);res.setHeader('location','/v1/operations/'+operationId);
      const body=await readBody(req);
      if(!boundedJson(body)||!valid(body))throw new Failure('INVALID_REQUEST','not_sent');
      const b=body as {model:string;messages:({role:'system'|'user';content:string}|{role:'tool';tool_call_id:string;content:string})[];stream?:boolean;stream_options?:{include_usage:true};max_tokens?:number;tools?:ChatRequest['tools'];tool_choice?:ChatRequest['toolChoice']};
      if(b.stream_options&&!b.stream)throw new Failure('INVALID_REQUEST','not_sent');
      let seenMessage=false;
      for(const message of b.messages){if(message.role!=='tool')seenMessage=true;else if(seenMessage)throw new Failure('INVALID_REQUEST','not_sent');}
      const input:ChatRequest={operationId,deadlineAt,ownerId:identity.ownerId,connectionId:identity.connectionId,streamInbox:'_INBOX.'+identity.connectionId+'.http',provider:'openrouter',model:b.model,messages:b.messages.filter((m):m is ChatRequest['messages'][number]=>m.role!=='tool'),tools:b.tools??[],maxTokens:b.max_tokens??1024,toolChoice:b.tool_choice??'auto',...(continuation?{continuation:{operationId:continuation as string}}:{}),toolResults:b.messages.filter((m):m is {role:'tool';tool_call_id:string;content:string}=>m.role==='tool').map(m=>({id:m.tool_call_id,content:m.content}))};
      if(!validChatRequest(input))throw new Failure('INVALID_REQUEST','not_sent');
      let streaming=false,sentBytes=0,textSent=false;const toolsSent=new Set<number>();
      const frame=(data:unknown)=>{
        if(!streaming||res.destroyed||res.writableEnded)return false;
        const line='data: '+(typeof data==='string'?data:JSON.stringify(data))+'\n\n';sentBytes+=Buffer.byteLength(line);
        if(sentBytes>1048576||res.writableLength+Buffer.byteLength(line)>32768){res.destroy();return false;}
        const writable=res.write(line);
        if(!writable){res.destroy();return false;}return true;
      };
      const chunk=(delta:unknown,finish_reason:string|null=null)=>({id:operationId,object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:b.model,choices:[{index:0,delta,finish_reason}]});
      const start=()=>{if(streaming||res.destroyed)return;res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','x-accel-buffering':'no'});res.flushHeaders();streaming=true;};
      const emit=(event:StreamEvent)=>{
        if(!b.stream)return true;
        start();
        if(event.type==='text.delta'){textSent=true;return frame(chunk({content:event.text}));}
        if(event.type==='tool_call.ready'){toolsSent.add(event.call.index);return frame(chunk({tool_calls:[{index:event.call.index,...tool(event.call)}]}));}
        return !res.destroyed;
      };
      let op=await operations.invokeChat(input,emit);
      if(b.stream)start();
      const until=Date.now()+95000;
      while(!terminal(op.phase)){
        // HTTP disconnect прекращает доставку/ожидание, но не durable compute. Caller восстанавливает тот же operationId через GET.
        if(res.destroyed)return;
        if(Date.now()>=until)throw new Failure('RESULT_PENDING','unknown');
        await pause();op=await operations.get(identity.ownerId,operationId);
      }
      const full=completed(op);
      if(!b.stream){send(200,full);return;}
      const result=op.result as unknown as ChatResult;
      // Replay не переигрывает live events ядра; полный durable итог преобразуется в один завершённый HTTP поток.
      if(!textSent&&result.text)frame(chunk({content:result.text}));
      for(const call of result.toolCalls)if(!toolsSent.has(call.index))frame(chunk({tool_calls:[{index:call.index,...tool(call)}]}));
      frame({...chunk({},result.finishReason),brai:full.brai});
      if(b.stream_options)frame({id:operationId,object:'chat.completion.chunk',created:full.created,model:full.model,choices:[],usage:full.usage});
      frame('[DONE]');res.end();
    }catch(error){
      const safe=error instanceof Failure?error:new Failure('STORAGE_UNAVAILABLE','unknown');
      const body={error:{code:safe.code,message:safe.code,outcome:safe.outcome}};
      if(res.headersSent){if(!res.destroyed&&!res.writableEnded){res.end('data: '+JSON.stringify(body)+'\n\n');}}else send(status(safe.code),body);
    }finally{if(held)active--;}
  });
  server.requestTimeout=10000;server.headersTimeout=5000;server.keepAliveTimeout=1000;server.maxRequestsPerSocket=100;server.maxConnections=32;
  return server;
}
async function readBody(req:IncomingMessage):Promise<unknown>{
  let size=0;const parts:Buffer[]=[];
  try{for await(const part of req){size+=part.length;if(size>65536)throw new Failure('INVALID_REQUEST','not_sent');parts.push(part);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}
  catch{throw new Failure('INVALID_REQUEST','not_sent');}
}
