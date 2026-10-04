"use client";
// ABOUTME: Показывает выбранный native чат рядом с группами проектов и чатов.
// ABOUTME: История и команды используют существующий клиент; раскладка не управляет исполнителем.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DisplayItem, NativeSnapshot, ModelCatalog, PermissionMode, ThreadMetadata, AgentMode } from "@brai/agent/contracts";
import type { AgentLimits } from "@brai/agent/contracts";
import { createAgentClient, AgentError } from "../../lib/agent/client";
import { mergeThreadMetadata } from "../../lib/agent/thread";
import ModelSettings from "./settings";
import NativeForm from "./request";
import { createLazyReads } from "../../lib/agent/lazy";
import Activities from "./activities";
import Markdown from "./markdown";
import { desktopMessage } from "../../lib/agent/desktop-message";
import { questionReplies } from "../../lib/agent/question-reply";
import { composerAction, groupTimeline, mergeTimeline, reconcileCorrections, type PendingCorrection } from "./timeline";
import Sidebar, { type Project, type ThreadPage } from "./sidebar";
import { limits } from "@brai/agent/contracts";
import MessageImages from "./message-images";
import Materials from "./materials";
import { collectMaterials, goalBlocksNewTask, emptyMaterialView, executionText, openMaterial, reconcileMaterialView, type MaterialView } from "./materials-model";
import { acceptedDraft, imageModel, prepareImage, type ComposerDraft } from "../../lib/agent/images";

type CachedChat = { snapshot: NativeSnapshot | null; history: DisplayItem[]; generation: string; cursor: string | null; draft: ComposerDraft; model: string; effort: string; permissionMode: PermissionMode; agentMode: AgentMode; materials: MaterialView; ready: boolean; uncertain: boolean };
type QueuedMessage = { id: string; chat: string; generation: string; draft: ComposerDraft; model: string; effort: string; permissionMode: PermissionMode; agentMode: AgentMode; state: "waiting" | "sending" | "failed" | "unknown" };
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
  const [accountLimits, setAccountLimits] = useState<AgentLimits>({ state: "loading", revision: 0, observedAt: null, windows: [] });
  const [readMessages, setReadMessages] = useState<Record<string, string>>({});
  const [pages, setPages] = useState<Record<string, ThreadPage>>({});
  const [projectId, setProjectId] = useState(""), [threadId, setThreadId] = useState("");
  const [snapshot, setSnapshot] = useState<NativeSnapshot | null>(null), [connected, setConnected] = useState(false);
  const conversation = useRef<HTMLDivElement>(null), followBottom = useRef(true);
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null);
  const [historyGeneration, setHistoryGeneration] = useState(""), [history, setHistory] = useState<DisplayItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null), [sidebarOpen, setSidebarOpen] = useState(false);
  const [composer, setComposer] = useState<ComposerDraft>(emptyDraft), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [corrections, setCorrections] = useState<PendingCorrection[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [awaitingTurn, setAwaitingTurn] = useState<{ chat: string; generation: string; turnId: string | null; seq: number; agentMode: AgentMode }[]>([]);
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
  const [agentMode, setAgentMode] = useState<AgentMode>("default");
  const [materialView, setMaterialView] = useState<MaterialView>(emptyMaterialView);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const archived = useRef(new Set<string>());
  const pageRequests = useRef(new Map<string, symbol>());

  const loadThreads = useCallback(async (id: string, nextCursor?: string) => {
    const token = Symbol(), observed = metadataVersion.current;
    pageRequests.current.set(id, token);
    setPages(previous => ({ ...previous, [id]: { data: previous[id]?.data ?? [], nextCursor: previous[id]?.nextCursor ?? null, loading: true, error: "" } }));
    try {
      const value = await client.request({ action: "threads", projectId: id, ...(nextCursor ? { cursor: nextCursor } : {}) });
      if (pageRequests.current.get(id) !== token) return;
      setPages(previous => {
        const data = [...new Map([...(nextCursor ? previous[id]?.data ?? [] : []), ...value.data.filter(thread => !archived.current.has(`${id}:${thread.id}`)).map(thread => { const live = liveMetadata.current.get(`${id}:${thread.id}`); return live && live.generation === value.generation && live.observed > observed ? mergeThreadMetadata(thread, live.thread) : thread; })].map(thread => [thread.id, thread])).values()].slice(0, 1000);
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
      const key = `${value.projectId}:${value.threadId}`;
      if (archived.current.has(key)) return;
      const previous = liveMetadata.current.get(key);
      if (previous && previous.generation === value.generation && previous.epoch === value.epoch && previous.seq > value.seq) return;
      liveMetadata.current.delete(key); liveMetadata.current.set(key, { generation: value.generation, epoch: value.epoch, seq: value.seq, thread: value.thread, observed: ++metadataVersion.current });
      if (liveMetadata.current.size > 1000) liveMetadata.current.delete(liveMetadata.current.keys().next().value!);
      setPages(pages => updateThreadPage(pages, value.projectId, value.thread));
    });
    const stopLimits = client.subscribeLimits(setAccountLimits);
    void client.request({ action: "projects" }).then(value => {
      if (!active) return;
      setProjects(value.projects);
      setProjectId(value.projects.find(project => project.available)?.projectId ?? "");
      for (const project of value.projects) if (project.available) void loadThreads(project.projectId);
    }).catch(error => { if (active) setMessage(errorText(error)); });
    alive.current = true;
    return () => { active = false; alive.current = false; ++preparationVersion.current; queue.current = []; cache.current.clear(); composerRef.current = emptyDraft(); requests.clear(); stopMetadata(); stopLimits(); liveMetadata.current.clear(); client.dispose(); };
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
      cache.current.set(key, { snapshot, history, generation: historyGeneration, cursor, draft: composerRef.current, model, effort, permissionMode, agentMode, materials: materialView, ready: historyReady.current, uncertain: uncertain.current });
      if (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
    }
    const saved = cache.current.get(`${id}:${chatId}`);
    historyReady.current = saved?.ready ?? false;
    const live = client.current(id, chatId);
    setSnapshot(live ?? saved?.snapshot ?? null); setHistory(saved?.history ?? []); setHistoryGeneration(saved?.generation ?? ""); setCursor(saved?.cursor ?? null);
    currentChat.current = `${id}:${chatId}`;
    uncertain.current = saved?.uncertain ?? false;
    changeDraft(saved?.draft ?? emptyDraft()); setModel(saved?.model ?? ""); setEffort(saved?.effort ?? ""); setPermissionMode(saved?.permissionMode ?? "auto"); setAgentMode(saved?.agentMode ?? "default"); setMaterialView(saved?.materials ?? emptyMaterialView()); setConnected(!!live);
    followBottom.current = true; scrollAnchor.current = null;
    setProjectId(id); setThreadId(chatId); setMessage(""); setSidebarOpen(false);
  }

  const selectChatRef = useRef(selectChat);
  selectChatRef.current = selectChat;

  async function archiveChat(id: string, chatId: string) {
    if (locked.current || uncertain.current) return;
    locked.current = true; setBusy(true); setMessage("");
    const key = `${id}:${chatId}`, operationId = crypto.randomUUID();
    try {
      const { generation } = await client.request({ action: "status" });
      const reply = await client.request({ action: "archive", projectId: id, threadId: chatId, generation, operationId });
      if (reply.outcome !== "accepted" || reply.generation !== generation || reply.operationId !== operationId || reply.threadId !== chatId) throw new AgentError("BAD_REPLY", "unknown");
      if (!alive.current) return;
      archived.current.add(key);
      setCorrections(previous => previous.filter(value => value.chat !== key));
      setQueuedMessages(previous => previous.filter(value => value.chat !== key));
      setAwaitingTurn(previous => previous.filter(value => value.chat !== key));
      liveMetadata.current.delete(key);
      setPages(previous => {
        const page = previous[id];
        return page ? { ...previous, [id]: { ...page, data: page.data.filter(thread => thread.id !== chatId) } } : previous;
      });
      if (currentChat.current === key) selectChatRef.current(id);
      cache.current.delete(key);
    } catch (error) {
      if (alive.current) setMessage(errorText(error));
    } finally { locked.current = false; if (alive.current) setBusy(false); }
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

  async function mutate(action: "create" | "start" | "steer" | "interrupt" | "answer" | "goalSet" | "goalClear", extra: Record<string, unknown> = {}, targetProject = projectId, queuedDraft?: ComposerDraft) {
    if (!targetProject || locked.current || uncertain.current || (action !== "create" && (!connected || !snapshot || snapshot.projectId !== projectId || snapshot.threadId !== threadId))) return false;
    const selected = snapshot, sent = queuedDraft ?? composerRef.current, sentChat = `${projectId}:${threadId}`, token = selection.current, operationId = crypto.randomUUID();
    locked.current = true; setBusy(true); setMessage("");
    if (action === "steer") {
      followBottom.current = true;
      setCorrections(previous => [...previous, { chat: sentChat, generation: selected!.generation,
        knownIds: mergeTimeline(history, selected!.items).map(item => item.id), state: "sending",
        item: { id: operationId, turnId: selected!.turn!.id, type: "userMessage", text: sent.text, imageCount: sent.images.length, images: sent.images.map(image => image.dataUrl) } }]);
    }
    try {
      const generation = action === "create" ? (await client.request({ action: "status" })).generation : selected!.generation;
      const value = await client.request({ action, projectId: targetProject, ...(action === "create" ? {} : { threadId }), generation, operationId, ...extra });
      if (value.outcome !== "accepted" || value.generation !== generation || (action === "create" ? typeof value.threadId !== "string" : value.threadId !== selected!.threadId) || value.operationId !== operationId || (action === "answer" && value.requestId !== extra.requestId)) throw new AgentError("BAD_REPLY", "unknown");
      if (!alive.current) return true;
      if (action === "steer") setCorrections(previous => previous.map(value => value.item.id === operationId ? { ...value, state: "waiting" } : value));
      if (action === "start" || (action === "goalSet" && extra.status === "active")) setAwaitingTurn(previous => [...previous.filter(value => value.chat !== sentChat), { chat: sentChat, generation, turnId: selected!.turn?.id ?? null, seq: selected!.seq, agentMode: action === "goalSet" ? "goal" : (extra.agentMode as AgentMode ?? "default") }]);
      if (!queuedDraft && (action === "start" || action === "steer")) {
        // AIDEV-NOTE: Ответ относится к отправленному чату, даже после ухода и возврата selection.
        if (currentChat.current === sentChat) changeDraft(acceptedDraft(composerRef.current, sent));
        const saved = cache.current.get(sentChat);
        if (saved) saved.draft = acceptedDraft(saved.draft, sent);
      }
      if (action === "create" || action === "start") void loadThreads(targetProject);
      if (token !== selection.current) return true;
      if (action === "create") {
        cache.current.set(`${targetProject}:${value.threadId}`, { snapshot: null, history: [], generation, cursor: null, draft: emptyDraft(), model, effort, permissionMode, agentMode, materials: emptyMaterialView(), ready: false, uncertain: false });
        selectChat(targetProject, value.threadId);
      }
      setMessage("Действие принято."); return true;
    } catch (error) {
      if (!alive.current) return false;
      if (queuedDraft && error instanceof AgentError && error.outcome === "unknown") setQueuedMessages(previous => previous.map(value => value.draft === queuedDraft ? { ...value, state: "unknown" } : value));
      if (action === "steer") setCorrections(previous => previous.map(value => value.item.id === operationId ? { ...value, state: error instanceof AgentError && error.outcome === "unknown" ? "unknown" : "failed" } : value));
      if (error instanceof AgentError && error.outcome === "unknown") {
        const saved = cache.current.get(sentChat);
        if (saved) saved.uncertain = true;
        if (currentChat.current === sentChat) { uncertain.current = true; setMessage(errorText(error)); }
      }
      if (token !== selection.current) return false;
      uncertain.current = error instanceof AgentError && error.outcome === "unknown";
      setMessage(errorText(error));
      return !queuedDraft && (uncertain.current || (error instanceof AgentError && error.code === "STALE_REQUEST"));
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }

  const view = snapshot?.projectId === projectId && snapshot?.threadId === threadId ? snapshot : null;
  const goalUnfinished = goalBlocksNewTask(view);
  const active = view?.turn?.status === "inProgress", disabled = busy || !view || !connected || uncertain.current;
  const project = projects.find(value => value.projectId === projectId);
  const selectedThread = pages[projectId]?.data.find(thread => thread.id === threadId) ?? view?.thread;
  const selectedModel = models?.data.find(value => value.model === (model || view?.thread.model)) ?? models?.data.find(value => value.model === models.defaultModel) ?? models?.data[0];
  const requestedEffort = effort || (selectedModel?.model === view?.thread.model ? view?.thread.reasoningEffort : null);
  const selectedEffort = selectedModel?.efforts.includes(requestedEffort ?? "") ? requestedEffort! : selectedModel?.defaultEffort ?? "";
  const currentImageModel = imageModel(models, view, selectedModel, active);
  const imagesAllowed = (active || agentMode !== "goal") && !!currentImageModel?.inputModalities.includes("image") && currentImageModel.imageLimit > 0;
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
  const materials = collectMaterials(items, view);
  useEffect(() => {
    setMaterialView(previous => reconcileMaterialView(previous, collectMaterials(mergeTimeline(history, view?.items ?? []), view)));
  }, [history, view]);
  const chooseMaterial = (id: string) => setMaterialView(previous => openMaterial(previous, id));
  const pendingCorrections = reconcileCorrections(corrections, currentChat.current, view?.generation ?? historyGeneration, items).filter(value => value.chat === currentChat.current);
  useEffect(() => {
    setCorrections(previous => {
      const next = reconcileCorrections(previous, `${projectId}:${threadId}`, view?.generation ?? historyGeneration, mergeTimeline(history, view?.items ?? []));
      return next.length === previous.length ? previous : next;
    });
  }, [projectId, threadId, view, history, historyGeneration]);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(`brai.agent.read:${userId}`) ?? "{}");
      setReadMessages(saved && typeof saved === "object" && !Array.isArray(saved) ? Object.fromEntries(Object.entries(saved).filter(([key, value]) => key.length <= 300 && typeof value === "string" && value.length <= 128).slice(-1000)) : {});
    } catch { setReadMessages({}); }
  }, [userId]);
  // AIDEV-NOTE: Чтение относится к показанной истории; metadata live окна может не содержать старый итог.
  const lastShownMessage = items.findLast(item => item.type === "userMessage" || item.type === "agentMessage");
  const readMessageId = lastShownMessage?.type === "agentMessage" && lastShownMessage.phase === "final_answer" ? lastShownMessage.id : null;
  const readEpoch = view?.epoch;
  useEffect(() => {
    const messageId = readMessageId;
    if (!visible || active || !messageId) return;
    const marker = Array.from(conversation.current?.querySelectorAll<HTMLElement>("[data-read-message]") ?? []).find(element => element.dataset.readMessage === messageId);
    if (!marker) return;
    const key = `${projectId}:${threadId}`;
    const markRead = () => {
      const rect = marker.getBoundingClientRect(), area = conversation.current?.getBoundingClientRect();
      if (document.visibilityState !== "visible" || !marker.getClientRects().length || !area || rect.bottom < area.top || rect.top > area.bottom + 1) return;
      setReadMessages(previous => {
        if (previous[key] === messageId) return previous;
        const next = Object.fromEntries([...Object.entries(previous).filter(([id]) => id !== key), [key, messageId]].slice(-1000));
        try { localStorage.setItem(`brai.agent.read:${userId}`, JSON.stringify(next)); } catch { /* Чтение сохраняется в памяти при недоступном хранилище. */ }
        return next;
      });
    };
    // AIDEV-NOTE: Частые snapshot не пересоздают observer; scroll и первый кадр снимают зависимость от задержки его callback.
    const element = conversation.current;
    const frame = requestAnimationFrame(markRead);
    const observer = new IntersectionObserver(markRead, { root: element, threshold: 0 });
    observer.observe(marker);
    element?.addEventListener("scroll", markRead, { passive: true });
    document.addEventListener("visibilitychange", markRead);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); element?.removeEventListener("scroll", markRead); document.removeEventListener("visibilitychange", markRead); };
  }, [visible, userId, projectId, threadId, readMessageId, readEpoch, active, history]);
  const timeline = groupTimeline(items);
  const activityContext = useMemo(() => ({ generation: view?.generation ?? historyGeneration, epoch: view?.epoch ?? "", projectId, threadId }), [view?.generation, view?.epoch, historyGeneration, projectId, threadId]);
  const action = !draft.trim() && !attachments.length && goalUnfinished ? "goalClear" : composerAction(active, draft, attachments.length);
  const catalogFresh = !!view && models?.generation === view.generation;
  const imageError = attachments.length && !active && agentMode === "goal" ? "В режиме «Цель» отправьте описание задачи без изображений. Удалите вложения или выберите другой режим." : attachments.length && !imagesAllowed ? !catalogFresh ? "Дождитесь свежего каталога моделей и соединения с чатом." : "Эта модель не принимает изображения. Выберите другую модель или удалите вложения." : attachments.length > imageLimit ? `В этом чате можно прикрепить не более ${imageLimit} изображений. Удалите лишние вложения.` : "";
  const sendDisabled = disabled || (action === "goalClear" && view?.goal?.state !== "ready") || preparationCount > 0 || !!imageError || (action === "steer" && corrections.length >= 64) || (action !== "interrupt" && action !== "goalClear" && !catalogFresh) || (action === "start" && (goalUnfinished || (!draft.trim() && !attachments.length) || !selectedModel || view?.thread.canAcceptDirectInput === false || awaitingTurn.some(value => value.chat === currentChat.current)));
  const submit = () => {
    if (sendDisabled) return;
    if (action === "goalClear") void mutate("goalClear");
    else if (action === "interrupt") void mutate("interrupt", { turnId: view!.turn!.id });
    else void mutate(action, { text: draft, ...(attachments.length ? { images: attachments.map(image => image.dataUrl) } : {}), ...(action === "steer" ? { expectedTurnId: view!.turn!.id } : selectedModel ? { model: selectedModel.model, effort: selectedEffort, permissionMode, agentMode } : {}) });
  };

  function enqueueMessage() {
    if (agentMode === "goal" && composerRef.current.images.length) { setMessage("В режиме «Цель» сообщение в очереди должно содержать описание задачи без изображений. Вложения и текст сохранены."); return; }
    if (disabled || preparationCount || imageError || !catalogFresh || !selectedModel || (!draft.trim() && !attachments.length)) return;
    if (queuedMessages.length >= 16) { setMessage("Очередь заполнена. Дождитесь отправки или удалите сообщение."); return; }
    const sent = composerRef.current;
    setQueuedMessages(previous => [...previous, { id: crypto.randomUUID(), chat: currentChat.current, generation: view!.generation, draft: sent, model: selectedModel.model, effort: selectedEffort, permissionMode, agentMode, state: "waiting" }]);
    changeDraft(acceptedDraft(sent, sent));
    setMessage("Сообщение поставлено в очередь.");
  }

  useEffect(() => {
    if (!view || !connected) return;
    const awaiting = awaitingTurn.find(value => value.chat === currentChat.current);
    if (awaiting && (awaiting.generation !== view.generation || awaiting.turnId !== (view.turn?.id ?? null) || (awaiting.agentMode === "goal" && view.seq > awaiting.seq && view.goal?.state === "ready"))) {
      setAwaitingTurn(previous => previous.filter(value => value !== awaiting));
      return;
    }
    const next = queuedMessages.find(value => value.chat === currentChat.current);
    if (!next || next.state !== "waiting" || awaiting || disabled || locked.current || active || goalUnfinished || view.requests.length || !catalogFresh || view.thread.canAcceptDirectInput === false) return;
    const choice = models!.data.find(value => value.model === next.model);
    if (next.generation !== view.generation || !choice || !choice.efforts.includes(next.effort) || (next.draft.images.length && (next.agentMode === "goal" || !choice.inputModalities.includes("image") || next.draft.images.length > choice.imageLimit))) {
      setQueuedMessages(previous => previous.map(value => value.id === next.id ? { ...value, state: "failed" } : value));
      setMessage("Настройки сообщения в очереди устарели. Удалите его и отправьте заново.");
      return;
    }
    setQueuedMessages(previous => previous.map(value => value.id === next.id ? { ...value, state: "sending" } : value));
    // AIDEV-NOTE: Следующее сообщение ждёт нового native turn ID, а не только HTTP accepted со старым idle snapshot.
    void mutate("start", { text: next.draft.text, ...(next.draft.images.length ? { images: next.draft.images.map(image => image.dataUrl) } : {}), model: next.model, effort: next.effort, permissionMode: next.permissionMode, agentMode: next.agentMode }, projectId, next.draft).then(accepted => {
      if (!alive.current) return;
      setQueuedMessages(previous => accepted ? previous.filter(value => value.id !== next.id) : previous.map(value => value.id === next.id && value.state === "sending" ? { ...value, state: "failed" } : value));
    });
  });

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
    if (disabled || !imagesAllowed) { setMessage(!active && agentMode === "goal" ? "В режиме «Цель» отправьте описание задачи без изображений. Изображения недоступны в этом режиме." : !catalogFresh ? "Дождитесь свежего каталога моделей и соединения с чатом." : "Эта модель не принимает изображения. Выберите другую модель."); return; }
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
  }, [threadId, history, snapshot, visible, corrections]);

  async function executePlan(item: DisplayItem) {
    if (disabled || active || goalUnfinished || !catalogFresh || !selectedModel || view?.thread.canAcceptDirectInput === false || awaitingTurn.some(value => value.chat === currentChat.current)) return;
    let text: string;
    try { text = executionText(item); } catch (error) { setMessage(errorText(error)); return; }
    // AIDEV-NOTE: Выполнение документа не очищает отдельный пользовательский черновик.
    const sentChat = currentChat.current;
    const accepted = await mutate("start", { text, agentMode: "default", model: selectedModel.model, effort: selectedEffort, permissionMode }, projectId, { text, revision: -1, images: [] });
    if (accepted) {
      if (currentChat.current === sentChat) setAgentMode("default");
      const saved = cache.current.get(sentChat);
      if (saved) saved.agentMode = "default";
    }
  }

  function revisePlan(item: DisplayItem) {
    if (disabled || active) return;
    setAgentMode("plan");
    setMaterialView(previous => ({ ...previous, open: false }));
    setMessage(`Режим «Планирование». Опишите правки к плану ${materials.find(value => value.kind === "plan" && value.item.id === item.id)?.title ?? ""}; сообщение ещё не отправлено.`);
    requestAnimationFrame(() => composerInput.current?.focus());
  }

  return <main className="agent-shell">
    <Sidebar readMessages={readMessages} projects={projects} pages={pages} projectId={projectId} threadId={threadId} open={sidebarOpen} email={email} busy={busy || uncertain.current} accountLimits={accountLimits}
      select={selectChat} create={id => { void mutate("create", selectedModel ? { model: selectedModel.model, permissionMode } : { permissionMode }, id); }} more={id => { const next = pages[id]?.nextCursor; if (next) void loadThreads(id, next); }}
      archive={(id, chatId) => { void archiveChat(id, chatId); }} refresh={id => { void loadThreads(id); }} close={() => setSidebarOpen(false)} logout={onLogout} />
    <section className="agent-workspace" aria-labelledby="agent-chat-title">
      <header className="agent-toolbar">
        <button className="agent-mobile-toggle" aria-controls="agent-sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}>☰ <span>Чаты</span></button>
        <div className="agent-heading"><p>{project?.name ?? "Агент"}</p><h1 id="agent-chat-title" title={title}>{title}</h1></div>
        {materials.length > 0 && <button type="button" className="agent-materials-toggle" aria-expanded={materialView.open} onClick={() => chooseMaterial(materialView.selected || materials.at(-1)!.id)}>Материалы{materialView.updated.length > 0 ? " · обновлено" : ""}</button>}
        <span className="agent-chat-status" role="status">{view && connected ? view.goal?.state === "ready" && view.goal.value?.status === "active" ? "Достигает цели" : stateLabels[view.state] ?? "Состояние обновляется" : view ? "Переподключение…" : threadId ? "Подключаемся…" : "Готов к выбору"}</span>
      </header>
      <div ref={conversation} className="agent-conversation" aria-label="История" onScroll={event => {
        const element = event.currentTarget;
        followBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
      }}>
        {!threadId && <div className="agent-empty"><span className="agent-empty-symbol" aria-hidden="true">✳</span><h2>С чего начнём?</h2><p>Выберите чат слева или создайте новый в нужном проекте.</p>{project && <button className="agent-primary" disabled={busy || uncertain.current} onClick={() => void mutate("create", selectedModel ? { model: selectedModel.model, permissionMode } : { permissionMode })}>Новый чат · {project.name}</button>}</div>}
        <div className="agent-timeline">
          {cursor && <button className="agent-history-more" onClick={() => void moreHistory()}>Загрузить предыдущие сообщения</button>}
          {timeline.map(entry => entry.kind === "message" ? entry.item.type === "plan" ? <button key={entry.item.id} type="button" className="agent-material-card" onClick={() => chooseMaterial(`plan:${entry.item.id}`)}>Предложенный план <span>{materialView.updated.includes(`plan:${entry.item.id}`) ? "Обновлено · " : ""}Открыть →</span></button> : <Item key={`${activityContext.generation}:${activityContext.epoch}:${projectId}:${threadId}:${entry.item.id}`} item={entry.item} context={activityContext} reads={lazyReads} /> : <Activities key={`${activityContext.generation}:${activityContext.epoch}:${projectId}:${threadId}:${entry.id}`} items={entry.items} context={activityContext} reads={lazyReads} />)}
          {materials.filter(value => value.kind !== "plan").map(value => <button key={value.id} type="button" className="agent-material-card" onClick={() => chooseMaterial(value.id)}>{value.title}<span>{materialView.updated.includes(value.id) ? "Обновлено · " : ""}Открыть →</span></button>)}
          {pendingCorrections.map(value => <Item key={value.item.id} item={value.item} context={activityContext} reads={lazyReads} pending={value.state} dismiss={() => setCorrections(previous => previous.filter(item => item.item.id !== value.item.id))} />)}
          {connected && view?.requests.map(request => <NativeForm key={`${view.generation}:${view.epoch}:${request.requestId}`} request={request} disabled={disabled} send={answer => mutate("answer", { requestId: request.requestId, answer })} />)}
        </div>
      </div>
      {(threadId || message || accountMessage) && <footer className="agent-composer-area">
        {queuedMessages.some(value => value.chat === currentChat.current) && <ul className="agent-message-queue" aria-label="Очередь сообщений">{queuedMessages.filter(value => value.chat === currentChat.current).map(value => <li key={value.id}>
          <span>{value.draft.text || "Изображения"}{!!value.draft.images.length && ` · Изображений: ${value.draft.images.length}`} · {value.agentMode === "plan" ? "Планирование" : value.agentMode === "goal" ? "Цель" : "Обычный"} · {value.state === "sending" ? "Отправляется" : value.state === "unknown" ? "Результат неизвестен — проверьте чат" : value.state === "failed" ? "Не отправлено — очередь остановлена" : "В очереди"}</span>
          <button type="button" disabled={value.state === "sending"} onClick={() => setQueuedMessages(previous => previous.filter(item => item.id !== value.id))} aria-label="Удалить сообщение из очереди">×</button>
        </li>)}</ul>}
        {threadId && <form className="agent-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
          <label className="sr-only" htmlFor="agent-draft">{active ? "Дополнить текущий ход" : "Сообщение"}</label>
          {!!attachments.length && <ul className="agent-attachments" aria-label="Прикреплённые изображения">{attachments.map(image => <li key={image.id}><img src={image.dataUrl} alt={image.name} /><span className="agent-attachment-name" title={image.name}>{image.name}</span>{image.reduced && <span className="agent-image-reduced">Уменьшено</span>}<button type="button" className="agent-attachment-remove" aria-label={`Удалить ${image.name}`} onClick={() => changeDraft({ ...composerRef.current, images: composerRef.current.images.filter(value => value.id !== image.id) })}>×</button></li>)}</ul>}
          <textarea ref={composerInput} id="agent-draft" placeholder={active ? "Дополнить текущее задание…" : agentMode === "goal" ? "Какой цели нужно достичь?" : agentMode === "plan" ? "Что нужно спланировать?" : "Что нужно сделать?"} value={draft} onChange={event => changeDraft({ ...composerRef.current, text: event.target.value, revision: composerRef.current.revision + 1 })} onPaste={event => {
            const files = Array.from(event.clipboardData.files);
            if (!files.length) for (const item of Array.from(event.clipboardData.items)) { if (item.kind === "file") { const file = item.getAsFile(); if (file) files.push(file); } }
            if (files.length) { if (!event.clipboardData.getData("text/plain")) event.preventDefault(); addFiles(files); }
          }} aria-description="Enter — отправить или скорректировать; Shift+Enter — новая строка; Ctrl/⌘+Enter — в очередь" onKeyDown={event => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.altKey || event.shiftKey) return;
            event.preventDefault();
            if (event.repeat) return;
            if (event.ctrlKey || event.metaKey) enqueueMessage();
            else if (draft.trim() || attachments.length) event.currentTarget.form?.requestSubmit();
          }} />
          <div className="agent-composer-actions">
          <input ref={fileInput} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <button type="button" className="agent-attach" aria-label="Прикрепить изображения" title={imagesAllowed ? "Прикрепить PNG, JPEG или WebP" : !active && agentMode === "goal" ? "В режиме «Цель» изображения недоступны" : "Текущая модель не принимает изображения"} disabled={disabled || !imagesAllowed || attachments.length + preparationCount >= imageLimit} onClick={() => fileInput.current?.click()}>+</button>
          <select className="agent-mode-select" aria-label="Режим агента" value={agentMode} disabled={disabled || active || goalUnfinished} onChange={event => { cancelPreparation(); setAgentMode(event.target.value as AgentMode); }}><option value="default">Обычный</option><option value="plan">Планирование</option><option value="goal">Цель</option></select>
          <ModelSettings models={models?.data ?? []} model={selectedModel?.model ?? ""} effort={selectedEffort} permissionMode={permissionMode} choosePermissions={setPermissionMode} disabled={busy || active || goalUnfinished || (!!threadId && !connected)} chooseModel={value => { cancelPreparation(); setModel(value); setEffort(""); }} chooseEffort={setEffort} />
          <button className="agent-send" disabled={sendDisabled}>{action === "interrupt" || action === "goalClear" ? "Стоп" : action === "steer" ? "Скорректировать" : "Отправить"}</button>
          </div>
          {agentMode === "goal" && !active && <small className="agent-composer-hint">В режиме «Цель» отправьте описание задачи без изображений.</small>}
          <small className="agent-composer-hint">Enter — отправить · Shift+Enter — новая строка · Ctrl/⌘+Enter — в очередь</small>
        </form>}
        <p className="agent-feedback" role="alert">{uncertain.current ? "Результат неизвестен. Обновите страницу и проверьте чат перед новой отправкой." : imageError || message || accountMessage}</p>
        {corrections.length >= 64 && <p role="status">Дождитесь применения корректировок или уберите сообщения с ошибкой перед новой корректировкой.</p>}
        {preparationCount > 0 && <p className="agent-image-preparing" role="status">Подготовка изображений: {preparationCount}…</p>}
      </footer>}
    </section>
    {materialView.open && <Materials focus={materialView.focus} materials={materials} selected={materialView.selected} choose={chooseMaterial} close={() => setMaterialView(previous => ({ ...previous, open: false }))} disabled={disabled || !catalogFresh || awaitingTurn.some(value => value.chat === currentChat.current)} active={!!active || goalUnfinished} connected={connected} execute={item => { void executePlan(item); }} revise={revisePlan} goal={action => { void mutate(action === "stop" ? "goalClear" : "goalSet", action === "stop" ? {} : { status: action === "pause" ? "paused" : "active" }); }} />}
  </main>;
}

/** Сообщения используют безопасный Markdown; тела действий принадлежат отдельному ленивому списку. */
function Item({ item, context, reads, pending, dismiss }: { item: DisplayItem; context: Parameters<typeof MessageImages>[0]["context"]; reads: Parameters<typeof MessageImages>[0]["reads"]; pending?: PendingCorrection["state"]; dismiss?: () => void }) {
  const replies = item.type === "userMessage" ? questionReplies(item.text) : null;
  return <article data-item-id={item.id} className={`agent-item ${item.type === "userMessage" ? "agent-user-message" : "agent-assistant-message"}`}>
    <span className="agent-message-author">{item.type === "userMessage" ? "Вы" : "Brai"}{item.phase && <span className="agent-message-phase">{item.phase === "final_answer" ? "Итог" : item.phase === "commentary" ? "Промежуточное сообщение" : item.phase}</span>}</span>
    {pending && <span className="agent-correction-status" role="status"><span aria-hidden="true">{pending === "failed" || pending === "unknown" ? "⚠" : "◷"}</span> {pending === "sending" ? "Отправляется…" : pending === "waiting" ? "Ожидает применения" : pending === "unknown" ? "Отправка не подтверждена. Проверьте чат." : "Не отправлено. Повторите из поля ввода."}{pending === "failed" && <button type="button" onClick={dismiss}>Убрать</button>}</span>}
    {replies ? <div className="agent-markdown">{replies.map((reply, index) => <div key={index}><p>{reply.question}</p><p><strong>Ответ: </strong>{reply.answer}</p></div>)}</div> : <Markdown text={item.type === "userMessage" ? desktopMessage(item.text) : item.text} />}
    {item.type === "agentMessage" && item.phase === "final_answer" && <span className="agent-message-read-marker" data-read-message={item.id} aria-hidden="true" />}
    {!!item.imageCount && (pending ? <ul className="agent-message-thumbnails" aria-label="Изображения сообщения">{item.images?.map((src, index) => <li key={index}><img src={src} alt={`Прикреплённое изображение ${index + 1}`} /></li>)}</ul> : <MessageImages item={item} context={context} reads={reads} />)}
  </article>;
}

function updateThreadPage(pages: Record<string, ThreadPage>, projectId: string, thread: ThreadMetadata): Record<string, ThreadPage> {
  const page = pages[projectId], found = page?.data.some(value => value.id === thread.id);
  const data = found ? page.data.map(value => value.id === thread.id ? mergeThreadMetadata(value, thread) : value) : [thread, ...(page?.data ?? [])].slice(0, 1000);
  return { ...pages, [projectId]: { data, nextCursor: page?.nextCursor ?? null, loading: page?.loading ?? false, error: page?.error ?? "" } };
}
