"use client";
// ABOUTME: Показывает вход и сохраняет посещённые экраны текущего аккаунта.
// ABOUTME: Смена сессии размонтирует клиент и прекращает его очередь, запросы и SSE.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Timer from "./timer";
import AgentScreen from "./agent/screen";
type User = { id: string; email: string };
/** Управляет подтверждённой сервером сессией без хранения токена в браузере. */
export default function Account() {
 const view = usePathname() === "/agent" ? "agent" : "timer";
 const [user, setUser] = useState<User | null>(null), [ready, setReady] = useState(false), [exiting, setExiting] = useState(false);
 const [email, setEmail] = useState(""), [code, setCode] = useState(""), [sent, setSent] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
 const locked = useRef(false), codeInput = useRef<HTMLInputElement>(null);
 const generation = useRef(0);
 const refresh = useCallback(async () => {
  const current = generation.current;
  try {
   const response = await fetch("/api/auth/session", { cache: "no-store" });
   if (current !== generation.current) return;
   if (response.ok) { const data = await response.json() as { user: User }; setUser(previous => previous?.id === data.user.id ? previous : data.user); }
   else if (response.status === 401) setUser(null);
  } catch { /* Потеря связи не превращает подтверждённый вход в успешный выход. */ }
  finally { setReady(true); }
 }, []);
 useEffect(() => { void refresh(); const timer = setInterval(() => { if (!locked.current) void refresh(); }, 2000); return () => clearInterval(timer); }, [refresh]);
 useEffect(() => { if (sent && !busy) codeInput.current?.focus(); }, [sent, busy]);
 const submit = async (operation: "send-code" | "verify-code") => {
  if (locked.current) return; locked.current = true; setBusy(true); setMessage("");
  try {
   const response = await fetch(`/api/auth/${operation}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation === "send-code" ? { email } : { email, otp: code }) });
   if (!response.ok) {
    const data = await response.json() as { code?: string };
    if (operation === "verify-code" && data.code === "AUTH_OUTCOME_UNKNOWN") { await refresh(); setMessage("Результат входа уточняется. Если страница не открылась, запросите новый код."); }
    else setMessage(response.status === 429 ? "Слишком много попыток. Подождите и повторите." : operation === "verify-code" ? "Код неверен или истёк. Проверьте его или получите новый." : "Не удалось отправить письмо. Повторите запрос позже.");
    return;
   }
   if (operation === "send-code") { setSent(true); setCode(""); }
   else { await refresh(); setCode(""); }
  } catch { setMessage("Связь прервалась. Проверьте почту или состояние входа перед повтором."); if (operation === "verify-code") await refresh(); }
  finally { locked.current = false; setBusy(false); }
 };
 const unauthorized = useCallback(() => setUser(null), []);
 const logout = async () => {
  if (locked.current) return; locked.current = true; generation.current++; setExiting(true); setMessage("");
  try {
   const response = await fetch("/api/auth/sign-out", { method: "POST" });
   if (!response.ok) { setMessage("Не удалось выйти. Сессия ещё действует; повторите выход."); return; }
   setUser(null); setSent(false); setCode(""); setEmail("");
  } catch { setMessage("Не удалось подтвердить выход. Проверьте соединение и повторите."); }
  finally { locked.current = false; setExiting(false); }
 };
 if (!ready) return <main className="p-8" role="status">Проверяем вход…</main>;
 if (user && !exiting) return <AccountScreens key={user.id} view={view} user={user} onLogout={() => { void logout(); }} onUnauthorized={unauthorized} accountMessage={message} />;
 if (exiting) return <main className="p-8" role="status">Выходим…</main>;
 return <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-12">
  <h1 className="mb-8 text-3xl font-semibold tracking-tight">Brai</h1>
  {sent && <p className="mb-6 break-words text-slate-400">Письмо отправлено на {email}</p>}
  <form onSubmit={event => { event.preventDefault(); void submit(sent ? "verify-code" : "send-code"); }} className="flex flex-col gap-4">
   <label htmlFor={sent ? "otp" : "email"} className="text-sm font-medium">{sent ? "Код из письма" : "Почта"}</label>
   {sent ? <input ref={codeInput} id="otp" name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className="auth-input text-2xl tracking-[.3em]" />
    : <input id="email" name="email" type="email" autoComplete="email" required autoFocus value={email} onChange={event => setEmail(event.target.value)} className="auth-input" />}
   <button disabled={busy} className="rounded-xl bg-blue-600 px-5 py-3 font-medium text-white">{busy ? "Подождите…" : sent ? "Войти" : "Получить код"}</button>
  </form>
  {sent && <div className="mt-5 flex flex-wrap gap-5 text-sm"><button disabled={busy} className="text-blue-300" onClick={() => { setSent(false); setCode(""); setMessage(""); }}>Изменить почту</button><button disabled={busy} className="text-blue-300" onClick={() => { void submit("send-code"); }}>Отправить код ещё раз</button></div>}
  <p role="status" aria-live="polite" className="mt-5 min-h-12 text-sm text-slate-400">{message}</p>
 </main>;
}

/** Сохраняет состояние посещённых экранов; выход или смена пользователя удаляют оба. */
function AccountScreens({ view, user, onLogout, onUnauthorized, accountMessage }: { view: "agent" | "timer"; user: User; onLogout: () => void; onUnauthorized: () => void; accountMessage: string }) {
 const [visited, setVisited] = useState({ agent: view === "agent", timer: view === "timer" });
 useEffect(() => { setVisited(previous => previous[view] ? previous : { ...previous, [view]: true }); }, [view]);
 const props = { userId: user.id, email: user.email, onLogout, onUnauthorized, accountMessage };
 // AIDEV-NOTE: hidden сохраняет черновик, очередь и SSE; второй клиент создаётся только после посещения вкладки.
 return <>
  <div className="workspace-screen" hidden={view !== "agent"}>{(visited.agent || view === "agent") && <AgentScreen {...props} active={view === "agent"} />}</div>
  <div className="workspace-screen workspace-timer" hidden={view !== "timer"}>{(visited.timer || view === "timer") && <Timer {...props} />}</div>
 </>;
}
