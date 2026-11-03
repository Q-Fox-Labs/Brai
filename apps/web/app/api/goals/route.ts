// ABOUTME: Обслуживает запросы целей только для проверенной web-сессии.
// ABOUTME: Из браузера разрешает только чтение обзора и истории.
import { checkOrigin, requireSession } from "@/server/auth";
import { goalsRequest } from "@/server/goals";
import { GatewayError } from "@/server/gateway";
import { failure } from "@/server/http";
import { readBoundedJson, RequestBodyFailure } from "@/server/request-body";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Возвращает текущий обзор без кеширования. */
export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    if (new URL(request.url).search) throw new GatewayError(400,"INVALID_ARGUMENT");
    return Response.json(await goalsRequest(session.user.id,"goals_overview",{}),{headers:{"Cache-Control":"no-store"}});
  } catch (error) {return failure(error);}
}
/** Читает историю после проверки Origin и сессии; изменения доступны только через MCP. */
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const session = await requireSession(request);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new GatewayError(415,"CONTENT_TYPE","not-published");
    const data = await readBoundedJson(request,131_072,5_000);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new GatewayError(400,"INVALID_ARGUMENT","not-published");
    const record = data as Record<string,unknown>;
    if (Object.keys(record).some(key => !["operation","input"].includes(key)) || typeof record.operation !== "string" || !record.input || typeof record.input !== "object" || Array.isArray(record.input)) throw new GatewayError(400,"INVALID_ARGUMENT","not-published");
    if (record.operation !== "goals_history") throw new GatewayError(403,"FORBIDDEN","not-published");
    return Response.json(await goalsRequest(session.user.id,record.operation,record.input),{headers:{"Cache-Control":"no-store"}});
  } catch (error) {return failure(error instanceof RequestBodyFailure ? new GatewayError(error.status,error.code,"not-published") : error);}
}
