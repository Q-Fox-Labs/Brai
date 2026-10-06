// ABOUTME: Обслуживает read уведомлений через доверенную сессию.
// ABOUTME: Проверку входа и обращение к owner выполняет серверная HTTP граница.
import { alertsHttp } from "@/server/alerts-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Передаёт запрос текущего аккаунта без браузерного выбора владельца. */
export async function POST(request: Request, context: { params: Promise<{ service: string; id: string }> }) {
 return alertsHttp(request, "read", await context.params);
}
