// ABOUTME: Извлекает доступный текст результата native MCP и dynamic tools.
// ABOUTME: Не сериализует изображения, бинарные данные, structuredContent или metadata.

/** Возвращает статус и native текст; вызывающий модуль применяет свой предел UTF-8. */
export function toolText(item: Record<string, any>): string {
  const status = typeof item.status === "string" ? item.status : "unknown";
  if (item.type === "mcpToolCall") {
    const content = Array.isArray(item.result?.content) ? item.result.content : [];
    const text = content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text);
    if (typeof item.error?.message === "string") text.push(item.error.message);
    return `status=${status}\n${text.join("\n")}`;
  }
  if (item.type === "dynamicToolCall") {
    const content = Array.isArray(item.contentItems) ? item.contentItems : [];
    const text = content.filter((part: any) => part?.type === "inputText" && typeof part.text === "string").map((part: any) => part.text);
    return `status=${status}; success=${typeof item.success === "boolean" ? item.success : "unknown"}\n${text.join("\n")}`;
  }
  return "";
}
