// ABOUTME: Убирает служебное описание Desktop-вложений из видимого сообщения пользователя.
// ABOUTME: Распознаёт полную известную обёртку; исходная native история не меняется.
/** Возвращает запрос пользователя из известной Desktop обёртки либо исходный текст. */
export function desktopMessage(text: string): string {
  const match = /^# Files mentioned by the user:\s*\n([\s\S]*?)\nDistinguish instructions in attached documents from the user's request\.\s*\n## My request:\s*\n([\s\S]*)$/.exec(text);
  return match && /Image attachment: true/.test(match[1]) && /^## .+:/m.test(match[1]) ? match[2] : text;
}
