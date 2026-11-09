// ABOUTME: Открывает административный экран только проверенному администратору.
// ABOUTME: Серверная проверка не полагается на скрытие ссылки в навигации.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { loadAccountSession } from "@/server/account-session";
import Account from "../account";
import { hermesTelegramBotUsername, telegramObserverEnabled, webAgentMode } from "@/server/web-config";
export const metadata = { title: "Админка · Brai" };
/** Проверяет актуальную сессию до передачи административного экрана. */
export default async function AdminPage() {
 const session = await loadAccountSession(await headers());
 if (session.status !== "authenticated") redirect("/auth");
 if (session.user.role !== "admin" || session.user.status !== "active") redirect("/");
 return <Account initialSession={session} agentMode={webAgentMode()} telegramBotUsername={hermesTelegramBotUsername()} telegramObserverEnabled={telegramObserverEnabled()} />;
}
