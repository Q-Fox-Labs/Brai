// ABOUTME: Читает web runtime-настройки для выбора текущего входа в Agent.
// ABOUTME: Возвращает браузеру только режим и публичное имя Telegram-бота.

export type WebAgentMode = "dev_agent" | "hermes_telegram";

/** Возвращает разрешённый режим web Agent; неизвестные значения сохраняют прежний DEV режим. */
export function webAgentMode(value = process.env.BRAI_WEB_AGENT_MODE): WebAgentMode {
  return value === "hermes_telegram" ? "hermes_telegram" : "dev_agent";
}

/** Возвращает безопасное имя Telegram-бота без `@` либо null для неверной настройки. */
export function hermesTelegramBotUsername(value = process.env.BRAI_HERMES_TELEGRAM_BOT_USERNAME): string | null {
  const username = value?.trim().replace(/^@/, "");
  return username && /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : null;
}

/** Включает общий просмотр только в явно настроенном Telegram-режиме экземпляра. */
export function telegramObserverEnabled(): boolean {
  return process.env.BRAI_ENVIRONMENT === "dev" && webAgentMode() === "hermes_telegram" && process.env.BRAI_WEB_TELEGRAM_OBSERVER_ENABLED !== "0";
}

/** Возвращает no-store 404 до обращения к выключенному DEV Agent. */
export function disabledAgentResponse(): Response | null {
  return webAgentMode() === "hermes_telegram"
    ? Response.json({ code: "NOT_FOUND" }, { status: 404, headers: { "Cache-Control": "no-store" } })
    : null;
}
