// ABOUTME: Принимает HTTP команду start и передаёт её долговечному шлюзу.
// ABOUTME: Ответ 202 подтверждает только PubAck, результат приходит через SSE/ledger.
import { postCommand } from "@/server/http";
export const runtime = "nodejs";
/** Проверяет и ставит команду в очередь. */
export function POST(request: Request) { return postCommand(request, "start"); }
