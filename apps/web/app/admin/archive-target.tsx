// ABOUTME: Показывает отдельный архив данных до разделения пользователей.
// ABOUTME: Архив доступен только для чтения и не является учётной записью.
export const ARCHIVE_TARGET = "__quarantine__";
/** Даёт выбрать архив без действий управления пользователями. */
export function ArchiveTarget({ selected, onSelect }: { selected: boolean; onSelect: () => void }) {
 return <section className="admin-archive">
  <h2>Архив до разделения</h2>
  <p>Неподтверждённые источники доступны только администратору.</p>
  <button type="button" aria-pressed={selected} onClick={onSelect}>{selected ? "Архив выбран" : "Открыть архив"}</button>
 </section>;
}
