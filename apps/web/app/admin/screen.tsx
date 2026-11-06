"use client";
// ABOUTME: Показывает управление пользователями и приглашениями администратора.
// ABOUTME: Данные памяти и чатов запрашиваются только после выбора пользователя.
import { useEffect, useRef, useState } from "react";
import { AdminDetail } from "./detail";
import { ArchiveTarget, ARCHIVE_TARGET } from "./archive-target";
import { InviteCommand } from "./invite-command";
import { mergeChatPage } from "./chat-pages";
import "./styles.css";
type User = { id: string; name: string; role: "admin" | "user"; status: "active" | "blocked" | "provisioning"; telegramId: string | null; profileId: string | null };
type Invite = { id: string; expiresAt: string; revokedAt: string | null; consumedAt: string | null; code?: string };
async function call(operation: string, input: Record<string, string> = {}, write = false) {
 const response = await fetch(write ? "/api/admin" : `/api/admin?${new URLSearchParams({ operation, ...input })}`, write ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation, ...input }) } : { cache: "no-store" });
 const body = await response.json();
 if (!response.ok) throw new Error(body.code === "LAST_ADMIN" ? "Нельзя понизить или заблокировать последнего администратора." : write ? "Результат изменения не подтверждён. Проверьте текущее состояние перед повтором." : "Не удалось загрузить данные. Проверьте доступ и повторите.");
 return body;
}
/** Управляет аккаунтами; выбранная цель всегда передаётся явно. */
export default function AdminScreen() {
 const [users, setUsers] = useState<User[]>([]), [invites, setInvites] = useState<Invite[]>([]), [selected, setSelected] = useState<string | null>(null);
 const [detail, setDetail] = useState<unknown>(null), [error, setError] = useState(""), [code, setCode] = useState("");
 async function load() { try { const [u, i] = await Promise.all([call("users-list"), call("invite-list")]); setUsers(u.users); setInvites(i.invites); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Ошибка загрузки"); } }
 useEffect(() => { void load(); }, []);
 async function mutate(operation: string, input: Record<string, string> = {}) { if (input.userId === ARCHIVE_TARGET) return; try { const value = await call(operation, input, true); if (value.invite?.code) setCode(value.invite.code); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Ошибка"); } }
 const [view, setView] = useState("");
 const selection = useRef(0);
 const [chatId, setChatId] = useState("");
 useEffect(() => { setView(""); setChatId(""); }, [selected]);
 async function inspect(operation: string, extra: Record<string, string> = {}) { if (!selected) return; if (operation === "admin-chat-get") operation = "admin-chats-get"; const current = ++selection.current; try { const value = await call(operation, { userId: selected, ...extra }); if (current !== selection.current) return; if (operation === "admin-chats-get") { if (extra.cursor && extra.chatId !== chatId) throw new Error("Не удалось продолжить чтение чата."); setDetail(mergeChatPage(detail, value, !!extra.cursor)); setChatId(extra.chatId); } else setDetail(value); setView(operation); setError(""); } catch (e) { if (current === selection.current) setError(e instanceof Error ? e.message : "Ошибка"); } }
 const rawPage = detail && typeof detail === "object" ? detail as { items?: { id?: string; artifactId?: string; title?: string; filename?: string; text?: string }[]; nextCursor?: string | null } : null;
 const chatCursor = view === "admin-chats-get" && detail && typeof detail === "object" && "nextCursor" in detail && typeof detail.nextCursor === "string" ? detail.nextCursor : null;
 const page = rawPage?.items ? { nextCursor: rawPage.nextCursor, items: rawPage.items.map(item => ({ ...item, id: item.id || item.artifactId || "", title: item.title || item.filename })) } : null;
 return <main className="admin-screen"><a className="admin-back" href="/">← Назад в Brai</a><header className="admin-heading"><div><h1>Администрирование</h1><p>Пользователи, приглашения и доступ к данным</p></div></header>
  {error && <p role="alert">{error}</p>}
  <section className="space-y-3"><h2 className="text-xl font-semibold">Пользователи</h2>{users.filter(user => user.id !== ARCHIVE_TARGET).map(user => <article key={user.id} className="rounded-lg border p-4 space-y-2">
   <p><strong>{user.name || "Пользователь"}</strong> · Telegram: {user.telegramId ?? "—"} · Профиль: {user.profileId ?? "—"}</p><p>Роль: {user.role === "admin" ? "администратор" : "пользователь"} · Статус: {user.status === "active" ? "активен" : user.status === "blocked" ? "заблокирован" : "подготовка"}</p>
   <div className="flex flex-wrap gap-3"><button type="button" aria-pressed={selected === user.id} onClick={() => { selection.current++; setSelected(user.id); setDetail(null); }}>{selected === user.id ? "Выбран" : "Выбрать"}</button>
    <button type="button" onClick={() => void mutate("role-set", { userId: user.id, role: user.role === "admin" ? "user" : "admin" })}>{user.role === "admin" ? "Сделать пользователем" : "Сделать администратором"}</button>
    <button type="button" onClick={() => void mutate("status-set", { userId: user.id, status: user.status === "blocked" ? "active" : "blocked" })}>{user.status === "blocked" ? "Разблокировать" : "Заблокировать"}</button>
    <button type="button" onClick={() => void mutate("sessions-revoke", { userId: user.id })}>Завершить сессии</button></div></article>)}</section>
  <ArchiveTarget selected={selected === ARCHIVE_TARGET} onSelect={() => { selection.current++; setSelected(ARCHIVE_TARGET); setDetail(null); }} />
  {selected && <section className="admin-data"><h2>Данные: {selected === ARCHIVE_TARGET ? "Архив до разделения" : users.find(user => user.id === selected)?.name || "Пользователь"}</h2><nav className="admin-tabs" aria-label="Данные выбранного источника"><button type="button" aria-pressed={view.startsWith("admin-memory")} onClick={() => void inspect("admin-memory-list")}>Память</button><button type="button" aria-pressed={view.startsWith("admin-chat")} onClick={() => void inspect("admin-chats-list")}>Чаты</button><button type="button" aria-pressed={view.startsWith("admin-artifacts")} onClick={() => void inspect("admin-artifacts-list")}>Файлы</button></nav>{page?.items ? <><ul className="admin-items">{page.items.map(item => <li key={item.id}><button type="button" onClick={() => void inspect(view === "admin-memory-list" ? "admin-memory-get" : view === "admin-chats-list" ? "admin-chat-get" : "admin-artifacts-get", { [view === "admin-memory-list" ? "memoryId" : view === "admin-chats-list" ? "chatId" : "artifactId"]: item.id })}>{item.title || item.text || item.id}</button></li>)}</ul>{!page.items.length && <p className="admin-empty">Здесь пока нет записей.</p>}{page.nextCursor && <button type="button" onClick={() => void inspect(view, { cursor: page.nextCursor! })}>Следующая страница</button>}</> : detail !== null ? <AdminDetail value={detail} view={view} userId={selected} /> : <p className="admin-empty">Выберите раздел, чтобы открыть данные.</p>}</section>}
  {selected && chatId && chatCursor && <button type="button" onClick={() => void inspect("admin-chat-get", { chatId, cursor: chatCursor })}>Загрузить ещё сообщения</button>}
  <section className="space-y-3"><h2 className="text-xl font-semibold">Приглашения</h2><button type="button" onClick={() => void mutate("invite-create")}>Создать приглашение</button>{code && <InviteCommand key={code} code={code} />}
   {invites.map(invite => <p key={invite.id}>{invite.id} · до {invite.expiresAt} · {invite.revokedAt ? "отозвано" : invite.consumedAt ? "использовано" : "действует"} {!invite.revokedAt && !invite.consumedAt && <button type="button" onClick={() => void mutate("invite-revoke", { inviteId: invite.id })}>Отозвать</button>}</p>)}</section>
 </main>;
}
