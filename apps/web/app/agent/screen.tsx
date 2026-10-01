"use client";
// ABOUTME: Отображает проекты, чаты, сообщения и явные действия agent.
// ABOUTME: Состояние и HTTP/SSE принадлежат клиенту apps/web/lib/agent/client.ts.
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import type { ActivitySnapshotEvent, Message } from "@ag-ui/core";
import type { HistoryItem, PendingRequest, ThreadMetadata, Trace } from "@brai/agent/contracts";
import { approvalAnswer, permissionsAnswer, questionAnswer } from "./forms";
import { buildAgentTimeline } from "./timeline";
import { createAgentClient } from "../../lib/agent/client";
import type { AgentClientState, AgentStatus } from "../../lib/agent/types";

type Props = { userId: string; email: string; onLogout: () => void; onUnauthorized: () => void; accountMessage: string };
type AnswerState = "sending" | "accepted" | "unknown" | "stale";

const statusLabels: Record<AgentStatus, string> = {
  ready: "Готов", working: "Работает", waiting: "Ожидает ответа", completed: "Завершён",
  interrupted: "Прерван", error: "Ошибка", "connection-lost": "Связь потеряна", "executor-unavailable": "Исполнитель недоступен",
};

/** Создаёт и освобождает один клиент agent на время входа в эту страницу. */
export default function AgentScreen({ userId, email, onLogout, onUnauthorized, accountMessage }: Props) {
  const [client, setClient] = useState<ReturnType<typeof createAgentClient> | null>(null);
  const [state, setState] = useState<AgentClientState | null>(null);
  const [readMessage, setReadMessage] = useState("");
  const [formAnswers, setFormAnswers] = useState<Record<string, Record<string, string>>>({});
  const [answerStates, setAnswerStates] = useState<Record<string, AnswerState>>({});
  const [interruptState, setInterruptState] = useState<AnswerState | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [creatingThread, setCreatingThread] = useState(false);
  const submitLock = useRef(false);
  const createLock = useRef(false);
  const interruptLock = useRef(false);
  const submittedForms = useRef(new Set<string>());

  useEffect(() => {
    const instance = createAgentClient({ expectedUserId: userId, onUnauthorized });
    let mounted = true;
    setClient(instance);
    const unsubscribe = instance.subscribe(setState);
    void Promise.allSettled([instance.getProjects(), instance.getStatus()]).then(async results => {
      if (!mounted) return;
      if (results[0].status === "fulfilled") {
        const first = results[0].value.projects.find(project => project.available);
        if (first) await instance.selectProject(first.projectId).catch(error => { if (mounted) setReadMessage(errorText(error)); });
      } else setReadMessage(errorText(results[0].reason));
      if (mounted && results[1].status === "rejected") setReadMessage(errorText(results[1].reason));
    });
    return () => { mounted = false; unsubscribe(); void instance.dispose(); };
  }, [userId, onUnauthorized]);

  useEffect(() => {
    if (!state) return;
    const liveKeys = new Set(state.pendingRequests.filter(request => request.requestId).map(request => `${state.generation}:${state.selectedThreadId}:${request.requestId}`));
    setAnswerStates(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => liveKeys.has(id))));
    setFormAnswers(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => liveKeys.has(id))));
    for (const key of submittedForms.current) if (!liveKeys.has(key)) submittedForms.current.delete(key);
  }, [state?.pendingRequests, state?.generation, state?.selectedThreadId]);

  useEffect(() => { setInterruptState(null); interruptLock.current = false; }, [state?.generation, state?.selectedThreadId, state?.activeTurnId]);

  const timeline = useMemo(() => state ? buildAgentTimeline(state.historyItems, state.traceItems, state.messages, state.messagePhases) : [], [state?.historyItems, state?.traceItems, state?.messages, state?.messagePhases]);

  if (!client || !state) return <main className="agent-loading" role="status">Подключаем страницу агента…</main>;
  const selectedProject = state.projects.find(project => project.projectId === state.selectedProjectId);
  const selectedThread = state.threads.find(thread => thread.threadId === state.selectedThreadId);
  const active = Boolean(state.activeTurnId);
  const status = state.connection === "unauthorized" ? "Ошибка" : state.connection === "connection-lost" ? "Связь потеряна" : state.connection === "connecting" ? "Подключается" : state.threadStatus ? statusLabels[state.threadStatus] : state.status?.ready ? "Готов" : state.status ? "Исполнитель недоступен" : "Проверяем состояние";
  const statusTone = state.threadStatus === "error" || state.connection === "connection-lost" ? "danger" : active ? "active" : "calm";

  const submitDraft = async (event: FormEvent) => {
    event.preventDefault();
    if (submitLock.current || !state.draft.trim() || state.mutation === "pending") return;
    submitLock.current = true;
    setSubmitting(true);
    setReadMessage("");
    try { await client.submitDraft(); }
    catch (error) { setReadMessage(errorText(error)); }
    finally { submitLock.current = false; setSubmitting(false); }
  };

  const interrupt = async () => {
    if (!state.activeTurnId || state.mutation === "pending" || interruptLock.current || interruptState !== null) return;
    interruptLock.current = true;
    setInterruptState("sending");
    try {
      const result = await client.interrupt();
      setInterruptState(result.outcome === "accepted" ? "accepted" : result.outcome === "unknown" ? "unknown" : null);
      if (result.outcome === "failed") interruptLock.current = false;
    } catch (error) { setInterruptState(null); setReadMessage(errorText(error)); }
    finally { if (!state.activeTurnId || state.activeTurnId !== client.getState().activeTurnId) interruptLock.current = false; }
  };

  const respond = async (request: PendingRequest, answer: unknown) => {
    if (request.kind === "unsupported" || !request.requestId || state.mutation === "pending") return;
    const key = formKey(state, request);
    if (submittedForms.current.has(key) || ["sending", "accepted", "unknown", "stale"].includes(answerStates[key] ?? "")) return;
    submittedForms.current.add(key);
    setAnswerStates(previous => ({ ...previous, [key]: "sending" }));
    try {
      const result = await client.respond(request.requestId, request.kind, answer);
      if (result.outcome === "accepted") setAnswerStates(previous => ({ ...previous, [key]: "accepted" }));
      else if (result.outcome === "unknown") setAnswerStates(previous => ({ ...previous, [key]: "unknown" }));
      else if (result.code === "STALE_REQUEST") {
        setAnswerStates(previous => ({ ...previous, [key]: "stale" }));
        setReadMessage("Форма устарела: решение уже получено или запрос закрыт.");
      } else {
        submittedForms.current.delete(key);
        setAnswerStates(previous => { const next = { ...previous }; delete next[key]; return next; });
        setReadMessage(result.error);
      }
    } catch (error) {
      submittedForms.current.delete(key);
      setAnswerStates(previous => { const next = { ...previous }; delete next[key]; return next; });
      setReadMessage(errorText(error));
    }
  };

  const createThread = async () => {
    if (!state.selectedProjectId || createLock.current) return;
    createLock.current = true;
    setCreatingThread(true);
    setReadMessage("");
    try { await client.createThread(state.selectedProjectId); }
    catch (error) { setReadMessage(errorText(error)); }
    finally { createLock.current = false; setCreatingThread(false); }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return <main className="agent-shell">
    <header className="agent-header">
      <div className="agent-brand"><Link href="/" aria-label="Brai — таймер">Brai</Link><span aria-hidden="true">/</span><h1>Агент</h1></div>
      <div className="agent-header-actions">
        <span className="agent-email" title={email}>{email}</span>
        <Link href="/" className="agent-nav-link">Таймер</Link>
        <button type="button" className="agent-quiet-button" onClick={onLogout}>Выйти</button>
      </div>
    </header>
    {accountMessage && <p className="agent-alert" role="status">{accountMessage}</p>}
    <div className="agent-workspace">
      <aside className={`agent-sidebar ${sidebarOpen ? "" : "agent-sidebar-collapsed"}`} aria-label="Проекты и чаты">
        <div className="agent-sidebar-title"><h2>Рабочее место</h2><button type="button" className="agent-quiet-button agent-collapse" aria-expanded={sidebarOpen} aria-label={sidebarOpen ? "Свернуть список чатов" : "Развернуть список чатов"} onClick={() => setSidebarOpen(value => !value)}>{sidebarOpen ? "Свернуть" : "Показать"}</button></div>
        {sidebarOpen && <>
          <label className="agent-label" htmlFor="agent-project">Проект</label>
          <select id="agent-project" className="agent-select" value={state.selectedProjectId ?? ""} disabled={!state.projects.length} onChange={event => { setReadMessage(""); void client.selectProject(event.target.value).catch(error => setReadMessage(errorText(error))); }}>
            {!state.projects.length && <option value="">{state.readError ? "Проекты недоступны" : "Загружаем проекты…"}</option>}
            {state.projects.map(project => <option key={project.projectId} value={project.projectId} disabled={!project.available}>{project.name}{project.available ? "" : " · недоступен"}</option>)}
          </select>
          {selectedProject && <p className="agent-project-id">{selectedProject.name}</p>}
          <div className="agent-chat-heading"><h3>Чаты</h3><button type="button" className="agent-small-primary" disabled={!selectedProject?.available || creatingThread} onClick={() => void createThread()}>{creatingThread ? "Создаём…" : "Новый чат"}</button></div>
          <div className="agent-thread-list" role="list" aria-label="Сохранённые чаты">
            {state.threads.length === 0 && <p className="agent-muted">В этом проекте пока нет загруженных чатов.</p>}
            {state.threads.map((thread: ThreadMetadata) => <button type="button" role="listitem" key={thread.threadId} className={`agent-thread ${state.selectedThreadId === thread.threadId ? "is-selected" : ""}`} aria-current={state.selectedThreadId === thread.threadId ? "page" : undefined} onClick={() => { setReadMessage(""); void client.selectThread(state.selectedProjectId!, thread.threadId).catch(error => setReadMessage(errorText(error))); }}>
              <span className="agent-thread-name">{thread.title || "Без названия"}</span><span className="agent-thread-date">{formatDate(thread.updatedAt)}</span>
            </button>)}
            {state.threadsCursor && <button type="button" className="agent-load-more" disabled={state.connection === "connection-lost"} onClick={() => void client.loadMoreThreads().catch(error => setReadMessage(errorText(error)))}>Загрузить ещё чаты</button>}
          </div>
        </>}
        <div className="agent-account-status"><span className={`agent-dot ${statusTone}`} aria-hidden="true"/><span>{status}</span></div>
      </aside>

      <section className="agent-chat" aria-label="Чат с агентом">
        <div className="agent-chat-topline">
          <div className="agent-chat-title"><h2>{selectedThread?.title || (state.selectedThreadId ? "Чат" : selectedProject ? "Новый чат" : "Выберите проект")}</h2><p>{selectedProject?.name ?? "Проект не выбран"}{state.selectedThreadId ? ` · ${state.selectedThreadId}` : ""}</p></div>
          <div className={`agent-state-chip ${statusTone}`} role="status" aria-live="polite">{status}</div>
        </div>

        {state.readError && <p className="agent-alert" role="status">Не удалось обновить данные: {state.readError}</p>}
        {state.truncation?.truncated && <p className="agent-info" role="status">Часть старых данных ограничена: {truncationLabel(state.truncation.reason)}.</p>}
        {readMessage && <p className="agent-alert" role="status">{readMessage}</p>}
        {state.mutationError && <p className="agent-alert" role="status">{state.mutationError}</p>}

        <div className="agent-feed" aria-live="polite" aria-relevant="additions text" aria-label="Сообщения и действия">
          {!state.selectedThreadId && <div className="agent-empty"><span className="agent-empty-mark" aria-hidden="true">✳</span><h3>Поручите работу агенту</h3><p>Выберите проект и создайте чат. Открытие чата не запускает задание.</p></div>}
          {state.selectedThreadId && state.messages.length === 0 && timeline.length === 0 && state.historyItems.length === 0 && <div className="agent-empty"><h3>История пока пуста</h3><p>Введите задачу ниже, чтобы начать работу в этом чате.</p></div>}
          {timeline.map((entry, index) => entry.kind === "trace" ? <TraceCard key={`trace-${entry.item.itemId}`} item={entry.item} /> : <MessageCard key={`message-${entry.message.id}-${index}`} message={entry.message} phase={entry.phase} />)}
          {state.activityEvents.length > 0 && <ActivityCard events={state.activityEvents} presentedIds={new Set(state.messages.map(message => message.id))} />}
          {latestSubagentEvents(state.subagentEvents).map(event => <details className="agent-trace" key={`subagent-${event.subagentRunId}`}><summary><span className="agent-trace-icon" aria-hidden="true">↗</span><span>{subagentHeading(event)}</span><span className="agent-trace-state">{event.subagentRunId}</span></summary><div className="agent-trace-content"><p>{subagentLabel(event)}</p></div></details>)}
          {state.historyError && <p className="agent-alert" role="status">История: {state.historyError}</p>}
          {state.historyCursor && <button type="button" className="agent-history-button" onClick={() => void client.loadHistory().catch(() => {})}>Загрузить ещё историю</button>}
          {state.historyTruncated && <p className="agent-muted">Локальная история достигла предела; показаны доступные элементы.</p>}
          {state.pendingRequests.map(request => {
            const key = formKey(state, request);
            return <RequestCard key={key} request={request} submitted={request.requestId ? answerStates[key] : undefined} disabled={state.mutation === "pending"} answers={formAnswers[key] ?? {}} onAnswerChange={(qid, value) => setFormAnswers(previous => ({ ...previous, [key]: { ...previous[key], [qid]: value } }))} onSubmit={answer => void respond(request, answer)} onInterrupt={interrupt} />;
          })}
        </div>

        <form className="agent-composer" onSubmit={submitDraft}>
          <label htmlFor="agent-prompt">{active ? "Дополнить ход" : "Сообщение"}</label>
          <textarea id="agent-prompt" rows={3} value={state.draft} onChange={event => client.setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder={active ? "Добавьте уточнение к текущему заданию…" : "Опишите задачу для агента…"} disabled={!state.selectedThreadId || !state.generation || state.connection !== "connected" || !state.status?.ready || state.resyncing} />
          <div className="agent-composer-footer"><span>Ctrl + Enter — отправить · Shift + Enter — новая строка</span><div className="agent-composer-actions">
            {active && <button type="button" className="agent-stop-button" disabled={state.mutation === "pending" || interruptState !== null} onClick={() => void interrupt()}>{interruptState === "sending" ? "Запрашиваем остановку…" : "Остановить"}</button>}
            <button type="submit" className="agent-send-button" disabled={!state.selectedThreadId || !state.generation || state.connection !== "connected" || !state.status?.ready || state.resyncing || !state.draft.trim() || submitting || state.mutation === "pending"}>{state.mutation === "pending" ? "Отправляем…" : active ? "Дополнить ход" : "Начать ход"}</button>
          </div></div>
          {state.mutation === "accepted" && <p className="agent-mutation-note" role="status">Команда принята. Ждём фактическое состояние хода.</p>}
          {state.mutation === "unknown" && <p className="agent-mutation-note" role="status">Результат не подтверждён. Команда автоматически не повторялась.</p>}
          {interruptState === "accepted" && <p className="agent-mutation-note" role="status">Остановка запрошена. Ожидаем завершения хода.</p>}
          {interruptState === "unknown" && <p className="agent-mutation-note" role="status">Результат запроса остановки не подтверждён.</p>}
        </form>
      </section>
    </div>
  </main>;
}

/** Показывает текст сообщения, его подтверждённую фазу и структурированные вызовы инструментов. */
function MessageCard({ message, phase }: { message: Message; phase?: "commentary" | "final_answer" | null }) {
  if (message.role === "activity") return <article className="agent-trace"><details open><summary><span className="agent-trace-icon" aria-hidden="true">✓</span><span>{activityTitle(message.activityType)}</span></summary><ActivityContent activityType={message.activityType} content={message.content} /></details></article>;
  const roleName = message.role === "assistant" ? "Агент" : message.role === "user" ? "Вы" : message.role === "system" ? "Система" : message.role === "developer" ? "Инструкции" : message.role === "tool" ? "Результат инструмента" : "Событие";
  return <article className={`agent-message agent-message-${message.role}`}>
    <header className="agent-message-heading"><span>{roleName}</span>{phase === "commentary" && <span className="agent-phase">Промежуточный ответ</span>}{phase === "final_answer" && <span className="agent-phase final">Итог</span>}</header>
    <MessageContent content={message.content} />
    {message.role === "assistant" && message.toolCalls?.map(call => <details className="agent-tool" key={call.id}><summary>{call.function.name || "Вызов инструмента"}</summary><pre>{call.function.arguments || "Аргументы не переданы"}</pre></details>)}
  </article>;
}

/** Отображает только текстовые части; неизвестные части остаются понятной подписью. */
function MessageContent({ content }: { content: Message["content"] }) {
  if (typeof content === "string") return <p className="agent-message-text">{content}</p>;
  if (!Array.isArray(content) || !content.length) return null;
  return <div className="agent-message-text">{content.map((part, index) => {
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return <p key={index}>{part.text}</p>;
    return <p key={index} className="agent-muted">Часть сообщения этого типа не отображается.</p>;
  })}</div>;
}

/** Рисует доступный к раскрытию элемент трассы, не смешивая его с сообщением. */
function TraceCard({ item }: { item: HistoryItem }) {
  const trace = item.trace as Trace;
  const title = traceTitle(trace, item.kind);
  return <details className="agent-trace">
    <summary><span className="agent-trace-icon" aria-hidden="true">{trace.type === "command" ? "›_" : trace.type === "file-change" ? "↗" : trace.type === "output" ? "↳" : "·"}</span><span>{title}</span><span className="agent-trace-state">{trace.status}{trace.exitCode != null ? ` · код ${trace.exitCode}` : ""}</span></summary>
    <div className="agent-trace-content">
      {trace.command && <pre><strong>Команда</strong>{trace.command}</pre>}
      {trace.output && <pre><strong>Вывод</strong>{trace.output}</pre>}
      {trace.diffSummary && <pre><strong>Изменения</strong>{trace.diffSummary}</pre>}
      {trace.type === "message" && <div className="agent-history-message"><span>{trace.phase === "commentary" ? "Промежуточный ответ" : trace.phase === "final_answer" ? "Итог" : "Фаза не указана"}</span><p>{item.content}</p></div>}
      {!trace.command && !trace.output && !trace.diffSummary && trace.type !== "message" && <pre>{item.content}</pre>}
      {item.truncated && <p className="agent-muted">Элемент сокращён · исходный размер {item.contentBytes} байт.</p>}
    </div>
  </details>;
}

function ActivityCard({ events, presentedIds }: { events: AgentClientState["activityEvents"]; presentedIds: Set<string> }) {
  type ActivityEvent = AgentClientState["activityEvents"][number];
  type ActivitySnapshot = ActivitySnapshotEvent;
  const grouped = new Map<string, { snapshot?: ActivitySnapshot; latest: ActivityEvent }>();
  for (const event of events) {
    if (presentedIds.has(event.messageId)) continue;
    const previous = grouped.get(event.messageId);
    const snapshot = event.type === "ACTIVITY_SNAPSHOT" ? event : previous?.snapshot;
    const record: { snapshot?: ActivitySnapshot; latest: ActivityEvent } = { latest: event };
    if (snapshot) record.snapshot = snapshot;
    grouped.set(event.messageId, record);
  }
  return <section aria-label="План работы агента">{[...grouped.entries()].map(([messageId, record]) => <article className="agent-trace" key={messageId}><details open><summary><span className="agent-trace-icon" aria-hidden="true">✓</span><span>{activityTitle(record.latest.activityType)}</span><span className="agent-trace-state">{record.latest.type === "ACTIVITY_DELTA" ? "план обновлён" : "план"}</span></summary>{record.snapshot ? <ActivityContent activityType={record.snapshot.activityType} content={record.snapshot.content} /> : <div className="agent-activity-content"><p>План обновлён.</p></div>}</details></article>)}</section>;
}

function ActivityContent({ activityType, content }: { activityType: string; content: Record<string, unknown> }) {
  const heading = typeof content.title === "string" ? content.title : typeof content.summary === "string" ? content.summary : "";
  const steps = Array.isArray(content.steps) ? content.steps : Array.isArray(content.plan) ? content.plan : [];
  return <div className="agent-activity-content">
    {heading && <p>{heading}</p>}
    {steps.length > 0 && <ol>{steps.map((step, index) => {
      if (typeof step === "string") return <li key={index}>{step}</li>;
      if (!step || typeof step !== "object") return null;
      const entry = step as Record<string, unknown>;
      const label = [entry.title, entry.step, entry.text].find(value => typeof value === "string");
      const status = typeof entry.status === "string" ? entry.status : "";
      return <li key={index}>{typeof label === "string" ? label : `Шаг ${index + 1}`}{status && <span className="agent-activity-status">{status}</span>}</li>;
    })}</ol>}
    {!heading && steps.length === 0 && <p>{activityType === "plan" ? "План обновлён." : "Состояние работы обновлено."}</p>}
  </div>;
}

/** Создаёт нативную форму ровно того вида, который разрешил upstream. */
function RequestCard({ request, submitted, disabled, answers, onAnswerChange, onSubmit, onInterrupt }: {
  request: PendingRequest; submitted?: AnswerState; disabled: boolean; answers: Record<string, string>;
  onAnswerChange: (id: string, value: string) => void; onSubmit: (answer: unknown) => void; onInterrupt: () => void;
}) {
  const [decision, setDecision] = useState("");
  const [permissionChoice, setPermissionChoice] = useState("");
  const [freeAnswers, setFreeAnswers] = useState<Record<string, string>>({});
  const [selectedOther, setSelectedOther] = useState<Record<string, boolean>>({});
  const [formError, setFormError] = useState("");
  const sent = submitted === "sending" || submitted === "accepted" || submitted === "unknown";
  if (request.kind === "unsupported") return <article className="agent-request agent-request-unsupported"><strong>Запрос требует неподдерживаемого действия</strong><p>{request.reason === "oversized" ? "Размер запроса превышает предел." : `Метод: ${request.method}`}</p><p>Код: {request.code}</p>{request.interruptAvailable && <button type="button" className="agent-stop-button" onClick={onInterrupt}>Остановить ход</button>}</article>;
  const decisions = request.kind === "command-approval" ? request.params.availableDecisions : undefined;
  const fallbackDecisions = ["accept", "acceptForSession", "decline", "cancel"];
  const fileDecisions = ["accept", "decline", "cancel"];
  const choices = request.kind === "command-approval" ? decisions ?? fallbackDecisions : request.kind === "file-change-approval" ? fileDecisions : [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    if (request.kind === "question") {
      const result = questionAnswer(request.params.questions, answers, freeAnswers, selectedOther);
      if ("error" in result) { setFormError(result.error); return; }
      onSubmit(result.answer);
    } else if (request.kind === "permissions") {
      const answer = permissionsAnswer(permissionChoice, request.params.permissions);
      if (!answer) { setFormError("Выберите решение по запрошенным правам."); return; }
      onSubmit(answer);
    } else {
      if (!decision) { setFormError("Выберите решение."); return; }
      const answer = approvalAnswer(decision, choices);
      if (!answer) { setFormError("Выбранный вариант больше недоступен."); return; }
      onSubmit(answer);
    }
  };

  return <article className="agent-request">
    <div className="agent-request-title"><span className="agent-request-icon" aria-hidden="true">?</span><div><strong>{request.kind === "question" ? "Вопрос агента" : request.kind === "permissions" ? "Запрос дополнительных прав" : request.kind === "command-approval" ? "Разрешение команды" : "Разрешение изменений файлов"}</strong><p>Ответьте здесь, чтобы ход мог продолжиться.</p></div></div>
    {request.kind === "command-approval" && <RequestDetails values={[["Причина", request.params.reason], ["Рабочая папка", request.params.cwd], ["Команда", request.params.command], ["Дополнительные права", request.params.additionalPermissions ? JSON.stringify(request.params.additionalPermissions, null, 2) : null]]} />}
    {request.kind === "file-change-approval" && <RequestDetails values={[["Причина", request.params.reason], ["Корень изменений", request.params.grantRoot]]} />}
    {request.kind === "permissions" && <><p className="agent-request-copy">{request.params.reason || "Исполнитель запрашивает дополнительные полномочия для этого хода."}</p><RequestDetails values={[["Рабочая папка", request.params.cwd], ["Запрошенные права", JSON.stringify(request.params.permissions, null, 2)]]} /></>}
    {request.kind === "question" && <form onSubmit={submit} className="agent-request-form">
      {request.params.questions.map(question => <fieldset key={question.id} className="agent-question"><legend>{question.header}</legend><p>{question.question}</p>
      {question.options?.length ? <div className="agent-options">{question.options.map(option => <label key={option.label} className="agent-option"><input type="radio" name={`${request.requestId}-${question.id}`} value={option.label} checked={!selectedOther[question.id] && answers[question.id] === option.label} onChange={() => { setSelectedOther(previous => ({ ...previous, [question.id]: false })); onAnswerChange(question.id, option.label); }} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}
          {question.isOther && <label className="agent-option agent-option-other"><input type="radio" name={`${request.requestId}-${question.id}`} value="__other__" checked={Boolean(selectedOther[question.id])} onChange={() => setSelectedOther(previous => ({ ...previous, [question.id]: true }))} /><span><strong>Другой ответ</strong><input aria-label={`Другой ответ: ${question.header}`} type={question.isSecret ? "password" : "text"} autoComplete="off" value={freeAnswers[question.id] ?? ""} onFocus={() => setSelectedOther(previous => ({ ...previous, [question.id]: true }))} onChange={event => { setSelectedOther(previous => ({ ...previous, [question.id]: true })); setFreeAnswers(previous => ({ ...previous, [question.id]: event.target.value })); }} /></span></label>}
        </div> : <label className="agent-field-label">Ваш ответ<input type={question.isSecret ? "password" : "text"} autoComplete="off" value={freeAnswers[question.id] ?? ""} onChange={event => setFreeAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} /></label>}
      </fieldset>)}
      <RequestSubmit disabled={disabled || sent} submitted={submitted} formError={formError} />
    </form>}
    {request.kind !== "question" && <form onSubmit={submit} className="agent-request-form">
      {request.kind === "permissions" ? <fieldset className="agent-options"><legend>Решение для этого хода</legend>
        <label className="agent-option"><input type="radio" name={request.requestId} value="grant" checked={permissionChoice === "grant"} onChange={() => setPermissionChoice("grant")} /><span><strong>Предоставить запрошенные права</strong><small>Только на текущий ход.</small></span></label>
        <label className="agent-option"><input type="radio" name={request.requestId} value="none" checked={permissionChoice === "none"} onChange={() => setPermissionChoice("none")} /><span><strong>Не предоставлять дополнительные права</strong><small>Отправить пустой профиль разрешений.</small></span></label>
      </fieldset> : <fieldset className="agent-options"><legend>Доступные решения</legend>{choices.map(choice => <label className="agent-option" key={decisionKey(choice)}><input type="radio" name={request.requestId} value={decisionKey(choice)} checked={decision === decisionKey(choice)} onChange={() => setDecision(decisionKey(choice))} /><span><strong>{decisionLabel(choice)}</strong>{typeof choice === "object" && <small>{decisionDescription(choice)}</small>}</span></label>)}{choices.length === 0 && <p className="agent-muted">Исполнитель не предложил доступных решений. Ответить на этот запрос нельзя.</p>}</fieldset>}
      <RequestSubmit disabled={disabled || sent || (request.kind === "command-approval" && choices.length === 0)} submitted={submitted} formError={formError} />
    </form>}
    {submitted === "accepted" && <p className="agent-mutation-note" role="status">Ответ принят. Ждём подтверждения разрешения от исполнителя.</p>}
    {submitted === "unknown" && <p className="agent-alert" role="status">Результат не подтверждён. Ответ не отправлен повторно.</p>}
    {submitted === "stale" && <p className="agent-alert" role="status">Форма устарела; отправить ответ на неё нельзя.</p>}
  </article>;
}

function RequestSubmit({ disabled, submitted, formError }: { disabled: boolean; submitted?: AnswerState; formError: string }) {
  return <div><button type="submit" className="agent-send-button" disabled={disabled}>{submitted === "sending" ? "Отправляем…" : "Отправить ответ"}</button>{formError && <p className="agent-alert" role="alert">{formError}</p>}</div>;
}

function RequestDetails({ values }: { values: [string, string | null | undefined][] }) {
  const rows = values.filter(([, value]) => value);
  if (!rows.length) return null;
  return <dl className="agent-request-details">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function decisionKey(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value); }
function decisionLabel(value: unknown): string {
  if (typeof value === "string") return ({ accept: "Разрешить", acceptForSession: "Разрешить до конца сессии", decline: "Отклонить", cancel: "Отклонить и остановить ход" } as Record<string, string>)[value] ?? value;
  if (value && typeof value === "object") {
    if ("acceptWithExecpolicyAmendment" in value) return "Разрешить и добавить правило команды";
    if ("applyNetworkPolicyAmendment" in value) return "Применить правило сети";
  }
  return "Решение исполнителя";
}
function decisionDescription(value: object): string {
  const record = value as Record<string, { execpolicy_amendment?: string[]; network_policy_amendment?: { action: string; host: string } }>;
  const policy = record.acceptWithExecpolicyAmendment?.execpolicy_amendment;
  if (policy) return policy.join("\n");
  const network = record.applyNetworkPolicyAmendment?.network_policy_amendment;
  if (network) return `${network.action === "allow" ? "Разрешить" : "Запретить"} ${network.host}`;
  return "";
}

function traceTitle(trace: Trace, kind: string): string {
  if (trace.type === "command") return "Команда";
  if (trace.type === "output") return "Вывод команды";
  if (trace.type === "file-change") return "Изменения файлов";
  if (trace.type === "message") return trace.phase === "commentary" ? "Промежуточный ответ" : trace.phase === "final_answer" ? "Итог" : "Сообщение истории";
  if (kind === "command") return "Команда";
  return "Действие агента";
}

function activityTitle(activityType: string): string {
  return activityType.toLowerCase().includes("plan") ? "План работы" : "Ход работы";
}

function subagentHeading(event: AgentClientState["subagentEvents"][number]): string {
  if (event.type === "SUBAGENT_STARTED") return `Субагент начал работу: ${event.name}`;
  if (event.type === "SUBAGENT_ERROR") return "Субагент сообщил об ошибке";
  return event.outcome?.type === "suspended" ? "Субагент ожидает ввода" : "Субагент завершил работу";
}

function subagentLabel(event: AgentClientState["subagentEvents"][number]): string {
  if (event.type === "SUBAGENT_STARTED") return event.description || "Исполнитель выполняет порученную часть работы.";
  if (event.type === "SUBAGENT_ERROR") return event.message;
  return event.outcome?.type === "suspended" ? "Работа приостановлена до ответа." : "Работа завершена.";
}

function latestSubagentEvents(events: AgentClientState["subagentEvents"]) {
  const byRun = new Map<string, AgentClientState["subagentEvents"][number]>();
  for (const event of events) byRun.set(event.subagentRunId, event);
  return [...byRun.values()];
}

function formKey(state: AgentClientState, request: PendingRequest): string {
  const identity = request.kind === "unsupported" ? `${request.method}-${request.itemId}` : request.requestId;
  return `${state.generation}:${state.selectedThreadId}:${identity}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Время не указано" : new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function errorText(value: unknown): string { return value instanceof Error ? value.message : "Не удалось выполнить запрос."; }
function truncationLabel(reason: string): string { return reason === "upstream-limit" ? "ограничение исполнителя" : reason === "byte-budget" ? "объём данных" : "число элементов"; }
