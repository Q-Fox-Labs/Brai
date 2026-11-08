"use client";
// ABOUTME: Показывает управление пользователями и приглашениями администратора.
// ABOUTME: Данные памяти и чатов запрашиваются только после выбора пользователя.
import { useEffect, useRef, useState } from "react";
import { AdminDetail } from "./detail";
import { AdminPersonalSection } from "./personal";
import { ArchiveTarget, ARCHIVE_TARGET } from "./archive-target";
import { InviteCommand } from "./invite-command";
import { mergeChatPage } from "./chat-pages";
import { loadMemoryDetail } from "./memory-detail";
import "./styles.css";
type Operation = { id: string; requestId: string; kind: "prepare" | "stop"; state: "pending" | "running" | "succeeded" | "failed" | "cancelled"; errorCode?: string | null };
type User = { id: string; name: string; role: "admin" | "user"; status: "active" | "blocked" | "provisioning"; telegramId: string | null; profileId: string | null; lifecycle?: Operation | null };
type RequestRecord = { requestId: string; operation: "users-add" | "users-revoke"; telegramId?: string; userId?: string };
const REQUESTS_KEY = "brai-admin-access-requests";
const inProgress = (operation?: Operation | null) => operation?.state === "pending" || operation?.state === "running";
function userStatus(user: User) {
 const op = user.lifecycle;
 if (inProgress(op)) return op?.kind === "stop" ? "Отзыв" : "Подготовка";
 if (op?.state === "failed") return "Ошибка";
 if (user.status === "blocked") return op?.kind === "stop" && op.state === "succeeded" ? "Доступ отозван, процесс остановлен" : "Доступ отозван";
 return user.status === "provisioning" ? "Подготовка" : "Активен";
}
type Invite = { id: string; expiresAt: string; revokedAt: string | null; consumedAt: string | null; code?: string };
async function call(operation: string, input: Record<string, string> = {}, write = false) {
 const response = await fetch(write ? "/api/admin" : `/api/admin?${new URLSearchParams({ operation, ...input })}`, write ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation, ...input }) } : { cache: "no-store" });
 const body = await response.json();
 if (!response.ok) throw new Error(body.code === "LAST_ADMIN" ? "Нельзя понизить последнего администратора или отозвать его доступ." : write ? "Результат изменения не подтверждён. Проверьте текущее состояние перед повтором." : "Не удалось загрузить данные. Проверьте доступ и повторите.");
 return body;
}
/** Управляет аккаунтами; выбранная цель всегда передаётся явно. */
export default function AdminScreen() {
 const [users, setUsers] = useState<User[]>([]), [invites, setInvites] = useState<Invite[]>([]), [selected, setSelected] = useState<string | null>(null);
 const [userFilter, setUserFilter] = useState<"all" | "available" | "revoked">("available");
 const [detail, setDetail] = useState<unknown>(null), [error, setError] = useState(""), [code, setCode] = useState("");
 const [telegramId, setTelegramId] = useState(""), [requests, setRequests] = useState<RequestRecord[]>([]), [busy, setBusy] = useState(false);
 const requestsRef = useRef<RequestRecord[]>([]);
 const [accessError, setAccessError] = useState<{ requestId: string; message: string } | null>(null);
 const [loadError, setLoadError] = useState("");
 function saveRequests(next: RequestRecord[]) { requestsRef.current = next; setRequests(next); sessionStorage.setItem(REQUESTS_KEY, JSON.stringify(next)); }
 function settleRequest(requestId: string) {
  saveRequests(requestsRef.current.filter(item => item.requestId !== requestId));
  setAccessError(previous => previous?.requestId === requestId ? null : previous);
 }
 async function load() { try { const [u, i] = await Promise.all([call("users-list"), call("invite-list")]); setUsers(u.users); setInvites(i.invites); setLoadError(""); } catch (e) { setLoadError(e instanceof Error ? e.message : "Ошибка загрузки"); } }
 useEffect(() => {
  try { const saved = JSON.parse(sessionStorage.getItem(REQUESTS_KEY) || "[]"); if (Array.isArray(saved)) { requestsRef.current = saved; setRequests(saved); } } catch { sessionStorage.removeItem(REQUESTS_KEY); }
  void load();
 }, []);
 async function reconcile(records: RequestRecord[]) {
  for (const record of records) {
   try {
    const result = await call("users-operation-get", { requestId: record.requestId });
    if (result.user && result.operation && !inProgress(result.operation) && requestsRef.current.some(item => item.requestId === record.requestId)) { selection.current++; setSelected(result.user.id); }
    if (result.operation && !inProgress(result.operation)) settleRequest(record.requestId);
   } catch { /* Неизвестный результат остаётся для следующей проверки. */ }
  }
  await load();
  setRequests([...requestsRef.current]);
 }
 useEffect(() => {
  const ids = new Set(requests.map(item => item.requestId));
  const active: RequestRecord[] = users.flatMap(user => inProgress(user.lifecycle) && user.lifecycle && !ids.has(user.lifecycle.requestId) ? [{ requestId: user.lifecycle.requestId, operation: user.lifecycle.kind === "prepare" ? "users-add" : "users-revoke" }] : []);
  if (!requests.length && !active.length) return;
  const timer = window.setTimeout(() => { void reconcile([...requests, ...active]); }, 2000);
  return () => window.clearTimeout(timer);
 }, [requests, users]);
 async function retryRequest(record: RequestRecord) {
  if (busy) return;
  setBusy(true); setError("");
  try {
   const status = await call("users-operation-get", { requestId: record.requestId });
   if (status.operation) { await reconcile([record]); return; }
   const { operation, ...input } = record;
   const result = await call(operation, input as Record<string, string>, true);
   if (result.user) { selection.current++; setSelected(result.user.id); setDetail(null); }
   if (!result.operation || !inProgress(result.operation)) settleRequest(record.requestId);
   await load();
  } catch { setAccessError({ requestId: record.requestId, message: "Результат запроса не подтверждён. Проверяем текущее состояние." }); }
  finally { setBusy(false); }
 }
 async function access(operation: RequestRecord["operation"], input: { telegramId?: string; userId?: string }) {
  if (busy) return;
  if (operation === "users-add" && (!input.telegramId || !/^[1-9][0-9]{0,19}$/.test(input.telegramId))) { setError("Введите положительный Telegram ID: до 20 цифр, без ведущих нулей."); return; }
  if (requestsRef.current.some(item => item.operation === operation && (input.telegramId ? item.telegramId === input.telegramId : item.userId === input.userId))) { setError("Результат предыдущего запроса ещё не подтверждён. Дождитесь проверки."); return; }
  const record: RequestRecord = { requestId: crypto.randomUUID(), operation, ...input };
  saveRequests([...requestsRef.current, record]); setBusy(true); setError("");
  try {
   const value = await call(operation, { requestId: record.requestId, ...input } as Record<string, string>, true);
   if (value.user) { selection.current++; setSelected(value.user.id); setDetail(null); }
   if (!value.operation || !inProgress(value.operation)) settleRequest(record.requestId);
   setTelegramId(""); await load();
  } catch (e) {
   if (e instanceof Error && e.message.startsWith("Нельзя")) { settleRequest(record.requestId); setError(e.message); }
   else setAccessError({ requestId: record.requestId, message: "Результат запроса не подтверждён. Проверяем текущее состояние." });
   await reconcile([record]);
  } finally { setBusy(false); }
 }
 async function mutate(operation: string, input: Record<string, string> = {}) { if (input.userId === ARCHIVE_TARGET) return; try { const value = await call(operation, input, true); if (value.invite?.code) setCode(value.invite.code); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Ошибка"); } }
 const [view, setView] = useState("");
 const selection = useRef(0);
 const [chatId, setChatId] = useState("");
 useEffect(() => { setView(""); setChatId(""); }, [selected]);
 async function inspect(operation: string, extra: Record<string, string> = {}) { if (!selected) return; if (operation === "admin-chat-get") operation = "admin-chats-get"; const current = ++selection.current; try { const value = operation === "admin-memory-get" ? await loadMemoryDetail(selected, extra.memoryId, cursor => {
   if (current !== selection.current) throw new Error("Выбор изменился.");
   return call(operation, { userId: selected, memoryId: extra.memoryId, ...(cursor ? { cursor } : {}) });
  }) : await call(operation, { userId: selected, ...extra }); if (current !== selection.current) return; if (operation === "admin-chats-get") { if (extra.cursor && extra.chatId !== chatId) throw new Error("Не удалось продолжить чтение чата."); setDetail(mergeChatPage(detail, value, !!extra.cursor)); setChatId(extra.chatId); } else setDetail(value); setView(operation); setError(""); } catch (e) { if (current === selection.current) setError(e instanceof Error ? e.message : "Ошибка"); } }
 const rawPage = detail && typeof detail === "object" ? detail as { items?: { id?: string; artifactId?: string; title?: string; filename?: string; text?: string }[]; nextCursor?: string | null } : null;
 const chatCursor = view === "admin-chats-get" && detail && typeof detail === "object" && "nextCursor" in detail && typeof detail.nextCursor === "string" ? detail.nextCursor : null;
 const page = rawPage?.items ? { nextCursor: rawPage.nextCursor, items: rawPage.items.map(item => ({ ...item, id: item.id || item.artifactId || "", title: item.title || item.filename })) } : null;
 const visibleUsers = users.filter(user => user.id !== ARCHIVE_TARGET);
 function userCard(user: User) { return <article key={user.id} className="rounded-lg border p-4 space-y-2">
  <p><strong>{user.name || "Пользователь"}</strong> · Telegram: {user.telegramId ?? "—"} · Профиль: {user.profileId ?? "—"}</p><p>Роль: {user.role === "admin" ? "администратор" : "пользователь"} · Статус: {userStatus(user)}</p>
  <div className="flex flex-wrap gap-3"><button type="button" aria-pressed={selected === user.id} onClick={() => { selection.current++; setSelected(user.id); setDetail(null); }}>{selected === user.id ? "Выбран" : "Выбрать"}</button>
   <button type="button" onClick={() => void mutate("role-set", { userId: user.id, role: user.role === "admin" ? "user" : "admin" })}>{user.role === "admin" ? "Сделать пользователем" : "Сделать администратором"}</button>
   {user.status === "blocked" ? user.telegramId && <button type="button" disabled={busy || inProgress(user.lifecycle)} onClick={() => void access("users-add", { telegramId: user.telegramId! })}>Восстановить доступ</button> : <button type="button" disabled={busy} onClick={() => { if (window.confirm("Доступ к боту и сайту будет закрыт. Переписка, память и файлы сохранятся")) void access("users-revoke", { userId: user.id }); }}>Отозвать доступ</button>}
   {user.lifecycle?.kind === "prepare" && user.lifecycle.state === "failed" && user.telegramId && <button type="button" disabled={busy} onClick={() => void access("users-add", { telegramId: user.telegramId! })}>Повторить подготовку</button>}
   {user.lifecycle?.kind === "stop" && user.lifecycle.state === "failed" && <button type="button" disabled={busy} onClick={() => { if (window.confirm("Доступ к боту и сайту будет закрыт. Переписка, память и файлы сохранятся")) void access("users-revoke", { userId: user.id }); }}>Повторить отзыв</button>}
   <button type="button" onClick={() => void mutate("sessions-revoke", { userId: user.id })}>Завершить сессии</button></div></article>; }
 return <main className="admin-screen"><a className="admin-back" href="/">← Назад в Brai</a><header className="admin-heading"><div><h1>Админка</h1><p>Пользователи, приглашения и доступ к данным</p></div></header>
  {error && <p role="alert">{error}</p>}
  {loadError && <p role="alert">{loadError}</p>}
  {accessError && <p role="alert">{accessError.message}</p>}
  <section className="space-y-3"><h2>Пользователи</h2>
   <form className="admin-add-user" onSubmit={event => { event.preventDefault(); void access("users-add", { telegramId }); }}><label htmlFor="telegram-id">Telegram ID</label><div><input id="telegram-id" inputMode="numeric" value={telegramId} onChange={event => setTelegramId(event.target.value)} maxLength={20} autoComplete="off" /><button type="submit" disabled={busy}>Дать доступ</button></div></form>
   <div className="admin-user-filters" role="group" aria-label="Фильтр пользователей"><button type="button" aria-pressed={userFilter === "all"} onClick={() => setUserFilter("all")}>Все</button><button type="button" aria-pressed={userFilter === "available"} onClick={() => setUserFilter("available")}>С доступом</button><button type="button" aria-pressed={userFilter === "revoked"} onClick={() => setUserFilter("revoked")}>Доступ отозван</button></div>
   {requests.map(record => <div key={record.requestId} className="admin-request"><p role="status">Проверяем результат запроса {record.telegramId || record.userId}. Если проверка не находит операцию, можно повторить запрос.</p><button type="button" disabled={busy} onClick={() => void retryRequest(record)}>Проверить и повторить</button></div>)}
   {userFilter !== "revoked" && visibleUsers.filter(user => user.status !== "blocked").map(userCard)}
  </section>
  {userFilter !== "available" && <section className="space-y-3"><h2>Доступ отозван</h2>{visibleUsers.filter(user => user.status === "blocked").map(userCard)}</section>}
  {selected && selected !== ARCHIVE_TARGET && <AdminPersonalSection key={selected} userId={selected} />}
  <ArchiveTarget selected={selected === ARCHIVE_TARGET} onSelect={() => { selection.current++; setSelected(ARCHIVE_TARGET); setDetail(null); }} />
  {selected && <section className="admin-data"><h2>Данные: {selected === ARCHIVE_TARGET ? "Архив до разделения" : users.find(user => user.id === selected)?.name || "Пользователь"}</h2><nav className="admin-tabs" aria-label="Данные выбранного источника"><button type="button" aria-pressed={view.startsWith("admin-memory")} onClick={() => void inspect("admin-memory-list")}>Память</button><button type="button" aria-pressed={view.startsWith("admin-chat")} onClick={() => void inspect("admin-chats-list")}>Чаты</button><button type="button" aria-pressed={view.startsWith("admin-artifacts")} onClick={() => void inspect("admin-artifacts-list")}>Файлы</button></nav>{page?.items ? <><ul className="admin-items">{page.items.map(item => <li key={item.id}><button type="button" onClick={() => void inspect(view === "admin-memory-list" ? "admin-memory-get" : view === "admin-chats-list" ? "admin-chat-get" : "admin-artifacts-get", { [view === "admin-memory-list" ? "memoryId" : view === "admin-chats-list" ? "chatId" : "artifactId"]: item.id })}>{item.title || item.text || item.id}</button></li>)}</ul>{!page.items.length && <p className="admin-empty">Здесь пока нет записей.</p>}{page.nextCursor && <button type="button" onClick={() => void inspect(view, { cursor: page.nextCursor! })}>Следующая страница</button>}</> : detail !== null ? <AdminDetail value={detail} view={view} userId={selected} /> : <p className="admin-empty">Выберите раздел, чтобы открыть данные.</p>}</section>}
  {selected && chatId && chatCursor && <button type="button" onClick={() => void inspect("admin-chat-get", { chatId, cursor: chatCursor })}>Загрузить ещё сообщения</button>}
  <section className="space-y-3"><h2 className="text-xl font-semibold">Приглашения</h2><button type="button" onClick={() => void mutate("invite-create")}>Создать приглашение</button>{code && <InviteCommand key={code} code={code} />}
   {invites.map(invite => <p key={invite.id}>{invite.id} · до {invite.expiresAt} · {invite.revokedAt ? "отозвано" : invite.consumedAt ? "использовано" : "действует"} {!invite.revokedAt && !invite.consumedAt && <button type="button" onClick={() => void mutate("invite-revoke", { inviteId: invite.id })}>Отозвать</button>}</p>)}</section>
 </main>;
}
