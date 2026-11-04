// ABOUTME: Соединяет защищённый HTTP Дневника со штатным Artifacts.
// ABOUTME: Потоки файлов не буферизуются; секреты, внутренние URL и чужие файлы не выдаются.
import { createHash } from "node:crypto";
import { subjects,validateRequest,validateResponse } from "../../../services/artifacts/contracts/index.mjs";
import type { Artifact } from "../../../services/artifacts/contracts/index.mjs";
import { checkOrigin,requireSession } from "./auth";
import { GatewayError,natsConnection } from "./gateway";
import { readBoundedJson,RequestBodyFailure } from "./request-body";
import { createDiary,diaryId,diaryMaterial,DiaryError,type Prepared } from "./diary-core";
const noStore = {"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
const inline = new Set(["image/png","image/jpeg","image/webp","image/gif","audio/ogg","audio/opus","audio/mpeg","audio/mp4","audio/x-m4a","audio/webm","audio/wav","video/mp4","video/webm"]);
function failure(error:unknown):Response {
  const value=error instanceof DiaryError||error instanceof GatewayError||error instanceof RequestBodyFailure?error:new DiaryError(503,"UNAVAILABLE");
  return Response.json({code:value.code},{status:value.status,headers:noStore});
}
async function call<T>(operation:"prepare"|"get"|"list",input:unknown):Promise<T> {
  const subject=subjects[operation];
  if(!validateRequest(subject,input))throw new DiaryError(400,"INVALID_ARGUMENT");
  const nc=await natsConnection();
  let reply;
  try {reply=await nc.request(subject,Buffer.from(JSON.stringify(input)),{timeout:10000});}
  catch {throw new DiaryError(503,"UNAVAILABLE");}
  if(reply.data.length>1_048_576)throw new DiaryError(502,"BAD_REPLY");
  if(reply.headers?.has("Nats-Service-Error")||reply.headers?.has("Nats-Service-Error-Code")){
    const code=reply.headers.get("Nats-Service-Error"),status=Number(reply.headers.get("Nats-Service-Error-Code"));
    if(!code||!Number.isInteger(status)||status<400||status>599)throw new DiaryError(502,"BAD_REPLY");
    throw new DiaryError(status,code);
  }
  let body;
  try {body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(reply.data));}catch{throw new DiaryError(502,"BAD_REPLY");}
  if(!validateResponse(subject,body))throw new DiaryError(502,"BAD_REPLY");
  return body as T;
}
function base():URL {
  const value=process.env.DIARY_ARTIFACTS_INTERNAL_ORIGIN;
  if(!value)throw new DiaryError(503,"NOT_CONFIGURED");
  const url=new URL(value);
  if(!/^https?:$/.test(url.protocol)||url.username||url.password||url.pathname!=="/"||url.search||url.hash)throw new DiaryError(503,"NOT_CONFIGURED");
  return url;
}
function fileUrl(item:Artifact):URL {
  const url=new URL(item.internalUrl??"");
  if(url.origin!==base().origin||url.pathname!=="/files/"+item.artifactId||url.username||url.password||url.search||url.hash)throw new DiaryError(502,"BAD_REPLY");
  return url;
}
function uploadUrl(value:string):URL {
  const url=new URL(value),expected=new URL(process.env.DIARY_ARTIFACTS_UPLOAD_BASE_URL??process.env.ARTIFACTS_UPLOAD_BASE_URL??"");
  if(url.origin!==expected.origin||!/^https?:$/.test(url.protocol)||url.username||url.password||url.search||url.hash||!/^\/upload\/[A-Za-z0-9_-]{16,512}$/.test(url.pathname))throw new DiaryError(502,"BAD_REPLY");
  return url;
}
async function read(item:Artifact,max:number):Promise<Uint8Array>{
  if(item.sizeBytes===null||item.sizeBytes>max)throw new DiaryError(413,"TOO_LARGE");
  const response=await fetch(fileUrl(item),{redirect:"manual",cache:"no-store",signal:AbortSignal.timeout(15000)});
  if(response.status!==200||!response.body)throw new DiaryError(503,"UNAVAILABLE");
  const chunks:Uint8Array[]=[],reader=response.body.getReader();let size=0;
  try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>max)throw new DiaryError(413,"TOO_LARGE");chunks.push(part.value);}}
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  return Buffer.concat(chunks,size);
}
async function put(prepared:Prepared,bytes:Uint8Array):Promise<void>{
  const response=await fetch(uploadUrl(prepared.uploadUrl),{method:"PUT",body:Buffer.from(bytes),redirect:"manual",signal:AbortSignal.timeout(30000)});
  // AIDEV-NOTE: 409 допускает гонку двух точных повторов; ядро всё равно сверяет ready/hash/size.
  if(response.status!==201&&response.status!==409)throw new DiaryError(503,"UPLOAD_UNCONFIRMED");
  await response.body?.cancel();
}
const diary=createDiary({call,read,put});
function parameters(request:Request,allowed:string[]):URL {
  const url=new URL(request.url);
  if([...url.searchParams.keys()].some(key=>!allowed.includes(key)||url.searchParams.getAll(key).length!==1))throw new DiaryError(400,"INVALID_ARGUMENT");
  return url;
}
function offset(url:URL):number {
  const raw=url.searchParams.get("offset")??"0";
  if(!/^(0|[1-9][0-9]{0,8})$/.test(raw)||url.searchParams.getAll("offset").length>1)throw new DiaryError(400,"INVALID_ARGUMENT");
  return Number(raw);
}
async function identity(request:Request,write=false):Promise<string>{
  if(write)checkOrigin(request);
  const session=await requireSession(request);
  if(request.headers.get("x-brai-user")!==session.user.id)throw new DiaryError(401,"ACCOUNT_CHANGED");
  return session.user.id;
}
async function jsonBody(request:Request){
  if(!request.headers.get("content-type")?.startsWith("application/json"))throw new DiaryError(415,"CONTENT_TYPE");
  return readBoundedJson(request,16*1024*1024,15000);
}
/** Читает страницу записей либо создаёт неизменяемую запись с ключом повтора. */
export async function diaryCollection(request:Request):Promise<Response>{
  try {
    const owner=await identity(request,request.method==="POST"),url=parameters(request,request.method==="GET"?["offset"]:[]);
    if(request.method==="GET")return Response.json(await diary.list(owner,offset(url)),{headers:noStore});
    if(request.method!=="POST")throw new DiaryError(405,"METHOD_NOT_ALLOWED");
    if(url.search)throw new DiaryError(400,"INVALID_ARGUMENT");
    return Response.json({entry:await diary.create(owner,await jsonBody(request))},{status:201,headers:noStore});
  }catch(error){return failure(error);}
}
/** Читает текст записи и страницу готовых вложений только текущего владельца. */
export async function diaryRead(request:Request):Promise<Response>{
  try {const url=parameters(request,["id","offset"]);return Response.json({entry:await diary.get(await identity(request),diaryId(url.searchParams.get("id")),offset(url))},{headers:noStore});}
  catch(error){return failure(error);}
}
/** Готовит файл после подтверждённого сохранения самой записи. */
export async function diaryPrepare(request:Request):Promise<Response>{
  try {
    const owner=await identity(request,true),url=parameters(request,["entry"]);
    const prepared=await diary.prepareMaterial(owner,diaryId(url.searchParams.get("entry")),await jsonBody(request));
    return Response.json({material:diaryMaterial(prepared.artifact)},{headers:noStore});
  }catch(error){return failure(error);}
}
/** Передаёт оригинал потоком; успех требует ready, размера и контрольной суммы. */
export async function diaryUpload(request:Request):Promise<Response>{
  try {
    const owner=await identity(request,true),url=parameters(request,["entry","material"]);
    const entryId=diaryId(url.searchParams.get("entry")),id=diaryId(url.searchParams.get("material"));
    const item=await diary.material(owner,entryId,id,false);
    const rawSize=request.headers.get("x-content-size"),expectedSize=Number(rawSize);
    if(!rawSize||!/^[1-9][0-9]{0,10}$/.test(rawSize)||!Number.isSafeInteger(expectedSize)||expectedSize>2147483648||!request.body)throw new DiaryError(400,"INVALID_ARGUMENT");
    let bytes=0,digest:string|null=null;const hash=createHash("sha256");
    const stream=request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){
      bytes+=chunk.length;if(bytes>expectedSize)throw new DiaryError(413,"TOO_LARGE");hash.update(chunk);controller.enqueue(chunk);
    },flush(){if(bytes!==expectedSize)throw new DiaryError(400,"INCOMPLETE_FILE");digest=hash.digest("hex");}}));
    if(item.status!=="ready"){
      const prepared=await call<Prepared>("prepare",{requestId:item.requestId,ownerId:owner,kind:"original",metadata:{title:item.title,filename:item.filename,extension:item.extension,mimeType:item.mimeType,source:item.source,details:item.details}});
      const response=await fetch(uploadUrl(prepared.uploadUrl),{method:"PUT",body:stream,duplex:"half",redirect:"manual",signal:AbortSignal.any([request.signal,AbortSignal.timeout(1800000)])} as RequestInit & {duplex:"half"});
      if(response.status!==201&&response.status!==409)throw new DiaryError(503,"UPLOAD_UNCONFIRMED");
      await response.body?.cancel();
    }else{
      // AIDEV-NOTE: Повтор ready проверяет новые байты потоком, не заменяя сохранённый оригинал.
      const reader=stream.getReader();
      try{while(!(await reader.read()).done){/* Только проверка размера и хеша. */}}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    }
    if(!digest)throw new DiaryError(503,"UPLOAD_UNCONFIRMED");
    const saved=await diary.material(owner,entryId,id);
    if(saved.sizeBytes!==expectedSize||saved.sha256!==digest)throw new DiaryError(409,"CONTENT_CONFLICT");
    return Response.json({material:diaryMaterial(saved)},{status:201,headers:noStore});
  }catch(error){return failure(error);}
}
/** Выдаёт только проверенное вложение; активные форматы скачиваются как файлы. */
export async function diaryFile(request:Request):Promise<Response>{
  try{
    const session=await requireSession(request),url=parameters(request,["entry","material","account","download"]);
    const entryId=diaryId(url.searchParams.get("entry")),id=diaryId(url.searchParams.get("material"));
    if(url.searchParams.get("account")!==session.user.id||[...url.searchParams.keys()].some(key=>!["entry","material","account","download"].includes(key))||url.searchParams.getAll("account").length!==1||url.searchParams.getAll("download").length>1||(url.searchParams.has("download")&&url.searchParams.get("download")!=="1"))throw new DiaryError(401,"ACCOUNT_CHANGED");
    const item=await diary.material(session.user.id,diaryId(entryId),diaryId(id)),headers=new Headers();
    const range=request.headers.get("range");
    if(range){if(!/^bytes=(\d+-\d*|-\d+)$/.test(range))throw new DiaryError(416,"INVALID_RANGE");headers.set("range",range);}
    const response=await fetch(fileUrl(item),{method:request.method==="HEAD"?"HEAD":"GET",headers,redirect:"manual",cache:"no-store",signal:request.signal});
    if(![200,206,416].includes(response.status)){await response.body?.cancel();throw new DiaryError(503,"UNAVAILABLE");}
    const output=new Headers({...noStore,"Cross-Origin-Resource-Policy":"same-origin","Content-Security-Policy":"sandbox; default-src 'none'","X-Frame-Options":"DENY"});
    for(const name of ["content-length","content-range","accept-ranges","etag"])if(response.headers.has(name))output.set(name,response.headers.get(name)!);
    const show=inline.has(item.mimeType)&&!url.searchParams.has("download");
    output.set("Content-Type",show?item.mimeType:"application/octet-stream");
    const filename=encodeURIComponent(item.filename).replace(/['()*]/g,c=>"%"+c.charCodeAt(0).toString(16).toUpperCase());
    output.set("Content-Disposition",show?"inline":"attachment; filename=\"download\"; filename*=UTF-8''"+filename);
    return new Response(response.body,{status:response.status,headers:output});
  }catch(error){return failure(error);}
}
