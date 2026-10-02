"use client";
// ABOUTME: Показывает выбранный native чат рядом с группами проектов и чатов.
// ABOUTME: История и команды используют существующий клиент; раскладка не управляет исполнителем.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DisplayItem, NativeSnapshot, PendingRequest } from "@brai/agent/contracts";
import { createAgentClient, AgentError } from "../../lib/agent/client";
import Sidebar, { type Project, type ThreadPage } from "./sidebar";

type Question = { id: string; header: string; question: string; isOther?: boolean; isSecret?: boolean; options?: { label: string; description: string }[] };
type Props = { userId: string; email: string; onLogout: () => void; onUnauthorized: () => void; accountMessage: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Ошибка связи";
const stateLabels: Record<string, string> = { idle: "Готов", inProgress: "Работает", waiting: "Ждёт ответа", completed: "Завершён", interrupted: "Остановлен", failed: "Ошибка", "connection-lost": "Переподключение", "executor-unavailable": "Codex недоступен" };

/** Сохраняет черновик при конфликте; выбор чата отменяет только его чтение, без остановки хода. */
export default function AgentScreen({ userId, email, onLogout, onUnauthorized, accountMessage }: Props) {
  const client = useMemo(() => createAgentClient(userId, onUnauthorized), [userId, onUnauthorized]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [pages, setPages] = useState<Record<string, ThreadPage>>({});
  const [projectId, setProjectId] = useState(""), [threadId, setThreadId] = useState("");
  const [snapshot, setSnapshot] = useState<NativeSnapshot | null>(null), [connected, setConnected] = useState(false);
  const conversation = useRef<HTMLDivElement>(null), followBottom = useRef(true);
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null);
  const [historyGeneration, setHistoryGeneration] = useState(""), [history, setHistory] = useState<DisplayItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null), [sidebarOpen, setSidebarOpen] = useState(false);
  const [draft, setDraft] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const locked = useRef(false), selection = useRef(0), uncertain = useRef(false);
  const pageRequests = useRef(new Map<string, symbol>());

  const loadThreads = useCallback(async (id: string, nextCursor?: string) => {
    const token = Symbol();
    pageRequests.current.set(id, token);
    setPages(previous => ({ ...previous, [id]: { data: previous[id]?.data ?? [], nextCursor: previous[id]?.nextCursor ?? null, loading: true, error: "" } }));
    try {
      const value = await client.request({ action: "threads", projectId: id, ...(nextCursor ? { cursor: nextCursor } : {}) });
      if (pageRequests.current.get(id) !== token) return;
      setPages(previous => {
        const data = [...new Map([...(nextCursor ? previous[id]?.data ?? [] : []), ...value.data].map(thread => [thread.id, thread])).values()].slice(0, 1000);
        return { ...previous, [id]: { data, nextCursor: data.length < 1000 ? value.nextCursor : null, loading: false, error: "" } };
      });
    } catch (error) {
      if (pageRequests.current.get(id) === token) setPages(previous => ({ ...previous, [id]: { ...previous[id], loading: false, error: errorText(error) } }));
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    const requests = pageRequests.current;
    void client.request({ action: "projects" }).then(value => {
      if (!active) return;
      setProjects(value.projects);
      setProjectId(value.projects.find(project => project.available)?.projectId ?? "");
      for (const project of value.projects) if (project.available) void loadThreads(project.projectId);
    }).catch(error => { if (active) setMessage(errorText(error)); });
    return () => { active = false; requests.clear(); client.dispose(); };
  }, [client, loadThreads]);

  useEffect(() => {
    ++selection.current;
    setBusy(locked.current); setSnapshot(null); setConnected(false); setHistory([]); setCursor(null); setDraft(""); uncertain.current = false;
    followBottom.current = true; scrollAnchor.current = null;
    if (!threadId) return;
    let active = true, epoch = "", historyRead = 0;
    const loadHistory = async (preserve = false) => {
      const token = ++historyRead;
      try {
        const value = await client.request({ action: "items", projectId, threadId });
        if (!active || token !== historyRead) return;
        setHistory(previous => preserve ? [...new Map([...previous, ...value.data].map(item => [item.id, item])).values()].slice(-1000) : value.data);
        setHistoryGeneration(value.generation); setCursor(value.nextCursor);
      } catch (error) { if (active && token === historyRead) setMessage(errorText(error)); }
    };
    const stop = client.watch(projectId, threadId, value => {
      if (!active) return;
      setConnected(value !== null);
      if (!value) return;
      const nextEpoch = `${value.generation}:${value.epoch}`;
      if (epoch && epoch !== nextEpoch) void loadHistory(true);
      epoch = nextEpoch;
      setSnapshot(value);
      setPages(previous => {
        const page = previous[projectId];
        if (page?.data.some(thread => thread.id === value.thread.id)) return previous;
        return { ...previous, [projectId]: { data: [value.thread, ...(page?.data ?? [])].slice(0, 1000), nextCursor: page?.nextCursor ?? null, loading: page?.loading ?? false, error: page?.error ?? "" } };
      });
    });
    void loadHistory();
    return () => { active = false; stop(); };
  }, [client, projectId, threadId]);

  function selectChat(id: string, chatId = "") {
    ++selection.current;
    setProjectId(id); setThreadId(chatId); setMessage(""); setSidebarOpen(false);
  }

  async function moreHistory() {
    if (!cursor) return;
    const token = selection.current;
    try {
      const value = await client.request({ action: "items", projectId, threadId, cursor });
      if (token !== selection.current || value.generation !== historyGeneration) return;
      if (history.length + value.data.length > 1000) setMessage("Показаны 1000 элементов выбранного участка истории. Последние действия остаются в живом снимке.");
      const element = conversation.current;
      if (element) scrollAnchor.current = { height: element.scrollHeight, top: element.scrollTop };
      followBottom.current = false;
      setHistory(previous => [...value.data, ...previous].slice(0, 1000)); setCursor(value.nextCursor);
    } catch (error) { if (token === selection.current) setMessage(errorText(error)); }
  }

  async function mutate(action: "create" | "start" | "steer" | "interrupt" | "answer", extra: Record<string, unknown> = {}, targetProject = projectId) {
    if (!targetProject || locked.current || uncertain.current || (action !== "create" && (!connected || !snapshot || snapshot.projectId !== projectId || snapshot.threadId !== threadId))) return false;
    const selected = snapshot, text = draft, token = selection.current, operationId = crypto.randomUUID();
    locked.current = true; setBusy(true); setMessage("");
    try {
      const generation = action === "create" ? (await client.request({ action: "status" })).generation : selected!.generation;
      const value = await client.request({ action, projectId: targetProject, ...(action === "create" ? {} : { threadId }), generation, operationId, ...extra });
      if (value.outcome !== "accepted" || value.generation !== generation || (action === "create" ? typeof value.threadId !== "string" : value.threadId !== selected!.threadId) || value.operationId !== operationId || (action === "answer" && value.requestId !== extra.requestId)) throw new AgentError("BAD_REPLY", "unknown");
      if (action === "create" || action === "start") void loadThreads(targetProject);
      if (token !== selection.current) return true;
      if (action === "create") selectChat(targetProject, value.threadId);
      if (action === "start" || action === "steer") setDraft(previous => previous === text ? "" : previous);
      setMessage("Действие принято."); return true;
    } catch (error) {
      if (token !== selection.current) return false;
      uncertain.current = error instanceof AgentError && error.outcome === "unknown";
      setMessage(errorText(error));
      return uncertain.current || (error instanceof AgentError && error.code === "STALE_REQUEST");
    } finally { locked.current = false; setBusy(false); }
  }

  const view = snapshot?.projectId === projectId && snapshot?.threadId === threadId ? snapshot : null;
  const active = view?.turn?.status === "inProgress", disabled = busy || !view || !connected || uncertain.current;
  const project = projects.find(value => value.projectId === projectId);
  const selectedThread = pages[projectId]?.data.find(thread => thread.id === threadId) ?? view?.thread;
  const title = selectedThread?.title || selectedThread?.preview || (threadId ? "Новый чат" : "Выберите чат");
  const items = [...new Map([...history, ...(view?.items ?? [])].map(item => [item.id, item])).values()];

  useLayoutEffect(() => {
    const element = conversation.current, anchor = scrollAnchor.current;
    if (!element) return;
    if (anchor) { element.scrollTop = anchor.top + element.scrollHeight - anchor.height; scrollAnchor.current = null; }
    else if (followBottom.current) element.scrollTop = element.scrollHeight;
  }, [threadId, history, snapshot]);

  return <main className="agent-shell">
    <Sidebar projects={projects} pages={pages} projectId={projectId} threadId={threadId} open={sidebarOpen} email={email} busy={busy || uncertain.current}
      select={selectChat} create={id => { void mutate("create", {}, id); }} more={id => { const next = pages[id]?.nextCursor; if (next) void loadThreads(id, next); }}
      refresh={id => { void loadThreads(id); }} close={() => setSidebarOpen(false)} logout={onLogout} />
    <section className="agent-workspace" aria-labelledby="agent-chat-title">
      <header className="agent-toolbar">
        <button className="agent-mobile-toggle" aria-controls="agent-sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}>☰ <span>Чаты</span></button>
        <div className="agent-heading"><p>{project?.name ?? "Агент"}</p><h1 id="agent-chat-title" title={title}>{title}</h1></div>
        <span className="agent-chat-status" role="status">{view && connected ? stateLabels[view.state] ?? "Состояние обновляется" : view ? "Переподключение…" : threadId ? "Подключаемся…" : "Готов к выбору"}</span>
      </header>
      <div ref={conversation} className="agent-conversation" aria-label="История" onScroll={event => {
        const element = event.currentTarget;
        followBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop < 80;
      }}>
        {!threadId && <div className="agent-empty"><span className="agent-empty-symbol" aria-hidden="true">✳</span><h2>С чего начнём?</h2><p>Выберите чат слева или создайте новый в нужном проекте.</p>{project && <button className="agent-primary" disabled={busy || uncertain.current} onClick={() => void mutate("create")}>Новый чат · {project.name}</button>}</div>}
        <div className="agent-timeline">
          {cursor && <button className="agent-history-more" onClick={() => void moreHistory()}>Загрузить предыдущие сообщения</button>}
          {items.map(item => <Item key={item.id} item={item} />)}
          {connected && view?.requests.map(request => <NativeForm key={`${view.generation}:${view.epoch}:${request.requestId}`} request={request} disabled={disabled} send={answer => mutate("answer", { requestId: request.requestId, answer })} />)}
        </div>
      </div>
      <footer className="agent-composer-area">
        <form className="agent-composer" onSubmit={event => { event.preventDefault(); if (draft.trim()) void mutate(active ? "steer" : "start", { text: draft, ...(active ? { expectedTurnId: view!.turn!.id } : {}) }); }}>
          <label className="sr-only" htmlFor="agent-draft">{active ? "Дополнить текущий ход" : "Сообщение"}</label>
          <textarea id="agent-draft" disabled={!threadId} placeholder={threadId ? active ? "Дополнить текущее задание…" : "Что нужно сделать?" : "Сначала выберите или создайте чат"} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <div className="agent-composer-actions"><span>{active ? "Агент работает · можно дополнить задание" : "Ctrl / ⌘ + Enter — отправить"}</span><div>{active && <button type="button" className="agent-stop" disabled={disabled} onClick={() => void mutate("interrupt", { turnId: view!.turn!.id })}>Остановить</button>}<button className="agent-send" disabled={disabled || !draft.trim() || view?.thread.canAcceptDirectInput === false}>{active ? "Дополнить" : "Отправить"}<span aria-hidden="true"> ↑</span></button></div></div>
        </form>
        <p className="agent-feedback" role="alert">{message || accountMessage}</p>
      </footer>
    </section>
  </main>;
}

/** Сообщения остаются текстом; команда, вывод и diff раскрываются в той же ленте. */
function Item({ item }: { item: DisplayItem }) {
  const message = item.type === "userMessage" || item.type === "agentMessage";
  const label = ({ commandExecution: "Команда", fileChange: "Изменения файлов", reasoning: "Ход работы", plan: "План", mcpToolCall: "Инструмент", dynamicToolCall: "Инструмент", collabAgentToolCall: "Совместная работа" } as Record<string, string>)[item.type] ?? "Действие агента";
  const content = <>{item.text && <pre>{item.text}</pre>}{item.command !== undefined && <pre className="agent-code">{item.command}</pre>}{item.output !== undefined && <pre className="agent-code">{item.output}</pre>}{item.diff !== undefined && <pre className="agent-code">{item.diff}</pre>}{item.truncated && <p className="agent-note">Элемент сокращён</p>}</>;
  return <article data-item-id={item.id} className={`agent-item ${message ? item.type === "userMessage" ? "agent-user-message" : "agent-assistant-message" : "agent-tool-item"}`}>
    {message ? <><span className="agent-message-author">{item.type === "userMessage" ? "Вы" : "Brai"}{item.phase && <span className="agent-message-phase">{item.phase === "final_answer" ? "Итог" : item.phase === "commentary" ? "Промежуточное сообщение" : item.phase}</span>}</span>{content}</> : <details><summary><span>{label}</span>{item.command && <code>{item.command}</code>}<span className="agent-note">{item.status === "inProgress" ? "Выполняется" : item.status === "failed" ? "Ошибка" : item.status === "completed" ? "Готово" : ""}{item.exitCode !== undefined && ` · код ${item.exitCode}`}</span></summary>{content}</details>}
  </article>;
}

/** Возвращает точный native answer исходного запроса; принятый/неизвестный ответ повторно не отправляет. */
function NativeForm({ request, disabled, send }: { request: PendingRequest; disabled: boolean; send: (answer: unknown) => Promise<boolean> }) {
  const [values, setValues] = useState<Record<string, string>>({}), [sent, setSent] = useState(false), sending = useRef(false);
  const p = request.params, questions: Question[] = p.questions ?? [];
  const choices = request.kind === "file-change-approval" ? ["accept", "acceptForSession", "decline", "cancel"] : p.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];
  if (request.kind === "unsupported") return <p>Не поддерживается: {request.method} {request.reason}</p>;
  return <form className="agent-request rounded border p-4" data-request-id={request.requestId} data-request-kind={request.kind} onSubmit={event => {
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
