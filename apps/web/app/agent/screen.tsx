"use client";
// ABOUTME: Собирает Agent workspace на shared controls и текущем native клиенте.
// ABOUTME: История, команды, черновики и исполнение остаются у прежних владельцев.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DisplayItem, NativeSnapshot, ModelCatalog, PermissionMode, ThreadMetadata, AgentMode } from "@brai/agent/contracts";
import type { AgentLimits } from "@brai/agent/contracts";
import { createAgentClient, AgentError } from "../../lib/agent/client";
import { mergeThreadMetadata } from "../../lib/agent/thread";
import ModelSettings, { AgentModeButton, ComposerIcon } from "./settings";
import NativeForm from "./request";
import QuestionCard from "./questions";
import TurnErrorNotice from "./turn-error";
import { createLazyReads } from "../../lib/agent/lazy";
import Activities from "./activities";
import MessageText from "./message-text";
import { composerAction, groupTimeline, mergeTimeline, reconcileCorrections, type PendingCorrection } from "./timeline";
import Sidebar, { type Project, type ThreadPage } from "./sidebar";
import { limits } from "@brai/agent/contracts";
import MessageImages from "./message-images";
import Materials from "./materials";
import { collectMaterials, goalBlocksNewTask, emptyMaterialView, executionText, openMaterial, reconcileMaterialView, type MaterialView } from "./materials-model";
import { acceptedDraft, restoredDraft, confirmedSubmission, imageModel, prepareImage, releaseAttachmentPreview, type Attachment, type ComposerDraft } from "../../lib/agent/images";
import { uploadAttachment } from "../../lib/agent/uploads";
import ImageUploadStatus from "./image-upload-status";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import "./agent.css";

type CachedChat = { snapshot: NativeSnapshot | null; history: DisplayItem[]; generation: string; cursor: string | null; draft: ComposerDraft; model: string; effort: string; permissionMode: PermissionMode; agentMode: AgentMode; materials: MaterialView; ready: boolean; uncertain: boolean };
type QueuedMessage = { id: string; chat: string; generation: string; draft: ComposerDraft; model: string; effort: string; permissionMode: PermissionMode; agentMode: AgentMode; state: "waiting" | "sending" | "failed" | "unknown" };
const emptyDraft = (): ComposerDraft => ({ text: "", revision: 0, images: [] });
const defaultModelId = "gpt-6.1-sol", defaultEffort = "medium";
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
  const [composer, setComposer] = useState<ComposerDraft>(emptyDraft), [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false);
  const [corrections, setCorrections] = useState<PendingCorrection[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]), queuedMessagesRef = useRef<QueuedMessage[]>([]);
  queuedMessagesRef.current = queuedMessages;
  const [awaitingTurn, setAwaitingTurn] = useState<{ chat: string; generation: string; turnId: string | null; seq: number; agentMode: AgentMode }[]>([]);
  const draft = composer.text, attachments = composer.images;
  const composerRef = useRef(composer), currentChat = useRef(`${projectId}:${threadId}`);
  const fileInput = useRef<HTMLInputElement>(null), preparationVersion = useRef(0), alive = useRef(true), attachmentUpload = useRef<AbortController | null>(null);
  const queue = useRef<{ file: File; version: number; context: string; duplicate: string; limit: number }[]>([]), preparing = useRef(false);
  const [preparationCount, setPreparationCount] = useState(0);
  const [imageProgress, setImageProgress] = useState<Record<string, number>>({});
  const pendingSubmissions = useRef(new Map<string, { operationId: string; chat: string; unknown: boolean; sent: ComposerDraft; queued?: ComposerDraft; projectId: string; threadId: string }>());
  const checkingSubmission = useRef(false);
  const [failedChats, setFailedChats] = useState<Set<string>>(() => new Set());
  const attachmentContext = useRef("");
  currentChat.current = `${projectId}:${threadId}`;
  function changeDraft(next: ComposerDraft, releasePrevious = true) {
    if (releasePrevious) {
      const nextById = new Map(next.images.map(image => [image.id, image]));
      for (const previous of composerRef.current.images) {
        const current = nextById.get(previous.id);
        if (!current || current.previewUrl !== previous.previewUrl || !current.previewObjectUrl) releaseAttachmentPreview(previous);
      }
    }
    composerRef.current = next; setComposer(next);
  }
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
  const [inputHeight, setInputHeight] = useState(65);
  const resizing = useRef<{ pointer: number; y: number; height: number } | null>(null);
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
    return () => {
      active = false; alive.current = false; attachmentUpload.current?.abort(); attachmentUpload.current = null;
      ++preparationVersion.current; queue.current = [];
      const previews = new Map<string, Attachment>();
      for (const image of composerRef.current.images) previews.set(image.id, image);
      for (const chat of cache.current.values()) for (const image of chat.draft.images) previews.set(image.id, image);
      for (const queued of queuedMessagesRef.current) for (const image of queued.draft.images) previews.set(image.id, image);
      for (const pending of pendingSubmissions.current.values()) for (const image of pending.sent.images) previews.set(image.id, image);
      for (const image of previews.values()) releaseAttachmentPreview(image);
      cache.current.clear(); pendingSubmissions.current.clear(); composerRef.current = emptyDraft(); requests.clear(); stopMetadata(); stopLimits(); liveMetadata.current.clear(); client.dispose();
    };
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
    attachmentUpload.current?.abort(); attachmentUpload.current = null;
    cancelPreparation();
    if (threadId) {
      const key = `${projectId}:${threadId}`;
      cache.current.delete(key);
      cache.current.set(key, { snapshot, history, generation: historyGeneration, cursor, draft: composerRef.current, model, effort, permissionMode, agentMode, materials: materialView, ready: historyReady.current, uncertain: uncertain.current });
      if (cache.current.size > 8) {
        const oldest = [...cache.current.keys()].find(chat => ![...pendingSubmissions.current.values()].some(value => value.chat === chat));
        if (oldest) {
          const evicted = cache.current.get(oldest);
          if (evicted) for (const image of evicted.draft.images) releaseAttachmentPreview(image);
          cache.current.delete(oldest);
        }
      }
    }
    const saved = cache.current.get(`${id}:${chatId}`);
    historyReady.current = saved?.ready ?? false;
    const live = client.current(id, chatId);
    setSnapshot(live ?? saved?.snapshot ?? null); setHistory(saved?.history ?? []); setHistoryGeneration(saved?.generation ?? ""); setCursor(saved?.cursor ?? null);
    currentChat.current = `${id}:${chatId}`;
    uncertain.current = saved?.uncertain ?? false;
    changeDraft(saved?.draft ?? emptyDraft(), false); setModel(saved?.model ?? ""); setEffort(saved?.effort ?? ""); setPermissionMode(saved?.permissionMode ?? "auto"); setAgentMode(saved?.agentMode ?? "default"); setMaterialView(saved?.materials ?? emptyMaterialView()); setConnected(!!live);
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
      const removed = cache.current.get(key);
      if (removed) for (const image of removed.draft.images) releaseAttachmentPreview(image);
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

  function beginSubmission(sent: ComposerDraft, chat: string, queued?: ComposerDraft): string {
    const operationId = crypto.randomUUID();
    pendingSubmissions.current.set(operationId, { operationId, chat, unknown: false, sent, queued, projectId, threadId });
    setFailedChats(previous => new Set([...previous].filter(value => value !== chat)));
    followBottom.current = true;
    setCorrections(previous => [...previous, { chat, generation: snapshot!.generation,
      knownIds: mergeTimeline(history, snapshot!.items).map(item => item.id), state: "sending", draft: sent,
      item: { id: operationId, turnId: snapshot!.turn?.id ?? "", type: "userMessage", text: sent.text } }]);
    // Перед первым сетевым ожиданием передаём черновик сообщению; его previews ещё нужны.
    if (!queued) changeDraft(acceptedDraft(composerRef.current, sent), false);
    return operationId;
  }

  function finishSubmission(operationId: string) {
    const pending = pendingSubmissions.current.get(operationId);
    if (!pending) return;
    const chat = pending.chat;
    pendingSubmissions.current.delete(operationId);
    for (const image of pending.sent.images) releaseAttachmentPreview(image);
    const saved = cache.current.get(chat);
    const unresolved = [...pendingSubmissions.current.values()].some(value => value.chat === chat && value.unknown);
    if (saved) saved.uncertain = unresolved;
    if (currentChat.current === chat) uncertain.current = unresolved;
    setCorrections(previous => previous.filter(value => value.item.id !== pending.operationId));
    if (pending.queued) setQueuedMessages(previous => previous.filter(value => value.draft !== pending.queued));
  }

  function rejectSubmission(operationId: string) {
    const pending = pendingSubmissions.current.get(operationId);
    if (!pending) return;
    const chat = pending.chat;
    pendingSubmissions.current.delete(operationId);
    const saved = cache.current.get(chat);
    if (saved) { saved.draft = restoredDraft(saved.draft, pending.sent); saved.uncertain = false; }
    if (currentChat.current === chat) { changeDraft(restoredDraft(composerRef.current, pending.sent), false); uncertain.current = false; }
    setCorrections(previous => previous.filter(value => value.item.id !== pending.operationId));
    if (pending.queued) setQueuedMessages(previous => previous.filter(value => value.draft !== pending.queued));
    setFailedChats(previous => new Set([...previous, chat]));
  }

  async function checkSubmission(operationId: string): Promise<boolean> {
    const pending = pendingSubmissions.current.get(operationId);
    if (!pending || checkingSubmission.current) return false;
    checkingSubmission.current = true;
    const chatKey = pending.chat;
    try {
      // Чтение подтверждает точный persisted clientId, повторной отправки нет.
      const value = await client.request({ action: "items", projectId: pending.projectId, threadId: pending.threadId });
      let confirmed = confirmedSubmission(value.data, pending.operationId), cursor = value.nextCursor;
      const cursors = new Set<string>(), deadline = performance.now() + 8000;
      for (let page = 1; !confirmed && cursor && page < 100 && alive.current && performance.now() < deadline; page++) {
        if (cursors.has(cursor)) break;
        cursors.add(cursor);
        const older = await client.request({ action: "items", projectId: pending.projectId, threadId: pending.threadId, cursor });
        confirmed = confirmedSubmission(older.data, pending.operationId); cursor = older.nextCursor;
      }
      if (!alive.current || !confirmed) return false;
      if (currentChat.current === chatKey) {
        setHistory(previous => mergeTimeline(previous, value.data).slice(-1000));
        setHistoryGeneration(value.generation); setMessage("");
      }
      finishSubmission(operationId);
      return true;
    } catch { return false; }
    finally { checkingSubmission.current = false; }
  }

  async function mutate(action: "create" | "start" | "steer" | "interrupt" | "answer" | "goalSet" | "goalClear", extra: Record<string, unknown> = {}, targetProject = projectId, queuedDraft?: ComposerDraft, sentOverride?: ComposerDraft, submissionId?: string) {
    if (!targetProject || locked.current || uncertain.current || (action !== "create" && (!connected || !snapshot || snapshot.projectId !== projectId || snapshot.threadId !== threadId))) return false;
    const selected = snapshot, sent = sentOverride ?? queuedDraft ?? composerRef.current, sentChat = `${projectId}:${threadId}`, token = selection.current, operationId = submissionId ?? ((action === "start" || action === "steer") ? beginSubmission(sent, sentChat, queuedDraft) : crypto.randomUUID());
    locked.current = true; setBusy(true); setMessage("");
    try {
      const generation = action === "create" ? (await client.request({ action: "status" })).generation : selected!.generation;
      const value = await client.request({ action, projectId: targetProject, ...(action === "create" ? {} : { threadId }), generation, operationId, ...extra });
      if (value.outcome !== "accepted" || value.generation !== generation || (action === "create" ? typeof value.threadId !== "string" : value.threadId !== selected!.threadId) || value.operationId !== operationId || (action === "answer" && value.requestId !== extra.requestId)) throw new AgentError("BAD_REPLY", "unknown");
      if (!alive.current) return true;
      if (action === "start" || action === "steer") setCorrections(previous => previous.map(entry => entry.item.id === operationId ? { ...entry, state: "waiting", item: { ...entry.item, turnId: value.turnId ?? entry.item.turnId } } : entry));
      if (action === "start" && extra.agentMode === "goal") finishSubmission(operationId);
      if (action === "start" || (action === "goalSet" && extra.status === "active")) setAwaitingTurn(previous => [...previous.filter(value => value.chat !== sentChat), { chat: sentChat, generation, turnId: selected!.turn?.id ?? null, seq: selected!.seq, agentMode: action === "goalSet" ? "goal" : (extra.agentMode as AgentMode ?? "default") }]);
      if (action === "create" || action === "start") void loadThreads(targetProject);
      if (token !== selection.current) return true;
      if (action === "create") {
        const createdModel = typeof extra.model === "string" ? extra.model : "";
        cache.current.set(`${targetProject}:${value.threadId}`, { snapshot: null, history: [], generation, cursor: null, draft: emptyDraft(), model: createdModel, effort: createdModel === defaultModelId ? defaultEffort : "", permissionMode, agentMode, materials: emptyMaterialView(), ready: false, uncertain: false });
        selectChat(targetProject, value.threadId);
      }
      setMessage(""); return true;
    } catch (error) {
      if (!alive.current) return false;
      if (action === "start" || action === "steer") {
        if (error instanceof AgentError && error.outcome === "unknown") {
          if (!pendingSubmissions.current.has(operationId)) return true;
          pendingSubmissions.current.get(operationId)!.unknown = true;
          setCorrections(previous => previous.map(value => value.item.id === operationId ? { ...value, state: "unknown" } : value));
          const saved = cache.current.get(sentChat);
          if (saved) saved.uncertain = true;
          if (currentChat.current === sentChat) uncertain.current = true;
          if (await checkSubmission(operationId)) return true;
          return false;
        }
        rejectSubmission(operationId);
        return false;
      }
      setFailedChats(previous => new Set([...previous, sentChat]));
      if (token !== selection.current) return false;
      uncertain.current = error instanceof AgentError && error.outcome === "unknown";
      setMessage(errorText(error));
      return !queuedDraft && (uncertain.current || (error instanceof AgentError && error.code === "STALE_REQUEST"));
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }

  async function sendDraft(action: "start" | "steer", sent: ComposerDraft, targetProject: string, targetThread: string, settings: Record<string, unknown>, queuedDraft?: ComposerDraft): Promise<boolean> {
    if (locked.current || attachmentUpload.current || uncertain.current) return false;
    const chatKey = `${targetProject}:${targetThread}`, controller = new AbortController();
    const operationId = beginSubmission(sent, chatKey, queuedDraft);
    attachmentUpload.current = controller; setUploading(!!sent.images.length); setBusy(true); setMessage("");
    try {
      const readyImages: Attachment[] = [];
      for (const image of sent.images) {
        const ready = await uploadAttachment(image, { userId, projectId: targetProject, threadId: targetThread }, controller.signal, fetch, progress => {
          if (alive.current && !controller.signal.aborted) setImageProgress(previous => ({ ...previous, [image.id]: progress }));
        });
        readyImages.push({ ...image, originalArtifactId: ready.originalArtifactId, modelArtifactId: ready.modelArtifactId, url: ready.url, previewUrl: ready.url, previewObjectUrl: false });
      }
      if (!alive.current) return false;
      if (controller.signal.aborted) { rejectSubmission(operationId); return false; }
      if (currentChat.current !== chatKey) { rejectSubmission(operationId); return false; }
      const sentReady = { ...sent, images: readyImages };
      const attachments = readyImages.map(image => ({ originalArtifactId: image.originalArtifactId!, modelArtifactId: image.modelArtifactId! }));
      return await mutate(action, { text: sent.text, ...(attachments.length ? { attachments } : {}), ...settings }, targetProject, queuedDraft, sentReady, operationId);
    } catch (error) {
      if (alive.current) rejectSubmission(operationId);
      return false;
    } finally {
      if (attachmentUpload.current === controller) attachmentUpload.current = null;
      if (alive.current) setImageProgress(previous => Object.fromEntries(Object.entries(previous).filter(([id, progress]) => progress === 1)));
      setUploading(false);
      if (alive.current) setBusy(false);
    }
  }

  const view = snapshot?.projectId === projectId && snapshot?.threadId === threadId ? snapshot : null;
  const questionRequest = view?.requests.find(request => request.kind === "question" && !request.answered);
  const goalUnfinished = goalBlocksNewTask(view);
  const active = view?.turn?.status === "inProgress", disabled = busy || !view || !connected || uncertain.current;
  const project = projects.find(value => value.projectId === projectId);
  const selectedThread = pages[projectId]?.data.find(thread => thread.id === threadId) ?? view?.thread;
  const defaultModel = models?.data.find(value => value.model === defaultModelId) ?? models?.data.find(value => value.model === models.defaultModel) ?? models?.data[0];
  const selectedModel = models?.data.find(value => value.model === (model || view?.thread.model)) ?? defaultModel;
  const requestedEffort = effort || (selectedModel?.model === view?.thread.model ? view?.thread.reasoningEffort : null);
  const selectedEffort = selectedModel?.efforts.includes(requestedEffort ?? "") ? requestedEffort! : selectedModel?.model === defaultModelId && selectedModel.efforts.includes(defaultEffort) ? defaultEffort : selectedModel?.defaultEffort ?? "";
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
    for (const [operationId, pending] of pendingSubmissions.current) {
      if (pending.chat === currentChat.current && confirmedSubmission(items, operationId)) finishSubmission(operationId);
    }
  }, [items]);
  useEffect(() => {
    if (!corrections.some(value => value.state === "unknown")) return;
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped || checkingSubmission.current) return;
      const pending = corrections.find(value => value.state === "unknown" && pendingSubmissions.current.has(value.item.id));
      if (pending) void checkSubmission(pending.item.id);
    }, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [corrections, client]);
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
    const element = conversation.current;
    if (!element) return;
    let marker: HTMLElement | undefined;
    const key = `${projectId}:${threadId}`;
    const markRead = () => {
      if (!marker) return;
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
    const observer = new IntersectionObserver(markRead, { root: element, threshold: 0 });
    const findMarker = () => {
      const next = Array.from(element.querySelectorAll<HTMLElement>("[data-read-message]")).find(value => value.dataset.readMessage === messageId);
      if (next !== marker) { if (marker) observer.unobserve(marker); marker = next; if (marker) observer.observe(marker); }
      markRead();
    };
    // AIDEV-NOTE: Полное сообщение добавляет маркер после отдельного чтения, без нового snapshot.
    const changes = new MutationObserver(findMarker);
    changes.observe(element, { childList: true, subtree: true });
    const frame = requestAnimationFrame(findMarker);
    element?.addEventListener("scroll", markRead, { passive: true });
    document.addEventListener("visibilitychange", markRead);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); changes.disconnect(); element?.removeEventListener("scroll", markRead); document.removeEventListener("visibilitychange", markRead); };
  }, [visible, userId, projectId, threadId, readMessageId, readEpoch, active, history]);
  const pendingAsyncQuestions = view?.requests.filter(request => request.method === "agentMessage/questions" && !request.answered) ?? [];
  const timeline = groupTimeline(items).filter(entry => entry.kind !== "message" || !pendingAsyncQuestions.some(request => request.params.itemId === entry.item.id || entry.item.type === "agentMessage" && !entry.item.text.trim() && request.turnId === entry.item.turnId));
  const activityContext = useMemo(() => ({ generation: view?.generation ?? historyGeneration, epoch: view?.epoch ?? "", projectId, threadId }), [view?.generation, view?.epoch, historyGeneration, projectId, threadId]);
  const action = !draft.trim() && !attachments.length && goalUnfinished ? "goalClear" : composerAction(active, draft, attachments.length);
  const catalogFresh = !!view && models?.generation === view.generation;
  const imageError = attachments.length && !active && agentMode === "goal" ? "В режиме «Цель» отправьте описание задачи без изображений. Удалите вложения или выберите другой режим." : attachments.length && !imagesAllowed ? !catalogFresh ? "Дождитесь свежего каталога моделей и соединения с чатом." : "Эта модель не принимает изображения. Выберите другую модель или удалите вложения." : attachments.length > imageLimit ? `В этом чате можно прикрепить не более ${imageLimit} изображений. Удалите лишние вложения.` : "";
  const sendDisabled = disabled || uploading || (action === "goalClear" && view?.goal?.state !== "ready") || preparationCount > 0 || !!imageError || (action === "steer" && corrections.length >= 64) || (action !== "interrupt" && action !== "goalClear" && !catalogFresh) || (action === "start" && (goalUnfinished || (!draft.trim() && !attachments.length) || !selectedModel || view?.thread.canAcceptDirectInput === false || awaitingTurn.some(value => value.chat === currentChat.current)));
  const submit = () => {
    if (sendDisabled) return;
    if (action === "goalClear") void mutate("goalClear");
    else if (action === "interrupt") void mutate("interrupt", { turnId: view!.turn!.id });
    else void sendDraft(action, composerRef.current, projectId, threadId, action === "steer" ? { expectedTurnId: view!.turn!.id } : selectedModel ? { model: selectedModel.model, effort: selectedEffort, permissionMode, agentMode } : {});
  };

  function enqueueMessage() {
    if (agentMode === "goal" && composerRef.current.images.length) { setMessage("В режиме «Цель» сообщение в очереди должно содержать описание задачи без изображений. Вложения и текст сохранены."); return; }
    if (disabled || preparationCount || imageError || !catalogFresh || !selectedModel || (!draft.trim() && !attachments.length)) return;
    if (queuedMessages.length >= 16) { setMessage("Очередь заполнена. Дождитесь отправки или удалите сообщение."); return; }
    const sent = composerRef.current;
    setQueuedMessages(previous => [...previous, { id: crypto.randomUUID(), chat: currentChat.current, generation: view!.generation, draft: sent, model: selectedModel.model, effort: selectedEffort, permissionMode, agentMode, state: "waiting" }]);
    changeDraft(acceptedDraft(sent, sent), false);
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
    if (!next || next.state !== "waiting" || awaiting || disabled || locked.current || active || goalUnfinished || view.requests.some(request => request.kind !== "unsupported" && !request.answered) || !catalogFresh || view.thread.canAcceptDirectInput === false) return;
    const choice = models!.data.find(value => value.model === next.model);
    if (next.generation !== view.generation || !choice || !choice.efforts.includes(next.effort) || (next.draft.images.length && (next.agentMode === "goal" || !choice.inputModalities.includes("image") || next.draft.images.length > choice.imageLimit))) {
      setQueuedMessages(previous => previous.map(value => value.id === next.id ? { ...value, state: "failed" } : value));
      setMessage("Настройки сообщения в очереди устарели. Удалите его и отправьте заново.");
      return;
    }
    setQueuedMessages(previous => previous.map(value => value.id === next.id ? { ...value, state: "sending" } : value));
    // AIDEV-NOTE: Следующее сообщение ждёт нового native turn ID, а не только HTTP accepted со старым idle snapshot.
    void sendDraft("start", next.draft, projectId, threadId, { model: next.model, effort: next.effort, permissionMode: next.permissionMode, agentMode: next.agentMode }, next.draft).then(accepted => {
      if (!alive.current) return;
      if (accepted) for (const image of next.draft.images) releaseAttachmentPreview(image);
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
          else releaseAttachmentPreview(image);
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

  useEffect(() => {
    const element = conversation.current, timeline = element?.querySelector(".agent-timeline");
    if (!element || !timeline || !visible) return;
    const observer = new ResizeObserver(() => { if (followBottom.current) element.scrollTop = element.scrollHeight; });
    observer.observe(timeline);
    return () => observer.disconnect();
  }, [visible, threadId]);

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

  return <main className="agent-shell bg-background text-foreground">
    <Sidebar readMessages={readMessages} projects={projects} pages={pages} projectId={projectId} threadId={threadId} open={sidebarOpen} email={email} busy={busy || uncertain.current} accountLimits={accountLimits}
      select={selectChat} create={id => { void mutate("create", defaultModel ? { model: defaultModel.model, permissionMode } : { permissionMode }, id); }} more={id => { const next = pages[id]?.nextCursor; if (next) void loadThreads(id, next); }}
      archive={(id, chatId) => { void archiveChat(id, chatId); }} refresh={id => { void loadThreads(id); }} close={() => setSidebarOpen(false)} logout={onLogout} />
    <section className="agent-workspace" aria-labelledby="agent-chat-title">
      <header className="agent-toolbar border-b border-border bg-background">
        <Button type="button" variant="ghost" className="agent-mobile-toggle" aria-controls="agent-sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(value => !value)}>☰ <span>Чаты</span></Button>
        <div className="agent-heading"><p>{project?.name ?? "Агент"}</p><h1 id="agent-chat-title" title={title}>{title}</h1></div>
        {materials.length > 0 && <Button type="button" variant={materialView.open ? "secondary" : "outline"} size="sm" className="agent-materials-toggle" aria-expanded={materialView.open} onClick={() => chooseMaterial(materialView.selected || materials.at(-1)!.id)}>Материалы{materialView.updated.length > 0 ? " · обновлено" : ""}</Button>}
        <Badge variant="outline" className="agent-chat-status" role="status">{view && connected ? view.goal?.state === "ready" && view.goal.value?.status === "active" ? "Достигает цели" : stateLabels[view.state] ?? "Состояние обновляется" : view ? "Переподключение…" : threadId ? "Подключаемся…" : "Готов к выбору"}</Badge>
      </header>
      <div ref={conversation} className="agent-conversation" aria-label="История" onScroll={event => {
        const element = event.currentTarget;
        followBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 1;
      }}>
        {!threadId && <div className="agent-empty"><Card className="agent-empty-card"><span className="agent-empty-symbol" aria-hidden="true">✳</span><h2>С чего начнём?</h2><p>Выберите чат слева или создайте новый в нужном проекте.</p>{project && <Button type="button" className="agent-primary" disabled={busy || uncertain.current} onClick={() => void mutate("create", defaultModel ? { model: defaultModel.model, permissionMode } : { permissionMode })}>Новый чат · {project.name}</Button>}</Card></div>}
        <div className="agent-timeline">
          {cursor && <Button type="button" variant="outline" className="agent-history-more" onClick={() => void moreHistory()}>Загрузить предыдущие сообщения</Button>}
          {timeline.map(entry => entry.kind === "message" ? entry.item.type === "plan" ? <Button key={entry.item.id} type="button" variant="outline" className="agent-material-card" onClick={() => chooseMaterial(`plan:${entry.item.id}`)}>Предложенный план <span>{materialView.updated.includes(`plan:${entry.item.id}`) ? "Обновлено · " : ""}Открыть →</span></Button> : <Item key={`${activityContext.generation}:${activityContext.epoch}:${projectId}:${threadId}:${entry.item.id}`} item={entry.item} context={activityContext} reads={lazyReads} /> : <Activities key={`${activityContext.generation}:${activityContext.epoch}:${projectId}:${threadId}:${entry.id}`} items={entry.items} context={activityContext} reads={lazyReads} />)}
          {materials.filter(value => value.kind !== "plan").map(value => <Button key={value.id} type="button" variant="outline" className="agent-material-card" onClick={() => chooseMaterial(value.id)}>{value.title}<span>{materialView.updated.includes(value.id) ? "Обновлено · " : ""}Открыть →</span></Button>)}
          {pendingCorrections.map(value => <Item key={value.item.id} item={value.item} context={activityContext} reads={lazyReads} pending={value.state} localImages={value.draft?.images} imageProgress={imageProgress} />)}
        {queuedMessages.some(value => value.chat === currentChat.current) && <ul className="agent-message-queue" aria-label="Очередь сообщений">{queuedMessages.filter(value => value.chat === currentChat.current).map(value => <li key={value.id}>
          <span>{value.draft.text || "Изображения"}{!!value.draft.images.length && ` · Изображений: ${value.draft.images.length}`} · {value.agentMode === "plan" ? "Планирование" : value.agentMode === "goal" ? "Цель" : "Обычный"} · {value.state === "sending" ? "Отправляется" : value.state === "unknown" ? "Результат неизвестен — проверьте чат" : value.state === "failed" ? "Не отправлено — очередь остановлена" : "В очереди"}</span>
          <button type="button" disabled={value.state === "sending"} onClick={() => { const removed = queuedMessages.find(item => item.id === value.id); if (removed) for (const image of removed.draft.images) releaseAttachmentPreview(image); setQueuedMessages(previous => previous.filter(item => item.id !== value.id)); }} aria-label="Удалить сообщение из очереди">×</button>
        </li>)}</ul>}
          {view?.turn?.error && <TurnErrorNotice error={view.turn.error} />}
          {view?.requests.filter(request => request.kind !== "question").map(request => (connected || request.kind === "unsupported") && <NativeForm key={view.generation + ":" + view.epoch + ":" + request.requestId} request={request} disabled={disabled} send={answer => mutate("answer", { requestId: request.requestId, answer })} />)}
        </div>
      </div>
      {(threadId || message || accountMessage) && <footer className="agent-composer-area">
        {questionRequest && <QuestionCard key={`${projectId}:${threadId}:${view!.generation}:${view!.epoch}:${questionRequest.requestId}`} request={questionRequest} disabled={disabled} send={answer => mutate("answer", { requestId: questionRequest.requestId, answer })} />}
        {threadId && <Card className="agent-composer-card"><form className="agent-composer" onSubmit={event => { event.preventDefault(); submit(); }}>
          <label className="sr-only" htmlFor="agent-draft">{active ? "Дополнить текущий ход" : "Сообщение"}</label>
          {!!attachments.length && <ul className="agent-attachments" aria-label="Прикреплённые изображения">{attachments.map(image => <li key={image.id}><div className="agent-attachment-preview"><img src={image.url ?? image.previewUrl} alt={image.name} /><ImageUploadStatus progress={imageProgress[image.id]} /></div><span className="agent-attachment-name" title={image.name}>{image.name}</span>{image.reduced && <span className="agent-image-reduced">Уменьшено</span>}<button type="button" className="agent-attachment-remove" aria-label={`Удалить ${image.name}`} onClick={() => { attachmentUpload.current?.abort(); attachmentUpload.current = null; changeDraft({ ...composerRef.current, images: composerRef.current.images.filter(value => value.id !== image.id) }); }}>×</button></li>)}</ul>}
          <div className="agent-composer-input">
          <Textarea bare className="agent-draft-input" ref={composerInput} id="agent-draft" style={{ height: inputHeight }} placeholder={active ? "Дополнить текущее задание…" : agentMode === "goal" ? "Какой цели нужно достичь?" : agentMode === "plan" ? "Что нужно спланировать?" : "Что нужно сделать?"} value={draft} onChange={event => changeDraft({ ...composerRef.current, text: event.target.value, revision: composerRef.current.revision + 1 })} onPaste={event => {
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
          <Button type="button" variant="ghost" className="agent-input-resize" aria-label="Изменить высоту поля ввода" title="Потяните вверх, чтобы увеличить поле" tabIndex={-1}
            onPointerDown={event => {
              if (!event.isPrimary || event.button !== 0) return;
              event.preventDefault();
              resizing.current = { pointer: event.pointerId, y: event.clientY, height: composerInput.current?.getBoundingClientRect().height ?? inputHeight };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => {
              const start = resizing.current;
              if (start?.pointer === event.pointerId) setInputHeight(Math.max(65, Math.min(180, start.height - (event.clientY - start.y))));
            }}
            onPointerUp={event => {
              if (resizing.current?.pointer !== event.pointerId) return;
              resizing.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => { resizing.current = null; }} onLostPointerCapture={() => { resizing.current = null; }}><ComposerIcon kind="resize" /></Button>
          </div>
          <div className="agent-composer-actions">
          <div className="agent-composer-tools">
          <input ref={fileInput} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" onChange={event => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
          <Button type="button" variant="outline" size="icon-sm" className="agent-composer-icon" aria-label="Прикрепить изображения" title={imagesAllowed ? "Прикрепить PNG, JPEG или WebP" : !active && agentMode === "goal" ? "В режиме «Цель» изображения недоступны" : "Текущая модель не принимает изображения"} disabled={disabled || !imagesAllowed || attachments.length + preparationCount >= imageLimit} onClick={() => fileInput.current?.click()}><ComposerIcon kind="plus" /></Button>
          {/* Настройки относятся к следующему start или очереди; steer сохраняет настройки активного хода. */}
          <AgentModeButton mode={agentMode} disabled={disabled} choose={value => { cancelPreparation(); setAgentMode(value); }} />
          <ModelSettings key={`settings:${projectId}:${threadId}`} contextUsage={connected && view?.state !== "connection-lost" && view?.state !== "executor-unavailable" ? view?.contextUsage : null} models={models?.data ?? []} model={selectedModel?.model ?? ""} effort={selectedEffort} permissionMode={permissionMode} choosePermissions={setPermissionMode} disabled={busy || uncertain.current || (!!threadId && !connected)} chooseModel={value => { cancelPreparation(); setModel(value); setEffort(value === defaultModelId ? defaultEffort : ""); }} chooseEffort={setEffort} />
          </div>
          <Button type="submit" size="icon" className={`agent-send${failedChats.has(currentChat.current) || imageError ? " is-failed" : ""}`} disabled={sendDisabled} aria-label={action === "interrupt" || action === "goalClear" ? "Стоп" : action === "steer" ? "Скорректировать" : "Отправить"} title={action === "interrupt" || action === "goalClear" ? "Стоп" : action === "steer" ? "Скорректировать" : "Отправить"}><ComposerIcon kind={action === "interrupt" || action === "goalClear" ? "stop" : "send"} /></Button>
          </div>
        </form></Card>}
      </footer>}
    </section>
    {materialView.open && <Materials focus={materialView.focus} materials={materials} selected={materialView.selected} choose={chooseMaterial} close={() => setMaterialView(previous => ({ ...previous, open: false }))} disabled={disabled || !catalogFresh || awaitingTurn.some(value => value.chat === currentChat.current)} active={!!active || goalUnfinished} connected={connected} execute={item => { void executePlan(item); }} revise={revisePlan} goal={action => { void mutate(action === "stop" ? "goalClear" : "goalSet", action === "stop" ? {} : { status: action === "pause" ? "paused" : "active" }); }} />}
  </main>;
}

/** Сообщения используют безопасный Markdown; тела действий принадлежат отдельному ленивому списку. */
function Item({ item, context, reads, pending, localImages, imageProgress }: { item: DisplayItem; context: Parameters<typeof MessageImages>[0]["context"]; reads: Parameters<typeof MessageImages>[0]["reads"]; pending?: PendingCorrection["state"]; localImages?: Attachment[]; imageProgress?: Record<string, number> }) {
  const content = <>
    <span className="agent-message-author">{item.type === "userMessage" ? "Вы" : "Brai"}{item.phase && <span className="agent-message-phase">{item.phase === "final_answer" ? "Итог" : item.phase === "commentary" ? "Промежуточное сообщение" : item.phase}</span>}</span>
    {pending && <span className="agent-correction-status" role="status">{pending === "waiting" ? "Отправлено" : "Отправляется…"}</span>}
    <MessageText key={JSON.stringify([item.revision, item.text, item.truncated])} item={item} context={context} reads={reads} />
    {!!localImages?.length && <ul className="agent-message-thumbnails" aria-label="Изображения сообщения">{localImages.map(image => <li key={image.id} className="agent-attachment-preview"><img src={image.url ?? image.previewUrl} alt={image.name} /><ImageUploadStatus progress={imageProgress?.[image.id]} /></li>)}</ul>}
    {!localImages && !!item.imageCount && <MessageImages item={item} context={context} reads={reads} />}
  </>;
  return <article data-item-id={item.id} className={`agent-item ${item.type === "userMessage" ? "agent-user-message-container" : "agent-assistant-message"}`}>
    {item.type === "userMessage" ? <Card className="agent-user-message">{content}</Card> : content}
  </article>;
}

function updateThreadPage(pages: Record<string, ThreadPage>, projectId: string, thread: ThreadMetadata): Record<string, ThreadPage> {
  const page = pages[projectId], found = page?.data.some(value => value.id === thread.id);
  const data = found ? page.data.map(value => value.id === thread.id ? mergeThreadMetadata(value, thread) : value) : [thread, ...(page?.data ?? [])].slice(0, 1000);
  return { ...pages, [projectId]: { data, nextCursor: page?.nextCursor ?? null, loading: page?.loading ?? false, error: page?.error ?? "" } };
}
