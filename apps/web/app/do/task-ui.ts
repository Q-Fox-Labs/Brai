// ABOUTME: Сохраняет DOM-помощники редактора и действия видов September.
// ABOUTME: Позиция курсора определяется точкой клика; browser storage не используется.
import type { TaskKind } from "./model";

export type DetailField = "description" | "result";

export const TASK_KIND_ACTIONS: ReadonlyArray<{
  kind: TaskKind;
  label: string;
  error: string;
}> = [
  { kind: "task", label: "Это Задача", error: "Не удалось сделать запись задачей" },
  { kind: "goal", label: "Это Цель", error: "Не удалось сделать запись целью" },
  { kind: "quest", label: "Это Квест", error: "Не удалось сделать запись квестом" },
  { kind: "mission", label: "Это Миссия", error: "Не удалось сделать запись миссией" },
];

/** Нормализует строку поиска по русским названиям. */
export function normalizedSearchText(value: string) {
  return value.trim().toLocaleLowerCase("ru-RU");
}

/** Проверяет границу слова в названии. */
export function startsAtWord(title: string, index: number) {
  return index === 0 || !/[a-zа-яё0-9]/i.test(title[index - 1]);
}

/** Обновляет исходный индикатор прокрутки текстового редактора. */
export function updateTaskDetailScrollbar(element: HTMLTextAreaElement) {
  const shell = element.closest<HTMLElement>("[data-task-detail-editor]");
  const thumb = shell?.querySelector<HTMLElement>("[data-task-detail-scrollbar-thumb]");
  if (!shell || !thumb) return;

  const isOverflowing = element.scrollHeight > element.clientHeight + 1;
  shell.dataset.overflowing = String(isOverflowing);
  if (!isOverflowing) return;

  const thumbHeight = Math.max(
    8,
    element.clientHeight * (element.clientHeight / element.scrollHeight),
  );
  const maximumThumbTop = element.clientHeight - thumbHeight;
  const maximumScrollTop = element.scrollHeight - element.clientHeight;
  const thumbTop = maximumScrollTop > 0
    ? maximumThumbTop * (element.scrollTop / maximumScrollTop)
    : 0;
  thumb.style.height = `${thumbHeight}px`;
  thumb.style.transform = `translateY(${thumbTop}px)`;
}

/** Ограничивает редактор двумя строками, сохраняя прокрутку. */
export function resizeTaskDetail(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
  element.style.height = `${Math.min(element.scrollHeight, lineHeight * 2)}px`;
  updateTaskDetailScrollbar(element);
  window.requestAnimationFrame(() => updateTaskDetailScrollbar(element));
}

/** Возвращает позицию символа в тексте в точке клика. */
export function detailOffsetAtPoint(
  element: HTMLElement,
  clientX: number,
  clientY: number,
) {
  const ownerDocument = element.ownerDocument;
  const caretPosition = ownerDocument.caretPositionFromPoint?.(clientX, clientY);
  let offsetNode = caretPosition?.offsetNode ?? null;
  let offset = caretPosition?.offset ?? 0;

  if (!offsetNode) {
    const legacyDocument = ownerDocument as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const caretRange = legacyDocument.caretRangeFromPoint?.(clientX, clientY);
    offsetNode = caretRange?.startContainer ?? null;
    offset = caretRange?.startOffset ?? 0;
  }

  if (!offsetNode || (offsetNode !== element && !element.contains(offsetNode))) return 0;

  const textRange = ownerDocument.createRange();
  textRange.selectNodeContents(element);
  textRange.setEnd(offsetNode, offset);
  return textRange.toString().length;
}
