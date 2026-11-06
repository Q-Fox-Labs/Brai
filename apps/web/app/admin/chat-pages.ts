// ABOUTME: Объединяет страницы сообщений выбранного административного чата.
// ABOUTME: Не делает сетевых запросов и не смешивает страницы разных чатов.
type Page = { messages: unknown[]; nextCursor: string | null };
/** Проверяет ответ и добавляет его к предыдущей странице только при запросе продолжения. */
export function mergeChatPage(previous: unknown, value: unknown, continuation: boolean): Page {
 if (!value || typeof value !== "object" || !("messages" in value) || !Array.isArray(value.messages) || !("nextCursor" in value) || !(value.nextCursor === null || typeof value.nextCursor === "string" && value.nextCursor.length > 0)) throw new Error("Не удалось загрузить сообщения.");
 if (continuation) {
  if (!previous || typeof previous !== "object" || !("messages" in previous) || !Array.isArray(previous.messages)) throw new Error("Не удалось продолжить чтение чата.");
  return { messages: [...previous.messages, ...value.messages], nextCursor: value.nextCursor };
 }
 return { messages: value.messages, nextCursor: value.nextCursor };
}
