// ABOUTME: Сохраняет ручной DEV статус из правой карточки после проверки сессии и Origin.
// ABOUTME: Владелец подставляется сервером; неверные и слишком большие тела не публикуются.
import { checkOrigin, requireSession } from "@/server/auth";
import { changeElementStatus } from "@/server/elements";
import { failure } from "@/server/http";
import { readBoundedJson, RequestBodyFailure } from "@/server/request-body";
import { GatewayError } from "@/server/gateway";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Возвращает свежую карту только после подтверждённого сохранения статуса. */
export async function PUT(request: Request) {
 try {
  checkOrigin(request);
  const session = await requireSession(request);
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new GatewayError(415,"CONTENT_TYPE");
  const value = await readBoundedJson(request,2048,5000);
  return Response.json(await changeElementStatus(session.user.id,value),{headers:{"Cache-Control":"no-store"}});
 } catch(error) { return failure(error instanceof RequestBodyFailure ? new GatewayError(error.status,error.code) : error); }
}
