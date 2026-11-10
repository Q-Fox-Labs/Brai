// ABOUTME: Передаёт авторизованные запросы Дневника в его отдельный сервис.
// ABOUTME: Owner задаёт текущая Auth-сессия; загрузка не выполняет модельные операции в Web.
import {checkOrigin,requireSession} from "./auth";
import {GatewayError as Failure} from "./gateway";
const noStore={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
async function proxy(request:Request,path:string,file=false):Promise<Response>{
 try{
  if(request.method!=="GET"&&request.method!=="HEAD")checkOrigin(request);
  const session=await requireSession(request);
  const expected=file?new URL(request.url).searchParams.get("account"):request.headers.get("x-brai-user");
  if(expected!==session.user.id)throw new Failure(401,"ACCOUNT_CHANGED");
  const origin=process.env.DIARY_SERVICE_ORIGIN;
  if(!origin)throw new Failure(503,"NOT_CONFIGURED");
  const target=new URL(origin);
  if(!/^https?:$/.test(target.protocol)||target.pathname!=="/"||target.username||target.password||target.search||target.hash)throw new Failure(503,"NOT_CONFIGURED");
  const headers=new Headers({"x-brai-user":session.user.id,"cookie":request.headers.get("cookie")??""});
  for(const key of ["origin","content-type","x-content-size","upload-offset","upload-chain","range"]){const value=request.headers.get(key);if(value)headers.set(key,value);}
  const upstream=await fetch(target.origin+path,{method:request.method,headers,body:["GET","HEAD"].includes(request.method)?undefined:request.body,duplex:"half",redirect:"error",cache:"no-store",signal:AbortSignal.any([request.signal,AbortSignal.timeout(["PUT","PATCH"].includes(request.method)||file?30*60*1000:20000)])} as RequestInit);
  const output=new Headers(noStore);for(const key of ["content-type","content-length","content-range","accept-ranges","content-disposition"]){const value=upstream.headers.get(key);if(value)output.set(key,value);}
  return new Response(upstream.body,{status:upstream.status,headers:output});
 }catch(error){const e=error instanceof Failure?error:new Failure(503,"UNAVAILABLE");return Response.json({code:e.code},{status:e.status,headers:noStore});}
}
function key(request:Request):string|null{const value=new URL(request.url).searchParams.get("id")??new URL(request.url).searchParams.get("entry");return value&&/^[a-f0-9-]{36}$/i.test(value)?value:null;}
/** Читает собственный список или сохраняет текст через владельца diary. */
export function diaryCollection(request:Request){const offset=new URL(request.url).searchParams.get("offset")??"0";return proxy(request,"/v1/entries"+(request.method==="GET"?"?offset="+encodeURIComponent(offset):""));}
/** Создаёт устойчивое намерение принять аудио до передачи байтов. */
export function diaryPrepare(request:Request){return proxy(request,"/v1/audio");}
/** Передаёт поток байтов; фоновое задание принадлежит diary, не этому запросу. */
export function diaryUpload(request:Request){const id=key(request);return id?proxy(request,"/v1/upload/"+id):Promise.resolve(Response.json({code:"INVALID_ARGUMENT"},{status:400,headers:noStore}));}
/** Читает raw и исправленный текст своей записи. */
export function diaryRead(request:Request){const id=key(request);return id?proxy(request,"/v1/entry/"+id):Promise.resolve(Response.json({code:"INVALID_ARGUMENT"},{status:400,headers:noStore}));}
/** Явно продолжает остановившуюся расшифровку своей записи. */
export function diaryRetry(request:Request){const id=key(request);return id?proxy(request,"/v1/retry/"+id):Promise.resolve(Response.json({code:"INVALID_ARGUMENT"},{status:400,headers:noStore}));}
/** Читает оригинальный audio через проверенную сессию. */
export function diaryFile(request:Request){const id=key(request);return id?proxy(request,"/v1/file/"+id,true):Promise.resolve(Response.json({code:"INVALID_ARGUMENT"},{status:400,headers:noStore}));}
