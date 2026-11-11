// ABOUTME: Выдаёт только доказательство, связанное со своей доступной карточкой bug-hunt.
// ABOUTME: Проверяет сессию и owner Artifacts; готовые байты передаёт существующий защищённый download.
import {requireSession} from "./auth";
import {GatewayError,natsConnection} from "./gateway";
import {agentResultsConnection} from "./agent-artifacts";
import {adminDownload} from "./admin-download";
const headers={"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** HEAD проверяет доступность без загрузки байтов; GET всегда повторно проверяет текущий доступ. */
export async function bugHuntEvidence(request:Request):Promise<Response>{
 try{
  const session=await requireSession(request),url=new URL(request.url),caseId=url.searchParams.get("case_id"),artifactId=url.searchParams.get("artifact_id");
  if(session.user.status!=="active"||url.searchParams.get("account")!==session.user.id)throw new GatewayError(401,"ACCOUNT_CHANGED");
  if(!caseId||!artifactId||!uuid.test(caseId)||!uuid.test(artifactId))throw new GatewayError(404,"NOT_FOUND");
  if(!process.env.WEB_ADMIN_ARTIFACTS_BASE_URL)throw new GatewayError(503,"ARTIFACT_UNAVAILABLE");
  const nc=await natsConnection();
  const cardMessage=await nc.request("brai.bug_hunt.v1.get",Buffer.from(JSON.stringify({context:{kind:"web",headers:{cookie:request.headers.get("cookie")??""}},input:{case_id:caseId,limit:1}})),{timeout:10000});
  if(cardMessage.headers?.has("Nats-Service-Error")||cardMessage.headers?.has("Nats-Service-Error-Code"))throw new GatewayError(404,"NOT_FOUND");
  if(cardMessage.data.length>262144)throw new GatewayError(502,"BAD_REPLY");
  const card=JSON.parse(Buffer.from(cardMessage.data).toString());
  // AIDEV-NOTE: Право ручного разбора не заменяет отдельное право чтения чужого файла.
  if(card?.case?.owner_id!==session.user.id||!card.report?.observation?.evidence_artifact_ids?.includes(artifactId))throw new GatewayError(404,"NOT_FOUND");
  const artifactNc=await agentResultsConnection();
  const message=await artifactNc.request("brai.artifacts.v1.get",Buffer.from(JSON.stringify({artifactId})),{timeout:10000});
  if(message.headers?.has("Nats-Service-Error")||message.headers?.has("Nats-Service-Error-Code")||message.data.length>1048576)throw new GatewayError(404,"NOT_FOUND");
  const artifact=JSON.parse(Buffer.from(message.data).toString());
  if(artifact?.artifactId!==artifactId||artifact.ownerId!==session.user.id||artifact.status!=="ready")throw new GatewayError(404,"NOT_FOUND");
  if(request.method==="HEAD")return new Response(null,{headers});
  return await adminDownload(artifact,artifactId,AbortSignal.any([request.signal,AbortSignal.timeout(30000)]));
 }catch(error){const safe=error instanceof GatewayError?error:new GatewayError(503,"ARTIFACT_UNAVAILABLE");return Response.json({code:safe.code},{status:safe.status,headers});}
}
