// ABOUTME: Читает настройки плашки отдельного веб-превью во время запуска.
// ABOUTME: Обычный экземпляр не отображает сведения о ветке.

/** Возвращает проверенные сведения превью или null, если оно не включено. */
export function previewInfo(env: Record<string, string | undefined> = process.env) {
  if (env.BRAI_WEB_PREVIEW !== "1") return null;
  const branch = env.BRAI_WEB_PREVIEW_BRANCH;
  const sha = env.BRAI_WEB_PREVIEW_SHA;
  const backendChanged = env.BRAI_WEB_PREVIEW_BACKEND_CHANGED;
  const expiresAt = env.BRAI_WEB_PREVIEW_EXPIRES_AT;
  if (!branch || !sha || !/^[0-9a-f]{40}$/.test(sha) || !["0", "1"].includes(backendChanged ?? "") || (expiresAt && !Number.isFinite(Date.parse(expiresAt)))) {
    throw new Error("Invalid BRAI_WEB_PREVIEW configuration");
  }
  return { branch, sha, backendChanged: backendChanged === "1", expiresAt };
}

/** Возвращает имя durable; preview обязан использовать отдельное имя. */
export function eventsConsumerName(env: Record<string, string | undefined> = process.env): string {
  const name = env.WEB_EVENTS_CONSUMER ?? "web_events";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || (env.BRAI_WEB_PREVIEW === "1" && name === "web_events")) throw new Error("Invalid WEB_EVENTS_CONSUMER");
  return name;
}
