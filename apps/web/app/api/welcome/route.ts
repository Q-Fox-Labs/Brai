// ABOUTME: Передаёт администраторские операции закрытому сервису Welcome.
// ABOUTME: Проверяет активную администраторскую сессию и Origin до проксирования.
import {checkOrigin,requireSession} from '@/server/auth';
import {GatewayError} from '@/server/gateway';
import {failure} from '@/server/http';
import {readBoundedJson} from '@/server/request-body';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const reads=new Set(['settings','visitors','chats','messages','applications']);
const writes=new Set(['save-settings','decision']);

/** Проверяет доступ для чтения или изменения и проксирует только известный запрос. */
async function handle(request:Request){
 try{
  const session=await requireSession(request);
  if(!['creator','admin'].includes(session.user.role??'')||session.user.status!=='active')throw new GatewayError(403,'FORBIDDEN');
  const read=request.method==='GET';
  if(!read)checkOrigin(request);
  const body=read?Object.fromEntries(new URL(request.url).searchParams):await readBoundedJson(request,4096,5000);
  if(!body||Array.isArray(body)||typeof body!=='object')throw new GatewayError(400,'INVALID_ARGUMENT');
  const {operation,...input}=body as Record<string,unknown>;
  if(typeof operation!=='string'||!(read?reads:writes).has(operation))throw new GatewayError(404,'NOT_FOUND');
  const endpoint=process.env.WEB_WELCOME_ORIGIN;
  if(!endpoint)throw new GatewayError(503,'WELCOME_UNAVAILABLE');
  const destination=new URL('/admin',endpoint);
  const upstream=await fetch(destination,{method:'POST',redirect:'error',cache:'no-store',signal:request.signal,
   headers:{'content-type':'application/json',origin:request.headers.get('origin')??new URL(process.env.WEB_ORIGIN??request.url).origin,
    cookie:request.headers.get('cookie')??''},
   body:JSON.stringify({operation,input})
  });
  return new Response(upstream.body,{status:upstream.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
 }catch(error){return failure(error instanceof GatewayError?error:new GatewayError(503,'WELCOME_UNAVAILABLE'));}
}
export {handle as GET,handle as POST};
