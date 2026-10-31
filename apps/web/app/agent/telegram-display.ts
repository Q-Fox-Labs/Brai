// ABOUTME: Убирает только служебные следы вложений Hermes из текста Telegram.
// ABOUTME: Обычные сообщения и неподтверждённые пользовательские ссылки сохраняются.
export function telegramText(text: string, attachments: { artifactId: string; mimeType: string }[]): string {
  const ids = new Set(attachments.map(item => item.artifactId.toLowerCase()));
  const hasImages = attachments.some(item => item.mimeType.startsWith("image/"));
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const marker = new RegExp(`^\\[artifactId=(${uuid})\\]\\s*$`, "i");
  const pathMarker = new RegExp(`^\\[Image attached at: [^\\n]*?/(${uuid})/[^\\n]*\\]\\s*$`, "i");
  const descriptor = new RegExp(`!?\\[[^\\]\\n]*\\]\\(<[^>\\n]*?/(${uuid})/[^>\\n]+>\\)`, "gi");
  return text.split("\n").map(line => {
    const generated = line.match(marker) ?? line.match(pathMarker);
    if (generated && ids.has(generated[1].toLowerCase())) return "";
    if (hasImages && /^\[screenshot\]\s*$/i.test(line)) return "";
    return line.replace(descriptor, (match, id: string) => ids.has(id.toLowerCase()) ? "" : match);
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Объясняет отсутствие содержимого, если журнал не сохранил текст или вложение. */
export function emptyTelegramMessage(type?: string): string {
  if (type === "service") return "Служебное событие Telegram.";
  if (type?.startsWith("unsupported:")) return "Это вложение пока не поддерживается.";
  if (type && type !== "unknown") return "Содержимое сообщения не сохранено.";
  return "Сообщение без сохранённого текста и вложений; тип неизвестен.";
}

/** Объединяет повторное подтверждение одной отправки, сохраняя другие сообщения. */
export function updateTelegramMessage<T extends { identity: string; telegram_id?: string | null; direction: string }>(previous: T[], value: T): T[] | null {
  let index = previous.findIndex(item => item.identity === value.identity);
  if (index < 0 && value.telegram_id) index = previous.findIndex(item => item.telegram_id === value.telegram_id && item.direction === value.direction);
  if (index < 0) return null;
  return previous.filter((item, position) => position === index || !value.telegram_id || item.telegram_id !== value.telegram_id || item.direction !== value.direction)
    .map(item => item.identity === previous[index].identity ? value : item);
}
