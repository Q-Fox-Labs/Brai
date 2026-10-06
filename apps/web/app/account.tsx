"use client";
// ABOUTME: Показывает вход и сохраняет посещённые экраны текущего аккаунта.
// ABOUTME: Смена сессии размонтирует клиент и прекращает его очередь, запросы и SSE.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Timer from "./timer";
import AgentScreen from "./agent/screen";
import DoScreen from "./do/screen";
import Navigation from "./navigation";
import "./navigation.css";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { BraiBrandIcon } from "@/components/ui/brai-brand-icon";
import { LoginGalaxy } from "./shell/login-galaxy";
type User = { id: string; email: string };
/** Собирает общую оболочку; таймер явно передаёт отсчёт в навигацию текущего аккаунта. */
export default function Account() {
 const [timerElapsed, setTimerElapsed] = useState<string | null>(null);
 return <AccountSession timerElapsed={timerElapsed} onTimerElapsed={setTimerElapsed} />;
}
/** Управляет подтверждённой сервером сессией без хранения токена в браузере. */
function AccountSession({ timerElapsed, onTimerElapsed }: { timerElapsed: string | null; onTimerElapsed: (elapsed: string | null) => void }) {
 const pathname = usePathname();
 const view = pathname === "/agent" ? "agent" : pathname === "/do" ? "do" : "timer";
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
 if (!ready) return <div className="workspace-shell brai-workspace-shell"><main className="p-8" role="status">Проверяем вход…</main></div>;
 if (user && !exiting) return <div className="workspace-shell brai-workspace-shell">
  <Navigation key={user.id} timerElapsed={timerElapsed} email={user.email} onLogout={() => { void logout(); }} />
  <div className="workspace-content"><AccountScreens key={user.id} view={view} user={user} onLogout={() => { void logout(); }} onUnauthorized={unauthorized} accountMessage={message} onTimerElapsed={onTimerElapsed} /></div>
 </div>;
 if (exiting) return <div className="workspace-shell brai-workspace-shell"><main className="p-8" role="status">Выходим…</main></div>;
 return <div className="workspace-shell brai-workspace-shell brai-auth-shell">
  <main className="brai-login-surface dark">
   <LoginGalaxy />
   <Card className="brai-login-card">
    <CardHeader className="brai-login-header">
     <BraiBrandIcon className="size-9" />
     <CardTitle className="text-2xl">Вход в Brai</CardTitle>
     <CardDescription>{sent ? <>Письмо с кодом отправлено на {email}</> : "Продолжите работу с личным пространством"}</CardDescription>
    </CardHeader>
    <CardContent>
     <form onSubmit={event => { event.preventDefault(); void submit(sent ? "verify-code" : "send-code"); }} className="flex flex-col gap-4">
      <Field>
       <FieldLabel htmlFor={sent ? "otp" : "email"}>{sent ? "Код из письма" : "Почта"}</FieldLabel>
       {sent
        ? <Input ref={codeInput} id="otp" name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className="h-12 text-center text-2xl tracking-[.3em]" />
        : <Input id="email" name="email" type="email" autoComplete="email" required autoFocus value={email} onChange={event => setEmail(event.target.value)} className="h-12" />}
      </Field>
      <Button disabled={busy} className="h-12 w-full">{busy ? "Подождите…" : sent ? "Войти" : "Получить код"}</Button>
     </form>
     {sent && <div className="mt-4 flex flex-wrap justify-between gap-3 text-sm">
      <Button variant="link" size="sm" disabled={busy} onClick={() => { setSent(false); setCode(""); setMessage(""); }}>Изменить почту</Button>
      <Button variant="link" size="sm" disabled={busy} onClick={() => { void submit("send-code"); }}>Отправить код ещё раз</Button>
     </div>}
     <p role="status" aria-live="polite" className="mt-3 min-h-6 text-sm text-muted-foreground">{message}</p>
    </CardContent>
   </Card>
  </main>
 </div>;
}

/** Сохраняет состояние посещённых экранов; выход или смена пользователя удаляют их. */
function AccountScreens({ view, user, onLogout, onUnauthorized, accountMessage, onTimerElapsed }: { view: "agent" | "timer" | "do"; user: User; onLogout: () => void; onUnauthorized: () => void; accountMessage: string; onTimerElapsed: (elapsed: string | null) => void }) {
 const [visited, setVisited] = useState({ agent: view === "agent", do: view === "do" });
 useEffect(() => { if (view !== "timer") setVisited(previous => previous[view] ? previous : { ...previous, [view]: true }); }, [view]);
 const props = { userId: user.id, email: user.email, onLogout, onUnauthorized, accountMessage };
 // AIDEV-NOTE: Таймер подключён сразу для отсчёта в шапке; hidden сохраняет клиентов при переходах.
 return <>
  <div className="workspace-screen" hidden={view !== "agent"}>{(visited.agent || view === "agent") && <AgentScreen {...props} active={view === "agent"} />}</div>
  <div className="workspace-screen workspace-timer" hidden={view !== "timer"}><Timer userId={user.id} onUnauthorized={onUnauthorized} accountMessage={accountMessage} onElapsed={onTimerElapsed} /></div>
  <div className="workspace-screen" hidden={view !== "do"}>{(visited.do || view === "do") && <DoScreen {...props} active={view === "do"} />}</div>
 </>;
}
