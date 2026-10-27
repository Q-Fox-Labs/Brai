// ABOUTME: Проверяет доступ к артефакту сообщения Telegram перед выдачей файла.
// ABOUTME: Байты остаются у сервиса Artifacts и закрытого файлового прокси.
export { observerFileAuth as GET, observerFileAuth as HEAD } from "@/server/telegram-observer";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
