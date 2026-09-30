// ABOUTME: Публикует HTTP/SSE маршруты серверного шлюза agent.
// ABOUTME: Авторизация, DTO проверка и NATS обмен находятся в серверных модулях.
import { agentGet, agentPost } from "@/server/agent-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Передаёт разрешённый GET запрос handler-у agent. */
export function GET(request: Request, context: { params: Promise<{ path: string[] }> }) { return agentGet(request, context); }

/** Передаёт одну явную мутацию handler-у agent. */
export function POST(request: Request, context: { params: Promise<{ path: string[] }> }) { return agentPost(request, context); }
