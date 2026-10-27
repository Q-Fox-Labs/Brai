// ABOUTME: Открывает авторизованные GET и SSE запросы к журналу Telegram.
// ABOUTME: Отправка сообщений и другие мутации не поддерживаются.
export { observerGet as GET } from "@/server/telegram-observer";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
