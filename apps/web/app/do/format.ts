// ABOUTME: Сохраняет исходное отображение даты задачника September.
// ABOUTME: Форматирует синтетические даты в часовом поясе браузера.
const shortMonthFormatter = new Intl.DateTimeFormat("ru-RU", { month: "short" });

/** Возвращает дату и время в исходном кратком русском формате. */
export function formatShortDateTime(value: number | Date) {
  const date = value instanceof Date ? value : new Date(value);
  const day = String(date.getDate()).padStart(2, "0");
  const month = shortMonthFormatter.format(date).replace(/\.$/, "");
  const year = date.getFullYear() === new Date().getFullYear() ? "" : ` ${date.getFullYear()}`;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${day} ${month}${year} ${hours}:${minutes}`;
}
