// ABOUTME: Загружает исходную страницу входа вне рабочей оболочки.
// ABOUTME: Подтверждённая сервером сессия переходит в приложение; временный отказ не считает её гостевой.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { loadAccountSession } from "@/server/account-session";
import Account from "../account";
import { continuation, ssoConfig } from "@/server/sso";
/** Проверяет сессию нового документа перед показом формы входа. */
export default async function AuthPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
 const config = ssoConfig();
 const query = await searchParams;
 const params = new URLSearchParams();
 for (const [key, value] of Object.entries(query)) { if (typeof value === "string") params.append(key, value); else if (Array.isArray(value)) for (const item of value) params.append(key, item); }
 const next = continuation(params, config);
 const initialSession = await loadAccountSession(await headers());
 if (initialSession.status === "authenticated") redirect(next ?? "/");
 if (initialSession.status === "anonymous" && config?.role === "preview") redirect("/api/auth/sso/start");
 return <Account initialSession={initialSession} authContinuation={next} ssoPreview={config?.role === "preview"} />;
}
