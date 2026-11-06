// ABOUTME: Открывает административный экран только проверенному администратору.
// ABOUTME: Серверная проверка не полагается на скрытие ссылки в навигации.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { loadAccountSession } from "@/server/account-session";
import AdminScreen from "./screen";
/** Проверяет актуальную сессию до передачи административного экрана. */
export default async function AdminPage() {
 const session = await loadAccountSession(await headers());
 if (session.status !== "authenticated") redirect("/auth");
 if (session.user.role !== "admin" || session.user.status !== "active") redirect("/");
 return <AdminScreen />;
}
