// ABOUTME: Принимает поручение и реальные Экшены только из проверенной web-сессии.
// ABOUTME: Владелец, исполнитель, стадия и metadata решений не берутся из тела клиента.
import {checkOrigin,requireSession} from '@/server/auth';
import {createTaskDraft,performElementWorkflow} from '@/server/elements';
import {failure} from '@/server/http';
import {readBoundedJson,RequestBodyFailure} from '@/server/request-body';
import {GatewayError} from '@/server/gateway';
export const runtime='nodejs';
export const dynamic='force-dynamic';
/** Сохраняет исходное поручение; постановку выполняет агент по принятому протоколу. */
export async function POST(request:Request){return handle(request,true);}
/** Сохраняет результат выбранного Хода по точной ревизии. */
export async function PUT(request:Request){return handle(request,false);}
async function handle(request:Request,draft:boolean){
 try{
  checkOrigin(request);const session=await requireSession(request);
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new GatewayError(415,'CONTENT_TYPE');
  const value=await readBoundedJson(request,60000,5000);
  const result=draft?await createTaskDraft(session.user.id,value):await performElementWorkflow(session.user.id,session.session.id,value);
  return Response.json(result,{headers:{'Cache-Control':'no-store'}});
 }catch(error){return failure(error instanceof RequestBodyFailure?new GatewayError(error.status,error.code):error);}
}
