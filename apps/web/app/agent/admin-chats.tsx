"use client";
// ABOUTME: Показывает администраторам DEV все переписки с агентом в привычной оболочке.
// ABOUTME: Опрос читает Hermes через административный API и не отправляет сообщения пользователям.
import { useEffect, useRef, useState } from "react";
import WorkspaceFrame from "../shell/workspace-frame";
import Markdown from "./markdown";
import { AdminChatError, chatParticipant, adminChatKey, latestAdminChat, loadAdminChats, mergeAdminMessages, readAdminChat, type AdminChat, type ChatMessage } from "./admin-chat-client";
import { adminChatDisplayText } from "./admin-chat-display";
import "./telegram-observer.css";

type History = { key: string; messages: ChatMessage[]; cursor: string | null };
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

/** Показывает опубликованные файлы через повторную проверку владельца и MIME на сервере. */
export function AdminMessageBody({ message, owner }: { message: ChatMessage; owner: string }) {
  message = { ...message, text: adminChatDisplayText(message.text, message.role) };
  const files: { id: string; label: string; name: string; url: string }[] = [];
  const text = message.text.replace(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)|(?<![\\!])!?\[([^\]\n]*)\]\(<?\/(?:[^<>\n)]*\/)?(?:results|artifacts)\/([0-9a-f-]{36})\/([^<>\n)]+)>?\)/gi, (match, code: string | undefined, label: string, id: string, name: string) => {
    if (code) return match;
    const url = "/api/admin?" + new URLSearchParams({ operation: "admin-artifacts-download", userId: owner, artifactId: id });
    if (!files.some(file => file.id === id)) files.push({ id, label: label || name, name, url });
    return "";
  });
  return <>{text.trim() && <Markdown text={text} />}{files.length > 0 && <div className="tg-attachments">{files.map(file => <figure key={file.id}>
    {/\.(?:png|jpe?g|webp|gif)$/i.test(file.name) && <a href={file.url} download><img src={file.url + "&preview=1"} alt={file.label} loading="lazy" /></a>}
    {/\.(?:ogg|opus|mp3|m4a|wav|webm)$/i.test(file.name) && <audio controls preload="none" src={file.url + "&preview=1"} />}
    {/\.mp4$/i.test(file.name) && <video controls preload="metadata" src={file.url + "&preview=1"} />}
    <figcaption><a href={file.url} download>{file.label}</a></figcaption>
  </figure>)}</div>}</>;
}

/** Сохраняет историю и прокрутку; скрытый раздел не опрашивает сервер, потеря прав очищает экран. */
export default function AdminChats({ userId, active, onUnauthorized }: { userId: string; active: boolean; onUnauthorized: () => void }) {
  const [chats, setChats] = useState<AdminChat[]>([]), [selected, setSelected] = useState<AdminChat | null>(null);
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
    deniedRef.current = true; setDenied(true); setChats([]); saveHistory(emptyHistory()); setSelected(null);
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
        setListError(value.unavailable.length ? "Не удалось обновить: " + value.unavailable.join(", ") + ". Повторяем подключение." : "");
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
        const page = await latestAdminChat(chat, previous.messages.at(-1)?.id, controller.signal);
        if (controller.signal.aborted || deniedRef.current) return;
        const current = historyRef.current;
        if (!follow.current) setNewCount(count => count + page.messages.filter(message => adminChatDisplayText(message.text, message.role).trim() && !current.messages.some(old => old.id === message.id)).length);
        saveHistory({ key: selectedKey, messages: mergeAdminMessages(current.messages, page.messages), cursor: current.messages.length ? current.cursor : page.nextCursor });
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
      saveHistory({ key: selectedKey, messages: mergeAdminMessages(historyRef.current.messages, page.messages), cursor: page.nextCursor });
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
    </button>)}{!chats.length && !listError && !denied && <p className="tg-empty-list">Чаты появятся здесь после первого сообщения.</p>}</div>
  </aside>}>
    <section className="tg-main" aria-label="Переписка"><header className="tg-header">{selected && <ParticipantAvatar chat={selected} />}<div><strong>{selected ? title(selected) : "Переписка"}</strong><span>{selected ? chatParticipant(selected) + " · " : ""}Только просмотр</span></div></header>
      {(listError || messageError || denied) && <p className="tg-error" role="status">{denied ? "Сервер отклонил доступ к чатам. Обновите страницу; если ошибка повторится, проверьте доступ к разделу." : messageError || listError}</p>}
      <div ref={scroll} className="tg-conversation" onScroll={event => { const el = event.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; if (follow.current) setNewCount(0); }}>
        {!selected ? <div className="tg-empty"><h2>Выберите чат</h2><p>Здесь появятся переписки с агентом.</p></div> : <div className="tg-timeline">
          {shown.cursor && <button type="button" className="tg-older" disabled={loading} onClick={() => { void older(); }}>Показать более ранние</button>}
          {loading && !shown.messages.length && <p className="tg-muted" role="status">Загружаем сообщения…</p>}
          {shown.messages.filter(message => adminChatDisplayText(message.text, message.role).trim()).map(message => <article className="tg-message" data-direction={message.role === "user" ? "in" : "out"} key={message.id}>
            <div className="tg-message-meta"><strong>{message.role === "assistant" ? "Brai" : chatParticipant(selected)}</strong><time>{time(message.createdAt)}</time></div><AdminMessageBody message={message} owner={selected.owner.id} />
          </article>)}
        </div>}
      </div>
      {newCount > 0 && <button type="button" className="tg-new" onClick={() => { follow.current = true; setNewCount(0); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}>Новые сообщения: {newCount} ↓</button>}
    </section>
  </WorkspaceFrame>;
}
