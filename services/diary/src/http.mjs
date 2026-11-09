// ABOUTME: Предоставляет HTTP и MCP Дневника через проверенную Auth-привязку.
// ABOUTME: Принятый файл обрабатывается worker независимо от соединения браузера.
import {createServer} from 'node:http';
import {Readable,Transform} from 'node:stream';
import {createHash} from 'node:crypto';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {DiaryFault,id} from './domain.mjs';
const schema=(properties,required)=>({type:'object',additionalProperties:false,properties,required});
const uuid={type:'string',format:'uuid'};
const toolList=[
 {name:'diary_list',description:'Читает собственные записи дневника, 50 на страницу.',inputSchema:schema({offset:{type:'integer',minimum:0}},[])},
 {name:'diary_get',description:'Читает собственную запись, raw, исправленный текст и происхождение даты.',inputSchema:schema({id:uuid},['id'])},
 {name:'diary_create_text',description:'Сохраняет точный текст в собственный дневник. Неизвестная дата остаётся null; requestId повторяется точно.',inputSchema:schema({requestId:uuid,title:{type:'string'},text:{type:'string'},eventDate:{type:['string','null']}},['requestId','text'])}
];
async function body(req,max=2*1024*1024){const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>max)throw new DiaryFault('TOO_LARGE',413);parts.push(part);}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,size)));}catch{throw new DiaryFault('INVALID_ARGUMENT');}}
function send(res,status,value){if(res.destroyed||res.writableEnded)return;const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>3*1024*1024)throw new DiaryFault('TOO_LARGE',413);res.writeHead(status,{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'});res.end(bytes);}
/** Создаёт listener; транспорт не решает owner из тела запроса. */
export function createDiaryServer(cfg,store,ports){
 let active=0;
 const server=createServer(async(req,res)=>{
  req.on('error',()=>{});
  if(active>=8){send(res,429,{code:'OVERLOADED'});return;}active++;
  try{
   if(!cfg.allowedHosts.includes(req.headers.host))throw new DiaryFault('HOST',403);
   const url=new URL(req.url,'http://diary');
   if(req.method==='GET'&&url.pathname==='/health'){send(res,200,{status:'ready'});return;}
   const user=await ports.authenticate(req);
   const mutation=req.method!=='GET'&&req.method!=='HEAD';
   if(req.headers.origin&&req.headers.origin!==cfg.origin)throw new DiaryFault('ORIGIN',403);
   if(mutation&&!req.headers.authorization&&req.headers.origin!==cfg.origin)throw new DiaryFault('ORIGIN',403);
   if(url.pathname==='/mcp'){
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    const input=await body(req);
    const mcp=new Server({name:'brai-diary',version:'1.0.0'},{capabilities:{tools:{}}});
    mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:toolList}));
    mcp.setRequestHandler(CallToolRequestSchema,async request=>{
     try{
      const name=request.params.name,args=request.params.arguments??{};
      let value;
      if(name==='diary_get'){if(Object.keys(args).some(k=>k!=='id'))throw new DiaryFault('INVALID_ARGUMENT');value={entry:await store.get(user.id,id(args.id))};}
      else if(name==='diary_list'){if(Object.keys(args).some(k=>k!=='offset'))throw new DiaryFault('INVALID_ARGUMENT');const offset=args.offset??0;if(!Number.isSafeInteger(offset)||offset<0)throw new DiaryFault('INVALID_ARGUMENT');value=await store.list(user.id,offset);}
      else if(name==='diary_create_text')value={entry:await store.create(user.id,user.profileId,args)};
      else throw new DiaryFault('UNKNOWN_TOOL');
      return {structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};
     }catch(e){return {isError:true,content:[{type:'text',text:JSON.stringify({code:e instanceof DiaryFault?e.code:'UNAVAILABLE'})}]};}
    });
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.once('close',()=>{transport.close().catch(()=>{});mcp.close().catch(()=>{});});
    await mcp.connect(transport);await transport.handleRequest(req,res,input);return;
   }
   if(url.pathname==='/v1/entries'&&req.method==='GET'){
    const offset=Number(url.searchParams.get('offset')??0);
    if(!Number.isSafeInteger(offset)||offset<0)throw new DiaryFault('INVALID_ARGUMENT');
    send(res,200,await store.list(user.id,offset));return;
   }
   if(url.pathname==='/v1/entries'&&req.method==='POST'){send(res,201,{entry:await store.create(user.id,user.profileId,await body(req))});return;}
   if(url.pathname==='/v1/audio'&&req.method==='POST'){
    const entry=await store.create(user.id,user.profileId,await body(req),true);
    const prepared=await ports.prepared(entry);
    send(res,201,{entry,ready:prepared.artifact.status==='ready'});return;
   }
   const match=/^\/v1\/(entry|upload|file)\/([a-f0-9-]+)$/.exec(url.pathname);
   if(!match)throw new DiaryFault('NOT_FOUND',404);
   const entry=await store.get(user.id,id(match[2]));
   if(match[1]==='file'&&['GET','HEAD'].includes(req.method)){
    const {artifact,url}=await ports.file(entry);const headers={};if(req.headers.range)headers.range=req.headers.range;
    const upstream=await fetch(url,{method:req.method,headers,redirect:'error',signal:AbortSignal.timeout(30000)});
    const output={'cache-control':'private, no-store','x-content-type-options':'nosniff','content-type':artifact.mimeType};for(const k of ['content-length','content-range','accept-ranges'])if(upstream.headers.has(k))output[k]=upstream.headers.get(k);
    res.writeHead(upstream.status,output);if(upstream.body)Readable.fromWeb(upstream.body).on('error',()=>res.destroy()).pipe(res);else res.end();return;
   }
   if(match[1]==='entry'&&req.method==='GET'){send(res,200,{entry});return;}
   if(match[1]==='upload'&&['GET','PATCH'].includes(req.method)&&entry.source==='audio'){
    const prepared=await ports.prepared(entry),abort=new AbortController();
    const interrupted=()=>abort.abort();req.once('aborted',interrupted);if(req.aborted)interrupted();
    try{
      const headers={};
      if(req.method==='PATCH'){
        const declared=Number(req.headers['x-content-size']);
        if(!Number.isSafeInteger(declared)||declared<=0||declared>cfg.maxAudioBytes)throw new DiaryFault('TOO_LARGE',413);
        headers['upload-length']=String(declared);headers['upload-offset']=req.headers['upload-offset']??'';headers['upload-chain']=req.headers['upload-chain']??'';
      }
      const result=await fetch(prepared.uploadUrl,{method:req.method==='GET'?'HEAD':'PATCH',headers,...(req.method==='PATCH'?{body:Readable.toWeb(req),duplex:'half'}:{}),redirect:'error',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30*60*1000)])});
      await result.body?.cancel();
      if(!result.ok)throw new DiaryFault(result.status===409?'UPLOAD_CONFLICT':'UPLOAD_UNCONFIRMED',result.status===409?409:503);
      const offset=Number(result.headers.get('upload-offset')),total=result.headers.get('upload-length'),chain=result.headers.get('upload-chain'),chunkBytes=Number(result.headers.get('upload-chunk-size')),ready=result.headers.get('upload-complete')==='true';
      if(!result.headers.has('upload-offset')||!Number.isSafeInteger(offset)||offset<0||!chain||!/^[0-9a-f]{64}$/.test(chain)||chunkBytes!==1048576||(total!==''&&(!Number.isSafeInteger(Number(total))||Number(total)<offset)))throw new DiaryFault('BAD_REPLY',502);
      if(ready&&req.method==='PATCH')await store.uploaded(user.id,entry.id);
      send(res,200,{entryId:entry.id,offset,totalBytes:total===''?null:Number(total),chain,chunkBytes,ready});return;
    }finally{req.off('aborted',interrupted);}
   }
   if(match[1]!=='upload'||req.method!=='PUT'||entry.source!=='audio')throw new DiaryFault('NOT_FOUND',404);
   const declared=Number(req.headers['x-content-size']);
   if(!Number.isSafeInteger(declared)||declared<=0||declared>cfg.maxAudioBytes)throw new DiaryFault('TOO_LARGE',413);
   const prepared=await ports.prepared(entry),hash=createHash('sha256');let size=0;
   const counter=new Transform({transform(chunk,_encoding,callback){size+=chunk.length;if(size>declared){callback(new DiaryFault('INCOMPLETE_FILE'));return;}hash.update(chunk);callback(null,chunk);}});
   if(prepared.artifact.status==='ready'){
    for await(const chunk of req){size+=chunk.length;if(size>declared)throw new DiaryFault('INCOMPLETE_FILE');hash.update(chunk);}
   }else{
    let result;const uploadAbort=new AbortController();
    const interrupted=()=>{uploadAbort.abort();counter.destroy(new DiaryFault('UPLOAD_INTERRUPTED',409));};
    counter.on('error',()=>{});req.once('aborted',interrupted);req.once('error',interrupted);
    if(req.aborted)interrupted();
    try{result=await fetch(prepared.uploadUrl,{method:'PUT',body:Readable.toWeb(req.pipe(counter)),duplex:'half',redirect:'error',headers:{'content-type':entry.audioInput.mimeType},signal:AbortSignal.any([uploadAbort.signal,AbortSignal.timeout(30*60*1000)])});}
    catch{throw new DiaryFault('UPLOAD_UNCONFIRMED',503);}
    finally{req.off('aborted',interrupted);req.off('error',interrupted);req.unpipe(counter);counter.destroy();}
    await result.body?.cancel();if(result.status!==201&&result.status!==409)throw new DiaryFault('UPLOAD_UNCONFIRMED',503);
   }
   if(size!==declared)throw new DiaryFault('INCOMPLETE_FILE');
   const saved=(await ports.prepared(entry)).artifact;
   if(saved.status!=='ready'||saved.sizeBytes!==size||saved.sha256!==hash.digest('hex'))throw new DiaryFault('CONTENT_CONFLICT',409);
   await store.uploaded(user.id,entry.id);send(res,202,{entryId:entry.id,status:'accepted'});
  }catch(error){send(res,error instanceof DiaryFault?error.status:503,{code:error instanceof DiaryFault?error.code:'UNAVAILABLE'});}
  finally{active--;}
 });
 server.requestTimeout=30*60*1000;server.headersTimeout=30000;server.maxConnections=32;
 return server;
}
