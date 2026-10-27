// ABOUTME: Сохраняет общую оболочку и аккаунт при переходах между рабочими разделами.
// ABOUTME: Маршруты выбирают экран; состояние и подключения принадлежат Account.
import { redirect } from "next/navigation";
import Account from "../account";
import { headers } from "next/headers";
import { loadAccountSession } from "@/server/account-session";
import { hermesTelegramBotUsername, telegramObserverEnabled, webAgentMode } from "@/server/web-config";

/** Показывает постоянную оболочку навигации и экраны текущего аккаунта. */
export default async function WorkspaceLayout() {
  const initialSession = await loadAccountSession(await headers());
  if (initialSession.status === "anonymous") redirect("/auth");
  return <Account initialSession={initialSession} agentMode={webAgentMode()} telegramBotUsername={hermesTelegramBotUsername()} telegramObserverEnabled={telegramObserverEnabled()} />;
}
