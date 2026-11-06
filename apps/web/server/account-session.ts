// ABOUTME: Подтверждает сессию нового документа до первой разметки рабочего экрана.
// ABOUTME: Передаёт клиенту только идентичность; токены и cookie остаются на сервере.
import { requireSession, telegramIdentity } from "./auth";
import { GatewayError } from "./gateway";

export type AccountUser = { id: string; name?: string; role?: "admin" | "user"; status?: "provisioning" | "active" | "blocked"; telegramId?: string | null; profileId?: string | null; email?: string };
export type AccountSession =
  | { status: "authenticated"; user: AccountUser }
  | { status: "anonymous" }
  | { status: "unavailable" };

/** Читает сессию владельца без кэша; временный отказ отличает от отсутствия входа. */
export async function loadAccountSession(headers: Headers): Promise<AccountSession> {
  if (!headers.get("cookie")) return { status: "anonymous" };
  try {
    const request = new Request(new URL("/api/auth/session", process.env.WEB_ORIGIN ?? "http://localhost"), { headers });
    const { user } = await requireSession(request);
    return { status: "authenticated", user: publicUser(user) };
  } catch (error) {
    return { status: error instanceof GatewayError && error.status === 401 ? "anonymous" : "unavailable" };
  }
}
/** Возвращает разрешённые поля идентичности без данных сессии. */
export function publicUser(user: Awaited<ReturnType<typeof requireSession>>["user"]): AccountUser {
 return telegramIdentity() ? { id: user.id, name: user.name?.trim() || "Пользователь", role: user.role, status: user.status, telegramId: user.telegramId ?? null, profileId: user.profileId ?? null } : { id: user.id, email: user.email };
}
