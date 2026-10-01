"use client";
// ABOUTME: Показывает нативные чаты, историю, действия и четыре формы запроса Codex.
// ABOUTME: Черновик и выбор принадлежат экрану; состояние работы приходит готовым снимком.
import { useEffect, useMemo, useRef, useState } from "react";
import type { DisplayItem, NativeSnapshot, PendingRequest, ThreadMetadata } from "@brai/agent/contracts";
import { createAgentClient, AgentError } from "../../lib/agent/client";
type Question = { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description: string }[] };
type Props = { userId: string; email: string; onLogout: () => void; onUnauthorized: () => void; accountMessage: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Ошибка связи";
/** Сохраняет черновик при конфликте/неизвестном исходе; каждое действие отправляет только один раз. */
export default function AgentScreen({ userId, email, onLogout, onUnauthorized, accountMessage }: Props) {
  const client = useMemo(() => createAgentClient(userId, onUnauthorized), [userId, onUnauthorized]);
  const [projects, setProjects] = useState<{ projectId: string; name: string; available: boolean }[]>([]);
  const [threads, setThreads] = useState<ThreadMetadata[]>([]), [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [projectId, setProjectId] = useState(""), [threadId, setThreadId] = useState(""), [snapshot, setSnapshot] = useState<NativeSnapshot | null>(null);
  const [historyGeneration, setHistoryGeneration] = useState(""), [history, setHistory] = useState<DisplayItem[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const locked = useRef(false), selection = useRef(0), uncertain = useRef(false);
  useEffect(() => {
    let active = true;
    void client.request({ action: "projects" }).then(value => { if (active) setProjects(value.projects); }).catch(error => { if (active) setMessage(errorText(error)); });
    return () => { active = false; client.dispose(); };
  }, [client]);
  useEffect(() => {
    let active = true;
    setThreads([]); setThreadId(""); setDraft(""); setMessage("");
    if (projectId) void client.request({ action: "threads", projectId }).then(value => { if (active) { setThreads(value.data); setThreadCursor(value.nextCursor); } }).catch(error => { if (active) setMessage(errorText(error)); });
    return () => { active = false; };
  }, [client, projectId]);
  useEffect(() => {
    ++selection.current;
    setBusy(locked.current); setSnapshot(null); setHistory([]); setCursor(null); setDraft(""); uncertain.current = false;
    if (!threadId) return;
    let active = true;
    const stop = client.watch(projectId, threadId, value => { setSnapshot(value); if (value) setThreads(previous => previous.some(thread => thread.id === value.thread.id) ? previous : [value.thread, ...previous]); });
    void client.request({ action: "items", projectId, threadId }).then(value => { if (active) { setHistory(value.data); setHistoryGeneration(value.generation); setCursor(value.nextCursor); } }).catch(error => { if (active) setMessage(errorText(error)); });
    return () => { active = false; stop(); };
  }, [client, projectId, threadId]);
  async function more(kind: "threads" | "items") {
    const token = selection.current, selected = threadId;
    try {
      const value = await client.request({ action: kind, projectId, ...(kind === "items" ? { threadId } : {}), cursor: (kind === "items" ? cursor : threadCursor)! });
      if (token !== selection.current || selected !== threadId) return;
      if (kind === "items" && value.generation !== historyGeneration) return;
      if (kind === "items") {
        if (history.length + value.data.length > 1000) setMessage("Показаны 1000 элементов выбранного старого участка истории. Последние действия остаются в живом снимке.");
        setHistory(previous => [...value.data as DisplayItem[], ...previous].slice(0, 1000)); setCursor(value.nextCursor);
      } else {
        if (threads.length + value.data.length > 1000) setMessage("Показаны последние 1000 загруженных чатов; предыдущая часть списка скрыта.");
        setThreads(previous => [...previous, ...value.data as ThreadMetadata[]].slice(-1000)); setThreadCursor(value.nextCursor);
      }
    } catch (error) { if (token === selection.current) setMessage(errorText(error)); }
  }
  async function mutate(action: "create" | "start" | "steer" | "interrupt" | "answer", extra: Record<string, unknown> = {}) {
    if (!projectId || locked.current || uncertain.current || (action !== "create" && (!snapshot || snapshot.projectId !== projectId || snapshot.threadId !== threadId))) return false;
    const selected = snapshot, text = draft, token = selection.current, operationId = crypto.randomUUID();
    locked.current = true; setBusy(true); setMessage("");
    try {
      const generation = selected?.generation ?? (await client.request({ action: "status" })).generation;
      const value = await client.request({ action, projectId, ...(action === "create" ? {} : { threadId }), generation, operationId, ...extra });
      if (value.outcome !== "accepted" || value.generation !== generation || (action === "create" ? typeof value.threadId !== "string" : value.threadId !== selected!.threadId) || value.operationId !== operationId || (action === "answer" && value.requestId !== extra.requestId)) throw new AgentError("BAD_REPLY", "unknown");
      if (token !== selection.current) return true;
      if (action === "create") setThreadId(value.threadId);
      if (action === "start" || action === "steer") setDraft(previous => previous === text ? "" : previous);
      setMessage("Действие принято."); return true;
    } catch (error) { if (token !== selection.current) return false; uncertain.current = error instanceof AgentError && error.outcome === "unknown"; setMessage(errorText(error)); return uncertain.current || (error instanceof AgentError && error.code === "STALE_REQUEST"); }
    finally { locked.current = false; setBusy(false); }
  }
  const active = snapshot?.turn?.status === "inProgress", disabled = busy || !snapshot || uncertain.current;
  const items = [...new Map([...(snapshot?.generation === historyGeneration ? history : []), ...(snapshot?.items ?? [])].map(item => [item.id, item])).values()];
  return <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 p-4">
    <header className="flex flex-wrap items-center gap-4"><h1 className="text-2xl font-semibold">Brai · Агент</h1><span className="break-all">{email}</span><a href="/">Таймер</a><button onClick={onLogout}>Выйти</button></header>
    <label>Проект <select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Выберите проект</option>{projects.map(project => <option key={project.projectId} value={project.projectId} disabled={!project.available}>{project.name}</option>)}</select></label>
    <button disabled={busy || !projectId || uncertain.current} onClick={() => void mutate("create")}>Новый чат</button>
    <nav className="flex flex-wrap gap-2" aria-label="Чаты">{threads.map(thread => <button key={thread.id} data-thread-id={thread.id} aria-pressed={threadId === thread.id} onClick={() => setThreadId(thread.id)} className="rounded border p-2">{thread.title || thread.preview || "Пустой чат"}</button>)}{threadCursor && <button onClick={() => void more("threads")}>Ещё чаты</button>}</nav>
    <p role="status">{snapshot ? `${snapshot.state} · ${snapshot.turn?.status ?? "Без хода"}` : "Выберите чат / подключаемся"}</p>
    <section aria-label="История" className="flex flex-col gap-3">{cursor && <button onClick={() => void more("items")}>Загрузить историю</button>}{items.map(item => <article key={item.id} data-item-id={item.id} className="rounded border p-3 break-words">
      <strong>{item.type} {item.phase} {item.status}{item.exitCode !== undefined && ` · код ${item.exitCode}`}</strong><pre className="whitespace-pre-wrap break-all">{item.text}</pre>
      {item.command !== undefined && <pre className="whitespace-pre-wrap break-all">{item.command}</pre>}{item.output !== undefined && <pre className="whitespace-pre-wrap break-all">{item.output}</pre>}{item.diff !== undefined && <pre className="whitespace-pre-wrap break-all">{item.diff}</pre>}{item.truncated && <p>Элемент сокращён</p>}
    </article>)}</section>
    {snapshot?.truncated && <p>Живой снимок сокращён; сохранённая история доступна выше.</p>}
    {snapshot?.requests.map(request => <NativeForm key={`${snapshot.generation}:${snapshot.epoch}:${request.requestId}`} request={request} disabled={disabled} send={answer => mutate("answer", { requestId: request.requestId, answer })} />)}
    <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); if (draft.trim()) void mutate(active ? "steer" : "start", { text: draft, ...(active ? { expectedTurnId: snapshot!.turn!.id } : {}) }); }}>
      <label htmlFor="agent-draft">{active ? "Дополнить текущий ход" : "Сообщение"}</label><textarea id="agent-draft" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} className="min-h-28 rounded border p-3" />
      <button disabled={disabled || !draft.trim() || snapshot?.thread.canAcceptDirectInput === false} className="rounded bg-blue-600 p-3 text-white">{active ? "Дополнить" : "Отправить"}</button>{active && <button type="button" disabled={disabled} onClick={() => void mutate("interrupt", { turnId: snapshot!.turn!.id })}>Остановить ход</button>}
    </form><p role="alert">{message || accountMessage}</p>
  </main>;
}
/** Возвращает точный native answer исходного запроса; принятый/неизвестный ответ повторно не отправляет. */
function NativeForm({ request, disabled, send }: { request: PendingRequest; disabled: boolean; send: (answer: unknown) => Promise<boolean> }) {
  const [values, setValues] = useState<Record<string, string>>({}), [sent, setSent] = useState(false), sending = useRef(false);
  const p = request.params, questions: Question[] = p.questions ?? [];
  const choices = request.kind === "file-change-approval" ? ["accept", "acceptForSession", "decline", "cancel"] : p.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];
  if (request.kind === "unsupported") return <p>Не поддерживается: {request.method} {request.reason}</p>;
  return <form className="rounded border p-4" data-request-id={request.requestId} data-request-kind={request.kind} onSubmit={event => {
    event.preventDefault(); if (sent || sending.current || disabled || request.answered) return;
    const answer = request.kind === "question" ? { answers: Object.fromEntries(questions.map((q: Question) => [q.id, { answers: [values[q.id]] }])) } : request.kind === "permissions" ? { permissions: values.decision === "grant" ? p.permissions : {}, scope: "turn" } : { decision: choices[Number(values.decision)] };
    sending.current = true; setSent(true); void send(answer).then(accepted => { if (!accepted) { sending.current = false; setSent(false); } });
  }}>
    <fieldset disabled={disabled || sent || request.answered}><legend>{({ "question": "Вопрос агента", "permissions": "Дополнительные права", "command-approval": "Разрешение команды", "file-change-approval": "Разрешение изменений файлов" }[request.kind])}</legend><details><summary>Параметры запроса</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(p, null, 2)}</pre></details>
      {request.kind === "question" ? questions.map((q: Question) => <label key={q.id} className="block">{q.header}: {q.question}{q.options?.length && !q.isOther ? <select required value={values[q.id] ?? ""} onChange={event => setValues({ ...values, [q.id]: event.target.value })}><option value="">Выберите ответ</option>{q.options.map((option: NonNullable<Question["options"]>[number]) => <option key={option.label} value={option.label}>{option.label} — {option.description}</option>)}</select> : <><input required type={q.isSecret ? "password" : "text"} autoComplete="off" list={q.options?.length && !q.isSecret ? `${request.requestId}-${q.id}` : undefined} value={values[q.id] ?? ""} onChange={event => setValues({ ...values, [q.id]: event.target.value })} className="block rounded border p-2" /><datalist id={`${request.requestId}-${q.id}`}>{q.options?.map((option: NonNullable<Question["options"]>[number]) => <option key={option.label} value={option.label}>{option.description}</option>)}</datalist></>}</label>) : <label>Решение <select required value={values.decision ?? ""} onChange={event => setValues({ decision: event.target.value })}><option value="">Выберите решение</option>{request.kind === "permissions" ? <><option value="grant">Предоставить запрошенные права на ход</option><option value="none">Не предоставлять</option></> : choices.map((choice: unknown, index: number) => <option key={index} value={index}>{typeof choice === "string" ? ({ accept: "Разрешить", acceptForSession: "Разрешить для сессии", decline: "Отклонить", cancel: "Отклонить и остановить ход" } as Record<string, string>)[choice] ?? choice : JSON.stringify(choice)}</option>)}</select></label>}
      <button className="block rounded border p-2">{sent || request.answered ? "Ответ уже отправлялся" : "Отправить ответ"}</button>
    </fieldset>
  </form>;
}
