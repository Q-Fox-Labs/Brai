"use client";
// ABOUTME: Показывает администраторам DEV все переписки с агентом в привычной оболочке.
// ABOUTME: Опрос читает Hermes через административный API и не отправляет сообщения пользователям.
import { useEffect, useRef, useState } from "react";
import WorkspaceFrame from "../shell/workspace-frame";
import TelegramRichMessage from "./telegram-rich";
import { AdminChatError, chatParticipant, adminChatKey, latestAdminChat, loadAdminChats, mergeAdminMessages, readAdminChat, selectedChatUnavailable, type AdminChat, type ChatMessage, type ChatOwner } from "./admin-chat-client";
import "./telegram-observer.css";

type History = { key: string; messages: ChatMessage[]; cursor: string | null; updatesCursor?: string };
const emptyHistory = (key = ""): History => ({ key, messages: [], cursor: null });
function time(value: string) {
  return Number.isNaN(Date.parse(value)) ? "" : new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
function title(chat: AdminChat) { return chat.title || chatParticipant(chat) || "Чат Telegram"; }
/** Миниатюра хранится у Brai; браузер не обращается к Telegram. */
function ParticipantAvatar({ chat }: { chat: AdminChat }) {
  const avatar = chat.participant?.avatar;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatar]);
  return <span className="tg-avatar" aria-hidden="true">{avatar && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(avatar) && !failed
    ? <img src={avatar} alt="" width={40} height={40} loading="lazy" onError={() => setFailed(true)} />
    : Array.from(chat.participant?.name || chat.participant?.username || chat.owner.name || "П")[0]}</span>;
}

/** Показывает фактический text/caption Telegram без Markdown и преобразований строки. */
export function AdminMessageBody({ message, owner }: { message: ChatMessage; owner: string }) {
  const files = message.attachments ?? [], asDocument = message.messageType === "document";
  const fileUrl = (id: string, preview = false) => "/api/admin?" + new URLSearchParams({
    operation: "admin-artifacts-download", userId: owner, artifactId: id, ...(preview ? { preview: "1" } : {})
  });
  return <>{message.richMessage ? <TelegramRichMessage value={message.richMessage} hasAttachments={files.length > 0} /> : message.text.length > 0 && <div className="tg-text">{message.text}</div>}
    {files.length > 0 && <div className="tg-attachments">{files.map(file => <figure key={file.artifactId}>
      {!asDocument && file.mimeType.startsWith("image/") && <a href={fileUrl(file.artifactId, true)} target="_blank" rel="noopener noreferrer"><img src={fileUrl(file.artifactId, true)} alt={file.filename} loading="lazy" /></a>}
      {!asDocument && file.mimeType.startsWith("audio/") && <audio controls preload="none" src={fileUrl(file.artifactId, true)} />}
      {!asDocument && file.mimeType.startsWith("video/") && <video controls preload="metadata" src={fileUrl(file.artifactId, true)} />}
      {(asDocument || !file.mimeType.startsWith("image/") && !file.mimeType.startsWith("audio/")) && <figcaption><a href={fileUrl(file.artifactId)} download>{file.filename}</a></figcaption>}
    </figure>)}</div>}
    {!files.length && message.attachmentState === "pending" && <p className="tg-muted">Вложение пока недоступно.</p>}
  </>;
}

/** Сохраняет историю и прокрутку; скрытый раздел не опрашивает сервер, потеря прав очищает экран. */
export default function AdminChats({ userId, active, onUnauthorized }: { userId: string; active: boolean; onUnauthorized: () => void }) {
  const [chats, setChats] = useState<AdminChat[]>([]), [selected, setSelected] = useState<AdminChat | null>(null);
  const [unavailable, setUnavailable] = useState<ChatOwner[]>([]);
  const [history, setHistory] = useState<History>(emptyHistory);
  const [listError, setListError] = useState(""), [messageError, setMessageError] = useState(""), [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(false), [connected, setConnected] = useState(false), [newCount, setNewCount] = useState(0);
  const [visible, setVisible] = useState(true);
  const chatsRef = useRef(chats), historyRef = useRef(history), scroll = useRef<HTMLDivElement>(null), follow = useRef(true);
  const olderRequest = useRef<AbortController | null>(null), olderBusy = useRef(false), deniedRef = useRef(false);
  const unauthorized = useRef(onUnauthorized); unauthorized.current = onUnauthorized;
  chatsRef.current = chats;
  const selectedKey = selected ? adminChatKey(selected) : "";
  const shown = history.key === selectedKey ? history : emptyHistory(selectedKey);
  const running = active && visible && !denied;
  const saveHistory = (value: History) => { historyRef.current = value; setHistory(value); };
  const reject = (error: unknown) => {
    if (!(error instanceof AdminChatError) || ![401, 403].includes(error.status)) return false;
    deniedRef.current = true; setDenied(true); setChats([]); setUnavailable([]); saveHistory(emptyHistory()); setSelected(null);
    if (error.status === 401) unauthorized.current();
    return true;
  };
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    update(); document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await loadAdminChats(chatsRef.current, controller.signal);
        if (controller.signal.aborted || deniedRef.current) return;
        setChats(value.chats);
        setUnavailable(value.unavailable); setListError("");
        setSelected(current => current ? value.chats.find(chat => adminChatKey(chat) === adminChatKey(current)) ?? null : value.chats[0] ?? null);
      } catch (error) { if (!controller.signal.aborted && !reject(error)) setListError("Не удалось обновить список чатов. Повторяем подключение."); }
      finally { if (!controller.signal.aborted && !deniedRef.current) timer = setTimeout(() => { void refresh(); }, 10000); }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [running]);

  useEffect(() => {
    olderRequest.current?.abort(); olderBusy.current = false;
    saveHistory(emptyHistory(selectedKey)); setNewCount(0); setMessageError(""); setConnected(false); follow.current = true;
  }, [selectedKey]);
  useEffect(() => {
    if (!running || !selected) return;
    const chat = selected, controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    setLoading(!historyRef.current.messages.length);
    const refresh = async () => {
      try {
        const previous = historyRef.current;
        const page = await latestAdminChat(chat, previous.messages.at(-1)?.id, controller.signal, previous.updatesCursor);
        if (controller.signal.aborted || deniedRef.current) return;
        const current = historyRef.current;
        if (!follow.current) setNewCount(count => count + page.messages.filter(message => !message.deleted && (message.text.length > 0 || !!message.richMessage || !!message.attachments?.length || message.attachmentState === "pending") && !current.messages.some(old => old.id === message.id)).length);
        saveHistory({ key: selectedKey, messages: mergeAdminMessages(current.messages, page.messages), cursor: current.messages.length ? current.cursor : page.nextCursor, updatesCursor: page.updatesCursor ?? current.updatesCursor });
        setMessageError(""); setConnected(true);
      } catch (error) {
        if (!controller.signal.aborted) { setConnected(false); if (!reject(error)) setMessageError("Не удалось обновить переписку. Повторяем подключение."); }
      } finally { if (!controller.signal.aborted && !deniedRef.current) { setLoading(false); timer = setTimeout(() => { void refresh(); }, 3000); } }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); olderRequest.current?.abort(); olderBusy.current = false; };
  }, [running, selectedKey]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [history]);
  const older = async () => {
    if (!selected || !shown.cursor || olderBusy.current) return;
    const controller = new AbortController(); olderRequest.current = controller; olderBusy.current = true; setLoading(true);
    const container = scroll.current, height = container?.scrollHeight ?? 0;
    try {
      const page = await readAdminChat(selected, controller.signal, shown.cursor);
      if (controller.signal.aborted || deniedRef.current) return;
      follow.current = false;
      saveHistory({ key: selectedKey, messages: mergeAdminMessages(historyRef.current.messages, page.messages), cursor: page.nextCursor, updatesCursor: historyRef.current.updatesCursor });
      setMessageError("");
      requestAnimationFrame(() => { if (container && !controller.signal.aborted) container.scrollTop += container.scrollHeight - height; });
    } catch (error) { if (!controller.signal.aborted && !reject(error)) setMessageError("Не удалось загрузить более ранние сообщения. Попробуйте ещё раз."); }
    finally { if (!controller.signal.aborted) { olderBusy.current = false; setLoading(false); } }
  };
  return <WorkspaceFrame section="agent" userId={userId} title={selected ? title(selected) : "Агент"} railTitle="Чаты" rail={<aside className="tg-sidebar" aria-label="Список чатов">
    <header className="tg-sidebar-head"><h1>Чаты</h1><span className="tg-live" data-state={connected ? "live" : "loading"}><i />{connected ? "В эфире" : "Подключение"}</span></header>
    <p className="tg-subtitle">Все пользователи · только просмотр</p>
    <div className="tg-chat-list">{chats.map(chat => <button type="button" className="tg-chat" data-frame-close-rail data-selected={selectedKey === adminChatKey(chat)} key={adminChatKey(chat)} onClick={() => setSelected(chat)}>
      <ParticipantAvatar chat={chat} /><span className="tg-chat-copy"><strong>{title(chat)}</strong><span>{chatParticipant(chat)} · {time(chat.updatedAt)}</span></span>
    </button>)}{unavailable.map(owner => <p className="tg-error" role="status" key={owner.id}>{owner.name || owner.telegramId || owner.id}: источник чатов недоступен. Повторяем подключение.</p>)}{listError && <p className="tg-error" role="status">{listError}</p>}{!chats.length && !unavailable.length && !listError && !denied && <p className="tg-empty-list">Чаты появятся здесь после первого сообщения.</p>}</div>
  </aside>}>
    <section className="tg-main" aria-label="Переписка"><header className="tg-header">{selected && <ParticipantAvatar chat={selected} />}<div><strong>{selected ? title(selected) : "Переписка"}</strong><span>{selected ? chatParticipant(selected) + " · " : ""}Только просмотр</span></div></header>
      {(messageError || denied || selectedChatUnavailable(selected, unavailable)) && <p className="tg-error" role="status">{denied ? "Сервер отклонил доступ к чатам. Обновите страницу; если ошибка повторится, проверьте доступ к разделу." : messageError || "Источник чатов выбранного профиля недоступен. Повторяем подключение."}</p>}
      <div ref={scroll} className="tg-conversation" onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; if (follow.current) setNewCount(0); }}>
        {!selected ? <div className="tg-empty"><h2>Выберите чат</h2><p>Здесь появятся переписки с агентом.</p></div> : <div className="tg-timeline">
          {shown.cursor && <button type="button" className="tg-older" disabled={loading} onClick={() => { void older(); }}>Показать более ранние</button>}
          {loading && !shown.messages.length && <p className="tg-muted" role="status">Загружаем сообщения…</p>}
          {!loading && !shown.messages.length && <p className="tg-muted" role="status">Точная копия прежней переписки отсутствует. Новые сообщения появятся здесь автоматически. Ранее сохранённые файлы доступны в <a href="/admin">Админке</a>.</p>}
          {shown.messages.filter(message => !message.deleted && (message.text.length > 0 || !!message.richMessage || !!message.attachments?.length || message.attachmentState === "pending")).map(message => <article className="tg-message" data-direction={message.role === "user" ? "in" : "out"} key={message.id}>
            <div className="tg-message-meta"><strong>{message.role === "assistant" ? "Brai" : [message.authorName, message.authorUsername ? "@" + message.authorUsername : ""].filter(Boolean).join(" · ") || chatParticipant(selected)}</strong><time>{time(message.createdAt)}</time></div><AdminMessageBody message={message} owner={selected.owner.id} />
          </article>)}
        </div>}
      </div>
      {newCount > 0 && <button type="button" className="tg-new" onClick={() => { follow.current = true; setNewCount(0); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}>Новые сообщения: {newCount} ↓</button>}
    </section>
  </WorkspaceFrame>;
}
