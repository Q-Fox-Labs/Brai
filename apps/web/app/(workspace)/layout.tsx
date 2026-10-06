// ABOUTME: Сохраняет общую оболочку и аккаунт при переходах между рабочими разделами.
// ABOUTME: Маршруты выбирают экран; состояние и подключения принадлежат Account.
import Account from "../account";
import { headers } from "next/headers";
import { loadAccountSession } from "@/server/account-session";

/** Показывает постоянную оболочку навигации и экраны текущего аккаунта. */
export default async function WorkspaceLayout() {
  const initialSession = await loadAccountSession(await headers());
  return <Account initialSession={initialSession} />;
}
