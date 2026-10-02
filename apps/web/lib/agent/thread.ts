// ABOUTME: Сохраняет известное имя чата при поступлении пустой live metadata.
// ABOUTME: Статус и остальные поля принадлежат более свежему снимку того же чата.
import type { ThreadMetadata } from "@brai/agent/contracts";
/** Пустая пара title/preview сохраняет известную; другой ID не наследует имя. */
export function mergeThreadMetadata(previous: ThreadMetadata | undefined, current: ThreadMetadata): ThreadMetadata {
  return previous?.id === current.id && !current.title.trim() && !current.preview.trim()
    ? { ...current, title: previous.title, preview: previous.preview } : current;
}
