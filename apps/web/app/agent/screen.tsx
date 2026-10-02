"use client";
// ABOUTME: Показывает выбранный native чат рядом с группами проектов и чатов.
// ABOUTME: История и команды используют существующий клиент; раскладка не управляет исполнителем.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DisplayItem, NativeSnapshot, ModelCatalog, PermissionMode, ThreadMetadata } from "@brai/agent/contracts";
import { createAgentClient, AgentError } from "../../lib/agent/client";
import { mergeThreadMetadata } from "../../lib/agent/thread";
import ModelSettings from "./settings";
import NativeForm from "./request";
import { createLazyReads } from "../../lib/agent/lazy";
import Activities from "./activities";
import Markdown from "./markdown";
import { questionReplies } from "../../lib/agent/question-reply";
import { composerAction, groupTimeline, mergeTimeline } from "./timeline";
import Sidebar, { type Project, type ThreadPage } from "./sidebar";
import { limits } from "@brai/agent/contracts";
import { acceptedDraft, imageModel, prepareImage, type ComposerDraft } from "../../lib/agent/images";

type CachedChat = { snapshot: NativeSnapshot | null; history: DisplayItem[]; generation: string; cursor: string | null; draft: ComposerDraft; model: string; effort: string; permissionMode: PermissionMode; ready: boolean; uncertain: boolean };
const emptyDraft = (): ComposerDraft => ({ text: "", revision: 0, images: [] });
type Props = { active: boolean; userId: string; email: string; onLogout: () => void; onUnauthorized: () => void; accountMessage: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Ошибка связи";
const stateLabels: Record<string, string> = { idle: "Готов", inProgress: "Работает", waiting: "Ждёт ответа", completed: "Завершён", interrupted: "Остановлен", failed: "Ошибка", "connection-lost": "Переподключение", "executor-unavailable": "Codex недоступен" };

/** Сохраняет чат и черновик; active управляет только видимостью и восстановлением прокрутки. */
export default function AgentScreen({ active: visible, userId, email, onLogout, onUnauthorized, accountMessage }: Props) {
  const client = useMemo(() => createAgentClient(userId, onUnauthorized), [userId, onUnauthorized]);
  const lazyReads = useMemo(() => createLazyReads(client.request), [client]);
  const liveMetadata = useRef(new Map<string, Pick<NativeSnapshot, "generation" | "epoch" | "seq" | "thread"> & { observed: number }>());
  const metadataVersion = useRef(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [pages, setPages] = useState<Record<string, ThreadPage>>({});
  const [projectId, setProjectId] = useState(""), [threadId, setThreadId] = useState("");
  const [snapshot, setSnapshot] = useState<NativeSnapshot | null>(null), [connected, setConnected] = useState(false);
  const conversation = useRef<HTMLDivElement>(null), followBottom = useRef(true);
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null);
  const [historyGeneration, setHistoryGeneration] = useState(""), [history, setHistory] = useState<DisplayItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null), [sidebarOpen, setSidebarOpen] = useState(false);
  const [composer, setComposer] = useState<ComposerDraft>(emptyDraft), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const draft = composer.text, attachments = composer.images;
  const composerRef = useRef(composer), currentChat = useRef(`${projectId}:${threadId}`);
  const fileInput = useRef<HTMLInputElement>(null), preparationVersion = useRef(0), alive = useRef(true);
  const queue = useRef<{ file: File; version: number; context: string; duplicate: string; limit: number }[]>([]), preparing = useRef(false);
  const [preparationCount, setPreparationCount] = useState(0);
  const attachmentContext = useRef("");
  currentChat.current = `${projectId}:${threadId}`;
  function changeDraft(next: ComposerDraft) { composerRef.current = next; setComposer(next); }
  function cancelPreparation() { ++preparationVersion.current; queue.current = []; setPreparationCount(0); }
  const locked = useRef(false), selection = useRef(0), uncertain = useRef(false);
  const cache = useRef(new Map<string, CachedChat>());
  const historyReady = useRef(false);
  const [models, setModels] = useState<ModelCatalog | null>(null);
  const [model, setModel] = useState(""), [effort, setEffort] = useState("");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("auto");
  const pageRequests = useRef(new Map<string, symbol>());

  const loadThreads = useCallback(async (id: string, nextCursor?: string) => {
    const token = Symbol(), observed = metadataVersion.current;
    pageRequests.current.set(id, token);
    setPages(previous => ({ ...previous, [id]: { data: previous[id]?.data ?? [], nextCursor: previous[id]?.nextCursor ?? null, loading: true, error: "" } }));
    try {
      const value = await client.request({ action: "threads", projectId: id, ...(nextCursor ? { cursor: nextCursor } : {}) });
      if (pageRequests.current.get(id) !== token) return;
      setPages(previous => {
        const data = [...new Map([...(nextCursor ? previous[id]?.data ?? [] : []), ...value.data.map(thread => { const live = liveMetadata.current.get(`${id}:${thread.id}`); return live && live.generation === value.generation && live.observed > observed ? mergeThreadMetadata(thread, live.thread) : thread; })].map(thread => [thread.id, thread])).values()].slice(0, 1000);
        return { ...previous, [id]: { data, nextCursor: data.length < 1000 ? value.nextCursor : null, loading: false, error: "" } };
      });
    } catch (error) {
      if (pageRequests.current.get(id) === token) setPages(previous => ({ ...previous, [id]: { ...previous[id], loading: false, error: errorText(error) } }));
    }
  }, [client]);

  useEffect(() => {
    let active = true;
    const requests = pageRequests.current;
    const stopMetadata = client.subscribeThreads(value => {
      const key = `${value.projectId}:${value.threadId}`, previous = liveMetadata.current.get(key);
      if (previous && previous.generation === value.generation && previous.epoch === value.epoch && previous.seq > value.seq) return;
      liveMetadata.current.delete(key); liveMetadata.current.set(key, { generation: value.generation, epoch: value.epoch, seq: value.seq, thread: value.thread, observed: ++metadataVersion.current });
      if (liveMetadata.current.size > 1000) liveMetadata.current.delete(liveMetadata.current.keys().next().value!);
      setPages(pages => updateThreadPage(pages, value.projectId, value.thread));
    });
    void client.request({ action: "projects" }).then(value => {
      if (!active) return;
      setProjects(value.projects);
      setProjectId(value.projects.find(project => project.available)?.projectId ?? "");
      for (const project of value.projects) if (project.available) void loadThreads(project.projectId);
    }).catch(error => { if (active) setMessage(errorText(error)); });
    alive.current = true;
    return () => { active = false; alive.current = false; ++preparationVersion.current; queue.current = []; cache.current.clear(); composerRef.current = emptyDraft(); requests.clear(); stopMetadata(); liveMetadata.current.clear(); client.dispose(); };
  }, [client, loadThreads]);

  useEffect(() => {
    ++selection.current;
    setBusy(locked.current); setConnected(!!client.current(projectId, threadId)); uncertain.current = cache.current.get(`${projectId}:${threadId}`)?.uncertain ?? false;
    followBottom.current = true; scrollAnchor.current = null;
    if (!threadId) return;
    const saved = cache.current.get(`${projectId}:${threadId}`);
    let active = true, epoch = saved?.snapshot ? `${saved.snapshot.generation}:${saved.snapshot.epoch}` : "", historyRead = 0, first = true;
    const loadHistory = async (preserve = false) => {
      const token = ++historyRead;
      try {
        const value = await client.request({ action: "items", projectId, threadId });
        if (!active || token !== historyRead) return;
        setHistory(previous => preserve ? mergeTimeline(previous, value.data).slice(-1000) : value.data);
        historyReady.current = true;
        setHistoryGeneration(value.generation); setCursor(value.nextCursor);
      } catch (error) { if (active && token === historyRead) setMessage(errorText(error)); }
    };
    const stop = client.watch(projectId, threadId, value => {
      if (!active) return;
      setConnected(value !== null);
      if (!value) return;
      const nextEpoch = `${value.generation}:${value.epoch}`;
      const changed = epoch && epoch !== nextEpoch;
      const gap = first && saved?.snapshot?.items.length && value.items.length && !value.items.some(item => saved.snapshot!.items.some(old => old.id === item.id));
      if (changed || gap) void loadHistory();
      first = false;
      epoch = nextEpoch;
      // AIDEV-NOTE: Проверяем позицию до snapshot; скрытая вкладка не имеет геометрии и сохраняет режим чтения.
      const element = conversation.current;
      if (element?.getClientRects().length) followBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
      setSnapshot(value);
    });
    if (!saved?.ready) void loadHistory();
    return () => { active = false; stop(); };
  }, [client, projectId, threadId]);

  function selectChat(id: string, chatId = "") {
    if (id === projectId && chatId === threadId) { setSidebarOpen(false); return; }
    ++selection.current;
    cancelPreparation();
    if (threadId) {
      const key = `${projectId}:${threadId}`;
      cache.current.delete(key);
      cache.current.set(key, { snapshot, history, generation: historyGeneration, cursor, draft: composerRef.current, model, effort, permissionMode, ready: historyReady.current, uncertain: uncertain.current });
      if (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
    }
    const saved = cache.current.get(`${id}:${chatId}`);
    historyReady.current = saved?.ready ?? false;
    const live = client.current(id, chatId);
    setSnapshot(live ?? saved?.snapshot ?? null); setHistory(saved?.history ?? []); setHistoryGeneration(saved?.generation ?? ""); setCursor(saved?.cursor ?? null);
    currentChat.current = `${id}:${chatId}`;
    uncertain.current = saved?.uncertain ?? false;
    changeDraft(saved?.draft ?? emptyDraft()); setModel(saved?.model ?? ""); setEffort(saved?.effort ?? ""); setPermissionMode(saved?.permissionMode ?? "auto"); setConnected(!!live);
    followBottom.current = true; scrollAnchor.current = null;
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
    const selected = snapshot, sent = composerRef.current, sentChat = `${projectId}:${threadId}`, token = selection.current, operationId = crypto.randomUUID();
    locked.current = true; setBusy(true); setMessage("");
    try {
      const generation = action === "create" ? (await client.request({ action: "status" })).generation : selected!.generation;
      const value = await client.request({ action, projectId: targetProject, ...(action === "create" ? {} : { threadId }), generation, operationId, ...extra });
      if (value.outcome !== "accepted" || value.generation !== generation || (action === "create" ? typeof value.threadId !== "string" : value.threadId !== selected!.threadId) || value.operationId !== operationId || (action === "answer" && value.requestId !== extra.requestId)) throw new AgentError("BAD_REPLY", "unknown");
      if (!alive.current) return true;
      if (action === "start" || action === "steer") {
        // AIDEV-NOTE: Ответ относится к отправленному чату, даже после ухода и возврата selection.
        if (currentChat.current === sentChat) changeDraft(acceptedDraft(composerRef.current, sent));
        const saved = cache.current.get(sentChat);
        if (saved) saved.draft = acceptedDraft(saved.draft, sent);
      }
      if (action === "create" || action === "start") void loadThreads(targetProject);
      if (token !== selection.current) return true;
      if (action === "create") {
        cache.current.set(`${targetProject}:${value.threadId}`, { snapshot: null, history: [], generation, cursor: null, draft: emptyDraft(), model, effort, permissionMode, ready: false, uncertain: false });
        selectChat(targetProject, value.threadId);
      }
      setMessage("Действие принято."); return true;
    } catch (error) {
      if (!alive.current) return false;
      if (error instanceof AgentError && error.outcome === "unknown") {
        const saved = cache.current.get(sentChat);
        if (saved) saved.uncertain = true;
        if (currentChat.current === sentChat) { uncertain.current = true; setMessage(errorText(error)); }
      }
      if (token !== selection.current) return false;
      uncertain.current = error instanceof AgentError && error.outcome === "unknown";
      setMessage(errorText(error));
      return uncertain.current || (error instanceof AgentError && error.code === "STALE_REQUEST");
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }

  const view = snapshot?.projectId === projectId && snapshot?.threadId === threadId ? snapshot : null;
  const active = view?.turn?.status === "inProgress", disabled = busy || !view || !connected || uncertain.current;
  const project = projects.find(value => value.projectId === projectId);
  const selectedThread = pages[projectId]?.data.find(thread => thread.id === threadId) ?? view?.thread;
  const selectedModel = models?.data.find(value => value.model === (model || view?.thread.model)) ?? models?.data.find(value => value.model === models.defaultModel) ?? models?.data[0];
  const requestedEffort = effort || (selectedModel?.model === view?.thread.model ? view?.thread.reasoningEffort : null);
  const selectedEffort = selectedModel?.efforts.includes(requestedEffort ?? "") ? requestedEffort! : selectedModel?.defaultEffort ?? "";
  const currentImageModel = imageModel(models, view, selectedModel, active);
  const imagesAllowed = !!currentImageModel?.inputModalities.includes("image") && currentImageModel.imageLimit > 0;
  const imageLimit = Math.min(limits.images, currentImageModel?.imageLimit ?? 0);
  attachmentContext.current = `${currentChat.current}:${view?.generation ?? ""}:${currentImageModel?.model ?? ""}:${imagesAllowed}:${imageLimit}`;
  const modelGeneration = snapshot?.generation;
  useEffect(() => {
    if (models && (!modelGeneration || models.generation === modelGeneration)) return;
    let mounted = true;
    void client.request({ action: "models" }).then(value => { if (mounted) setModels(value); }).catch(error => { if (mounted) setMessage(errorText(error)); });
    return () => { mounted = false; };
  }, [client, modelGeneration, models]);
  const title = selectedThread?.title || selectedThread?.preview || (threadId ? "Новый чат" : "Выберите чат");
  const items = mergeTimeline(history, view?.items ?? []);
  const timeline = groupTimeline(items);
  const activityContext = useMemo(() => ({ generation: view?.generation ?? historyGeneration, epoch: view?.epoch ?? "", projectId, threadId }), [view?.generation, view?.epoch, historyGeneration, projectId, threadId]);
  const action = composerAction(active, draft, attachments.length);
  const catalogFresh = !!view && models?.generation === view.generation;
  const imageError = attachments.length && !imagesAllowed ? !catalogFresh ? "Дождитесь свежего каталога моделей и соединения с чатом." : "Эта модель не принимает изображения. Выберите другую модель или удалите вложения." : attachments.length > imageLimit ? `В этом чате можно прикрепить не более ${imageLimit} изображений. Удалите лишние вложения.` : "";
  const sendDisabled = disabled || preparationCount > 0 || !!imageError || (action !== "interrupt" && !catalogFresh) || (action === "start" && ((!draft.trim() && !attachments.length) || !selectedModel || view?.thread.canAcceptDirectInput === false));
  const submit = () => {
    if (sendDisabled) return;
    if (action === "interrupt") void mutate("interrupt", { turnId: view!.turn!.id });
    else void mutate(action, { text: draft, ...(attachments.length ? { images: attachments.map(image => image.dataUrl) } : {}), ...(action === "steer" ? { expectedTurnId: view!.turn!.id } : selectedModel ? { model: selectedModel.model, effort: selectedEffort, permissionMode } : {}) });
  };

  async function processFiles() {
    if (preparing.current) return;
    preparing.current = true;
    try {
      while (queue.current.length && alive.current) {
        const job = queue.current[0];
        if (job.version !== preparationVersion.current || job.context !== attachmentContext.current) { queue.current.shift(); continue; }
        try {
          const current = composerRef.current;
          if (current.images.length >= job.limit) throw new Error(`Можно прикрепить не более ${job.limit} изображений. Удалите одно из вложений.`);
          const image = await prepareImage(job.file, limits.imageBytes - current.images.reduce((sum, image) => sum + image.bytes, 0));
          if (alive.current && job.version === preparationVersion.current && job.context === attachmentContext.current) changeDraft({ ...composerRef.current, images: [...composerRef.current.images, image] });
        } catch (error) {
          if (alive.current && job.version === preparationVersion.current && job.context === attachmentContext.current) setMessage(`${job.file.name || "Изображение"}: ${errorText(error)}`);
        } finally {
          if (queue.current[0] === job) queue.current.shift();
          if (alive.current) setPreparationCount(queue.current.length);
        }
      }
    } finally { preparing.current = false; if (alive.current) setPreparationCount(queue.current.length); }
  }

  function addFiles(files: File[]) {
    if (!files.length) return;
    if (disabled || !imagesAllowed) { setMessage(!catalogFresh ? "Дождитесь свежего каталога моделей и соединения с чатом." : "Эта модель не принимает изображения. Выберите другую модель."); return; }
    let overflow = false;
    for (const file of files) {
      const duplicate = `${preparationVersion.current}:${file.name}:${file.type}:${file.size}:${file.lastModified}`;
      if (queue.current.some(job => job.duplicate === duplicate)) continue;
      if (queue.current.length + composerRef.current.images.length >= imageLimit) { overflow = true; continue; }
      queue.current.push({ file, version: preparationVersion.current, context: attachmentContext.current, duplicate, limit: imageLimit });
    }
    if (overflow) setMessage(`Можно прикрепить не более ${imageLimit} изображений. Лишние файлы не добавлены.`);
    setPreparationCount(queue.current.length);
    void processFiles();
  }

  useLayoutEffect(() => {
    const element = conversation.current, anchor = scrollAnchor.current;
    if (!element || !visible) return;
    if (anchor) { element.scrollTop = anchor.top + element.scrollHeight - anchor.height; scrollAnchor.current = null; }
    else if (followBottom.current) element.scrollTop = element.scrollHeight;
  }, [threadId, history, snapshot, visible]);

  return <main className="agent-shell">
    <Sidebar projects={projects} pages={pages} projectId={projectId} threadId={threadId} open={sidebarOpen} email={email} busy={busy || uncertain.current}
      select={selectChat} create={id => { void mutate("create", selectedModel ? { model: selectedModel.model, permissionMode } : { permissionMode }, id); }} more={id => { const next = pages[id]?.nextCursor; if (next) void loadThreads(id, next); }}
      refresh={id => { void loadThreads(id); }} close={() => setSidebarOpen(false)} logout={onLogout} />
    <section className="agent-workspace" aria-labelledby="agent-chat-title">
      <header className="agent-toolbar">
        <button className="agent-mobile-toggle" aria-controls="agent-sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}>☰ <span>Чаты</span></button>
        <div className="agent-heading"><p>{project?.name ?? "Агент"}</p><h1 id="agent-chat-title" title={title}>{title}</h1></div>
        <span className="agent-chat-status" role="status">{view && connected ? stateLabels[view.state] ?? "Состояние обновляется" : view ? "Переподключение…" : threadId ? "Подключаемся…" : "Готов к выбору"}</span>
      </header>
      <div ref={conversation} className="agent-conversation" aria-label="История" onScroll={event => {
        const element = event.currentTarget;
        followBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
      }}>
        {!threadId && <div className="agent-empty"><span className="agent-empty-symbol" aria-hidden="true">✳</span><h2>С чего начнём?</h2><p>Выберите чат слева или создайте новый в нужном проекте.</p>{project && <button className="agent-primary" disabled={busy || uncertain.current} onClick={() => void mutate("create", selectedModel ? { model: selectedModel.model, permissionMode } : { permissionMode })}>Новый чат · {project.name}</button>}</div>}
        <div className="agent-timeline">
          {cursor && <button className="agent-history-more" onClick={() => void moreHistory()}>Загрузить предыдущие сообщения</button>}
          {timeline.map(entry => entry.kind === "message" ? <Item key={entry.item.id} item={entry.item} /> : <Activities key={`${activityContext.generation}:${activityContext.epoch}:${projectId}:${threadId}:${entry.id}`} items={entry.items} context={activityContext} reads={lazyReads} />)}
          {connected && view?.requests.map(request => <NativeForm key={`${view.generation}:${view.epoch}:${request.requestId}`} request={request} disabled={disabled} send={answer => mutate("answer", { requestId: request.requestId, answer })} />)}
        </div>
      </div>
      <footer className="agent-composer-area">
        <form className="agent-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
          <label className="sr-only" htmlFor="agent-draft">{active ? "Дополнить текущий ход" : "Сообщение"}</label>
          {!!attachments.length && <ul className="agent-attachments" aria-label="Прикреплённые изображения">{attachments.map(image => <li key={image.id}><img src={image.dataUrl} alt={image.name} /><span className="agent-attachment-name" title={image.name}>{image.name}</span>{image.reduced && <span className="agent-image-reduced">Уменьшено</span>}<button type="button" className="agent-attachment-remove" aria-label={`Удалить ${image.name}`} onClick={() => changeDraft({ ...composerRef.current, images: composerRef.current.images.filter(value => value.id !== image.id) })}>×</button></li>)}</ul>}
          <textarea id="agent-draft" disabled={!threadId} placeholder={threadId ? active ? "Дополнить текущее задание…" : "Что нужно сделать?" : "Сначала выберите или создайте чат"} value={draft} onChange={event => changeDraft({ ...composerRef.current, text: event.target.value, revision: composerRef.current.revision + 1 })} onPaste={event => {
            const files = Array.from(event.clipboardData.files);
            if (!files.length) for (const item of Array.from(event.clipboardData.items)) { if (item.kind === "file") { const file = item.getAsFile(); if (file) files.push(file); } }
            if (files.length) { if (!event.clipboardData.getData("text/plain")) event.preventDefault(); addFiles(files); }
          }} onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <div className="agent-composer-actions">
          <input ref={fileInput} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <button type="button" className="agent-attach" aria-label="Прикрепить изображения" title={imagesAllowed ? "Прикрепить PNG, JPEG или WebP" : "Текущая модель не принимает изображения"} disabled={disabled || !imagesAllowed || attachments.length + preparationCount >= imageLimit} onClick={() => fileInput.current?.click()}>+</button>
          <ModelSettings models={models?.data ?? []} model={selectedModel?.model ?? ""} effort={selectedEffort} permissionMode={permissionMode} choosePermissions={setPermissionMode} disabled={busy || active || (!!threadId && !connected)} chooseModel={value => { cancelPreparation(); setModel(value); setEffort(""); }} chooseEffort={setEffort} />
          <button className="agent-send" disabled={sendDisabled}>{action === "interrupt" ? "Стоп" : action === "steer" ? "Скорректировать" : "Отправить"}</button>
          </div>
        </form>
        <p className="agent-feedback" role="alert">{uncertain.current ? "Результат неизвестен. Обновите страницу и проверьте чат перед новой отправкой." : imageError || message || accountMessage}</p>
        {preparationCount > 0 && <p className="agent-image-preparing" role="status">Подготовка изображений: {preparationCount}…</p>}
      </footer>
    </section>
  </main>;
}

/** Сообщения используют безопасный Markdown; тела действий принадлежат отдельному ленивому списку. */
function Item({ item }: { item: DisplayItem }) {
  const replies = item.type === "userMessage" ? questionReplies(item.text) : null;
  return <article data-item-id={item.id} className={`agent-item ${item.type === "userMessage" ? "agent-user-message" : "agent-assistant-message"}`}>
    <span className="agent-message-author">{item.type === "userMessage" ? "Вы" : "Brai"}{item.phase && <span className="agent-message-phase">{item.phase === "final_answer" ? "Итог" : item.phase === "commentary" ? "Промежуточное сообщение" : item.phase}</span>}</span>
    {replies ? <div className="agent-markdown">{replies.map((reply, index) => <div key={index}><p>{reply.question}</p><p><strong>Ответ: </strong>{reply.answer}</p></div>)}</div> : <Markdown text={item.text} />}
    {!!item.imageCount && <p className="agent-message-images">Изображений: {item.imageCount}</p>}
  </article>;
}

function updateThreadPage(pages: Record<string, ThreadPage>, projectId: string, thread: ThreadMetadata): Record<string, ThreadPage> {
  const page = pages[projectId], found = page?.data.some(value => value.id === thread.id);
  const data = found ? page.data.map(value => value.id === thread.id ? mergeThreadMetadata(value, thread) : value) : [thread, ...(page?.data ?? [])].slice(0, 1000);
  return { ...pages, [projectId]: { data, nextCursor: page?.nextCursor ?? null, loading: page?.loading ?? false, error: page?.error ?? "" } };
}
