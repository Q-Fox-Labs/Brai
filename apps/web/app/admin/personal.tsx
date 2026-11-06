"use client";
// ABOUTME: Показывает администратору личные сервисы выбранного пользователя.
// ABOUTME: Каждый запрос сохраняет выбранного владельца и проходит серверный аудит.
import { useEffect, useRef, useState } from "react";
type RecordValue = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "";
export function AdminPersonalSection({ userId }: { userId: string }) {
 const [kind, setKind] = useState(""), [error, setError] = useState("");
 const [value, setValue] = useState<{ title: string; data: unknown; nextCursor: string | null } | null>(null);
 const selection = useRef(0);
 useEffect(() => () => { selection.current++; }, [userId]);
 async function load(service: string, cursor?: string) {
  const current = ++selection.current;
  setKind(service); setValue(null); setError("");
  try {
   const query = new URLSearchParams({ operation: "admin-personal-get", userId, service, ...(cursor ? { cursor } : {}) });
   const response = await fetch("/api/admin?" + query, { cache: "no-store" });
   const body = await response.json();
   if (!response.ok) throw new Error("Не удалось прочитать данные выбранного пользователя.");
   if (selection.current === current) setValue(body);
  } catch (error) { if (selection.current === current) setError(error instanceof Error ? error.message : "Ошибка чтения"); }
 }
 const data = value?.data && typeof value.data === "object" ? value.data as Record<string, unknown> : {};
 const labels: Record<string, string> = { items: "Записи", intervals: "Интервалы", goals: "Цели", entries: "Записи", resources: "Ресурсы", needs: "Потребности", allocations: "Распределение" };
 const groups = Object.entries(data).filter(([, rows]) => Array.isArray(rows)) as [string, RecordValue[]][];
 return <section className="admin-data"><h2>Личные сервисы выбранного пользователя</h2>
  <nav className="admin-tabs" aria-label="Личные сервисы">{Object.entries({ history: "История", timer: "Таймер", alerts: "Уведомления", goals: "Цели" }).map(([service, label]) =>
   <button type="button" key={service} aria-pressed={kind === service} onClick={() => void load(service)}>{label}</button>)}</nav>
  {error && <p role="alert">{error}</p>}
  {value && <><h3>{value.title}</h3>{groups.map(([name, rows]) => <div key={name}><h4>{labels[name] ?? "Записи"}</h4>
   {rows.length ? rows.map((row, index) => <article className="admin-record" key={text(row.id ?? row.timerId) || index}>
    <strong>{text(row.title ?? row.name ?? row.content ?? row.text ?? row.startedAt ?? row.started_at) || "Запись"}</strong>
    <details><summary>Подробности</summary><pre>{JSON.stringify(row, null, 2)}</pre></details>
   </article>) : <p>Здесь пока нет записей.</p>}</div>)}
   <details><summary>Все сведения</summary><pre>{JSON.stringify(value.data, null, 2)}</pre></details>
   {value.nextCursor && <button type="button" onClick={() => void load(kind, value.nextCursor!)}>Следующая страница</button>}
  </>}
 </section>;
}
