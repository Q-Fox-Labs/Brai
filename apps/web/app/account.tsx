"use client";
// ABOUTME: Показывает вход и сохраняет посещённые экраны текущего аккаунта.
// ABOUTME: Смена сессии размонтирует клиент и прекращает его очередь, запросы и SSE.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import type { AccountSession as InitialSession } from "@/server/account-session";
import type { WebAgentMode } from "@/server/web-config";
import Timer from "./timer";
import AgentScreen from "./agent/screen";
import TelegramAgentEntry from "./agent/telegram-entry";
import DoScreen from "./do/screen";
import Navigation from "./navigation";
import GameCoreScreen from "./game-core/screen";
import { AlertsProvider } from "./alerts/provider";
import AlertsScreen from "./alerts/screen";
import "./navigation.css";
import { Button } from "@/components/ui/button";
import { AuthRequestError, AuthScreen, type OtpSendResult } from "./auth/screen";
type User = { id: string; email: string };
/** Собирает общую оболочку; таймер явно передаёт отсчёт в навигацию текущего аккаунта. */
export default function Account({ initialSession, agentMode = "dev_agent", telegramBotUsername = null }: { initialSession: InitialSession; agentMode?: WebAgentMode; telegramBotUsername?: string | null }) {
 const [timerElapsed, setTimerElapsed] = useState<string | null>(null);
 return <AccountSession initialSession={initialSession} agentMode={agentMode} telegramBotUsername={telegramBotUsername} timerElapsed={timerElapsed} onTimerElapsed={setTimerElapsed} />;
}
/** Управляет подтверждённой сервером сессией без хранения токена в браузере. */
function AccountSession({ initialSession, agentMode, telegramBotUsername, timerElapsed, onTimerElapsed }: { initialSession: InitialSession; agentMode: WebAgentMode; telegramBotUsername: string | null; timerElapsed: string | null; onTimerElapsed: (elapsed: string | null) => void }) {
 const pathname = usePathname();
 const view = pathname === "/game-core" ? "game-core" : pathname === "/agent" ? "agent" : pathname === "/do" ? "do" : pathname === "/alerts" ? "alerts" : "timer";
 const [user, setUser] = useState<User | null>(() => initialSession.status === "authenticated" ? initialSession.user : null), [ready, setReady] = useState(initialSession.status !== "unavailable"), [exiting, setExiting] = useState(false);
 const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
 const locked = useRef(false);
 const verificationPending = useRef<{ email: string; accepted: boolean } | null>(null);
 useEffect(() => { if (pathname === "/auth" && user) window.location.replace("/"); else if (pathname !== "/auth" && ready && !user && !exiting) window.location.replace("/auth"); }, [pathname, user, ready, exiting]);
 const generation = useRef(0);
 const refreshRequest = useRef<AbortController | null>(null);
 const refresh = useCallback(async (expectedEmail?: string) => {
  expectedEmail ??= verificationPending.current?.email;
  if (refreshRequest.current) return false;
  const current = generation.current;
  const request = new AbortController(); refreshRequest.current = request;
  try {
   const response = await fetch("/api/auth/session", { cache: "no-store", signal: request.signal });
   if (current !== generation.current) return false;
   if (response.ok) { const data = await response.json() as { user: User }; if (current !== generation.current) return false; if (expectedEmail && data.user.email.trim().toLowerCase() !== expectedEmail.trim().toLowerCase()) return false; setUser(previous => previous?.id === data.user.id ? previous : data.user); setReady(true); return true; }
   else if (response.status === 401) { setUser(null); setReady(true); }
  } catch { /* Потеря связи не превращает подтверждённый вход в успешный выход. */ }
  finally { if (refreshRequest.current === request) refreshRequest.current = null; }
  return false;
 }, []);
 useEffect(() => {
  const revalidate = () => { if (!locked.current && document.visibilityState === "visible") void refresh(); };
  if (initialSession.status === "unavailable") revalidate();
  const timer = setInterval(revalidate, 2000);
  window.addEventListener("focus", revalidate); window.addEventListener("online", revalidate); window.addEventListener("pageshow", revalidate); document.addEventListener("visibilitychange", revalidate);
  return () => { clearInterval(timer); window.removeEventListener("focus", revalidate); window.removeEventListener("online", revalidate); window.removeEventListener("pageshow", revalidate); document.removeEventListener("visibilitychange", revalidate); generation.current++; refreshRequest.current?.abort(); refreshRequest.current = null; };
 }, [initialSession.status, refresh]);
 const submit = async (operation: "send-code" | "verify-code", email: string, code = ""): Promise<OtpSendResult> => {
  if (locked.current) throw new AuthRequestError("Подождите…"); locked.current = true; setBusy(true); setMessage("");
  if (operation === "verify-code") { generation.current++; refreshRequest.current?.abort(); refreshRequest.current = null; }
  try {
   // AIDEV-NOTE: После принятого или неопределённого verify код может быть уже израсходован.
   // Повтор кнопки читает сессию; только новая успешная отправка разрешает следующий verify.
   if (operation === "verify-code" && verificationPending.current) {
    if (await refresh(verificationPending.current.email)) return {};
    throw pendingSignInError(verificationPending.current.accepted);
   }
   if (operation === "verify-code") verificationPending.current = { email, accepted: false };
   const response = await fetch(`/api/auth/${operation}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation === "send-code" ? { email } : { email, otp: code }) });
   if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const code = data && typeof data === "object" && "code" in data && typeof data.code === "string" ? data.code : undefined;
    if (operation === "verify-code" && code === "AUTH_OUTCOME_UNKNOWN") {
     if (await refresh(email)) return {};
     throw pendingSignInError(false);
    }
    if (operation === "verify-code" && response.status < 500) verificationPending.current = null;
    throw new AuthRequestError(authFailureMessage(operation, response.status, code), operation === "verify-code" && response.status >= 500);
   }
   if (operation === "verify-code") {
    verificationPending.current = { email, accepted: true };
    if (!await refresh(email)) throw pendingSignInError(true);
   } else verificationPending.current = null;
   // AIDEV-NOTE: HTTP send-code скрывает upstream metadata; сроки заданы контрактом auth владельца.
   return { expires_in_seconds: 300, resend_after_seconds: 60, resend_strategy: "replace" };
  } catch (error) {
   if (error instanceof AuthRequestError) throw error;
   if (operation === "verify-code") {
    if (await refresh(email)) return {};
    throw pendingSignInError(false);
   }
   throw new AuthRequestError("Связь прервалась. Проверьте почту или состояние входа перед повтором.");
  }
  finally { locked.current = false; setBusy(false); }
 };
 const unauthorized = useCallback(() => { generation.current++; refreshRequest.current?.abort(); refreshRequest.current = null; setUser(null); setReady(true); }, []);
 const logout = async () => {
  if (locked.current) return; locked.current = true; generation.current++; refreshRequest.current?.abort(); refreshRequest.current = null; setExiting(true); setMessage("");
  try {
   const response = await fetch("/api/auth/sign-out", { method: "POST" });
   if (!response.ok) { setMessage("Не удалось выйти. Сессия ещё действует; повторите выход."); return; }
   setUser(null);
  } catch { setMessage("Не удалось подтвердить выход. Проверьте соединение и повторите."); }
  finally { locked.current = false; setExiting(false); }
 };
 if (!ready) return <div className="workspace-shell brai-workspace-shell"><main className="p-8"><p role="status">Сервис входа временно недоступен. Повторим подключение автоматически.</p><Button className="mt-4" onClick={() => { void refresh(); }}>Повторить подключение</Button></main></div>;
 if (user && pathname === "/auth") return <main role="status" className="p-8">Открываем Brai…</main>;
 if (user && !exiting) return <AlertsProvider key={user.id} userId={user.id} onUnauthorized={unauthorized}><div className="workspace-shell brai-workspace-shell">
  <Navigation key={user.id} timerElapsed={timerElapsed} email={user.email} onLogout={() => { void logout(); }} />
  <div className="workspace-content"><AccountScreens key={user.id} view={view} user={user} agentMode={agentMode} telegramBotUsername={telegramBotUsername} onLogout={() => { void logout(); }} onUnauthorized={unauthorized} accountMessage={message} onTimerElapsed={onTimerElapsed} /></div>
 </div></AlertsProvider>;
 if (exiting) return <div className="workspace-shell brai-workspace-shell"><main className="p-8" role="status">Выходим…</main></div>;
 return <AuthScreen busy={busy} onRequestOtp={email => submit("send-code", email)} onVerifyOtp={async (email, otp) => { await submit("verify-code", email, otp); }} />;
}

/** Сохраняет состояние посещённых экранов; выход или смена пользователя удаляют их. */
function AccountScreens({ view, user, agentMode, telegramBotUsername, onLogout, onUnauthorized, accountMessage, onTimerElapsed }: { view: "agent" | "timer" | "do" | "alerts" | "game-core"; user: User; agentMode: WebAgentMode; telegramBotUsername: string | null; onLogout: () => void; onUnauthorized: () => void; accountMessage: string; onTimerElapsed: (elapsed: string | null) => void }) {
 const [visitedDo, setVisitedDo] = useState(view === "do");
 useEffect(() => { if (view === "do") setVisitedDo(true); }, [view]);
 const props = { userId: user.id, email: user.email, onLogout, onUnauthorized, accountMessage };
 // AIDEV-NOTE: Базовые состояния Agent и Timer подключены после входа; hidden сохраняет клиентов.
 return <>
  <div className="workspace-screen" hidden={view !== "game-core"}>{view === "game-core" && <GameCoreScreen userId={user.id} />}</div>
  <div className="workspace-screen" hidden={view !== "alerts"}><AlertsScreen active={view === "alerts"} /></div>
  <div className="workspace-screen" hidden={view !== "agent"}>{agentMode === "hermes_telegram" ? <TelegramAgentEntry username={telegramBotUsername} /> : <AgentScreen {...props} active={view === "agent"} />}</div>
  <div className="workspace-screen workspace-timer" hidden={view !== "timer"}><Timer userId={user.id} onUnauthorized={onUnauthorized} accountMessage={accountMessage} onElapsed={onTimerElapsed} /></div>
  <div className="workspace-screen" hidden={view !== "do"}>{(visitedDo || view === "do") && <DoScreen {...props} active={view === "do"} />}</div>
 </>;
}

/** Различает отказ кода, исчерпание попыток и сбой сервиса; не показывает upstream текст. */
function authFailureMessage(operation: "send-code" | "verify-code", status: number, code?: string): string {
 if (status === 429) return "Слишком много попыток. Подождите и повторите.";
 if (status >= 500) return "Сервис входа временно недоступен. Повторите позже.";
 if (operation === "verify-code") {
  if (code === "INVALID_OTP") return "Код не подошёл или уже использован. Проверьте последнее письмо или запросите новый код.";
  if (code === "OTP_EXPIRED") return "Срок действия кода истёк. Запросите новый код.";
  if (code === "TOO_MANY_ATTEMPTS") return "Попытки для этого кода исчерпаны. Запросите новый код.";
  return "Не удалось проверить код. Обновите страницу и повторите вход.";
 }
 return "Не удалось отправить код. Повторите позже.";
}

/** Сохраняет режим проверки сессии, пока пользователь не запросит новый код. */
function pendingSignInError(accepted: boolean): AuthRequestError {
 return new AuthRequestError(accepted
  ? "Код принят. Нажмите «Проверить вход». Если вход не подтвердится, запросите новый код."
  : "Результат входа уточняется. Нажмите «Проверить вход» или запросите новый код.", true);
}
