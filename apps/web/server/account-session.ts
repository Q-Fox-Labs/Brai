// ABOUTME: Подтверждает сессию нового документа до первой разметки рабочего экрана.
// ABOUTME: Передаёт клиенту только идентичность; токены и cookie остаются на сервере.
import { requireSession } from "./auth";
import { GatewayError } from "./gateway";

export type AccountSession =
  | { status: "authenticated"; user: { id: string; email: string } }
  | { status: "anonymous" }
  | { status: "unavailable" };

/** Читает сессию владельца без кэша; временный отказ отличает от отсутствия входа. */
export async function loadAccountSession(headers: Headers): Promise<AccountSession> {
  if (!headers.get("cookie")) return { status: "anonymous" };
  try {
    const request = new Request(new URL("/api/auth/session", process.env.WEB_ORIGIN ?? "http://localhost"), { headers });
    const { user } = await requireSession(request);
    return { status: "authenticated", user: { id: user.id, email: user.email } };
  } catch (error) {
    return { status: error instanceof GatewayError && error.status === 401 ? "anonymous" : "unavailable" };
  }
}
