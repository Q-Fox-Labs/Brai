// ABOUTME: Принимает удаление завершённого интервала и передаёт неизменное намерение timer.
// ABOUTME: Владельца добавляет только сервер после проверки сессии и Origin.
import { postCommand } from "@/server/http";
export const runtime = "nodejs";
/** Проверяет и ставит delete команду в долговечную очередь. */
export function POST(request: Request) { return postCommand(request, "delete"); }
