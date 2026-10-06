// ABOUTME: Загружает исходную страницу входа вне рабочей оболочки.
// ABOUTME: Подтверждённая сервером сессия переходит в приложение; временный отказ не считает её гостевой.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { loadAccountSession } from "@/server/account-session";
import Account from "../account";
/** Проверяет сессию нового документа перед показом формы входа. */
export default async function AuthPage() {
 const initialSession = await loadAccountSession(await headers());
 if (initialSession.status === "authenticated") redirect("/");
 return <Account initialSession={initialSession} />;
}
