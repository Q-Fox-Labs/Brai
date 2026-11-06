// ABOUTME: Показывает данные выбранного пользователя понятными записями.
// ABOUTME: Выводит только поля ответа; содержимое остаётся обычным текстом.
type RecordValue = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "";
/** Отображает сообщение, запись памяти или файл и предлагает скачать выбранный файл. */
export function AdminDetail({ value, view, userId }: { value: unknown; view: string; userId: string }) {
 if (!value || typeof value !== "object" || Array.isArray(value)) return <p>Нет данных для отображения.</p>;
 const record = value as RecordValue;
 if (view === "admin-chats-get") {
  const messages = Array.isArray(record.messages) ? record.messages as RecordValue[] : [];
  return <div className="admin-records">{messages.length ? messages.map((item, index) => <article key={text(item.id) || index}><strong>{item.role === "user" ? "Пользователь" : item.role === "assistant" ? "Брай" : text(item.role)}</strong><p>{text(item.text)}</p>{text(item.createdAt) && <small>{text(item.createdAt)}</small>}</article>) : <p>В этом чате пока нет сообщений.</p>}</div>;
 }
 if (view === "admin-memory-get") return <article className="admin-record"><strong>{text(record.kind) || "Запись памяти"}</strong><p>{text(record.text) || text(record.memory) || "Запись пуста."}</p>{text(record.createdAt) && <small>{text(record.createdAt)}</small>}</article>;
 if (view === "admin-artifacts-get") {
  const artifactId = text(record.artifactId);
  const query = new URLSearchParams({ operation: "admin-artifacts-download", userId, artifactId });
  return <article className="admin-record"><strong>{text(record.title) || text(record.filename) || "Файл"}</strong><p>{text(record.filename)}</p><small>{text(record.mimeType)} {typeof record.sizeBytes === "number" ? `· ${record.sizeBytes} байт` : ""}</small>{artifactId && <a className="admin-download" href={`/api/admin?${query}`}>Скачать файл</a>}</article>;
 }
 return <p>Выберите запись, чтобы увидеть подробности.</p>;
}
