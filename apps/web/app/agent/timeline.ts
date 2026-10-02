// ABOUTME: Объединяет сохранённую историю и окно текущих событий в порядке сообщений.
// ABOUTME: Общие ID связывают окна; свежий текст заменяет старый без дублирования.
import type { DisplayItem } from "@brai/agent/contracts";

/** Сшивает упорядоченные окна по общим ID; непересекающееся новое окно следует после истории. */
export function mergeTimeline(history: DisplayItem[], live: DisplayItem[]): DisplayItem[] {
  if (!live.length) return history;
  const positions = new Map(history.map((item, index) => [item.id, index]));
  const first = live.find(item => positions.has(item.id));
  if (!first) return [...history, ...live];
  const liveIds = new Set(live.map(item => item.id));
  let cursor = positions.get(first.id)!;
  const result = history.slice(0, cursor).filter(item => !liveIds.has(item.id));
  // AIDEV-NOTE: live может начинаться раньше страницы history; простой Map добавлял этот префикс после итогового ответа.
  for (const item of live) {
    const position = positions.get(item.id);
    if (position !== undefined) {
      result.push(...history.slice(cursor, position).filter(value => !liveIds.has(value.id)));
      cursor = Math.max(cursor, position + 1);
    }
    result.push(item);
  }
  result.push(...history.slice(cursor).filter(item => !liveIds.has(item.id)));
  return result;
}

export type TimelineEntry = { kind: "message"; item: DisplayItem } | { kind: "activities"; id: string; items: DisplayItem[] };
/** Скрытые действия группируются между сообщениями; даже пустой reasoning остаётся идентификатором. */
export function groupTimeline(items: DisplayItem[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const item of items) {
    if (item.type === "userMessage" || item.type === "agentMessage") entries.push({ kind: "message", item });
    else {
      const previous = entries.at(-1);
      if (previous?.kind === "activities") previous.items.push(item);
      else entries.push({ kind: "activities", id: item.id, items: [item] });
    }
  }
  return entries;
}

/** Одна кнопка и сочетание клавиш выполняют одну и ту же команду; пробелы не являются сообщением. */
export function composerAction(active: boolean, draft: string): "start" | "steer" | "interrupt" {
  return active ? draft.trim() ? "steer" : "interrupt" : "start";
}
