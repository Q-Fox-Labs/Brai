"use client";
// ABOUTME: Показывает Telegram-чаты Brai и их сообщения в режиме наблюдения.
// ABOUTME: Не отправляет сообщения, решения или команды агенту.
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "./markdown";
import { telegramText, updateTelegramMessage } from "./telegram-display";
import "./telegram-observer.css";

type Chat = { chat_id: string; thread_id: string; chat_type: string; chat_name: string | null; last_text: string; last_at: string | null; last_row: number };
type Attachment = { artifactId: string; filename: string; mimeType: string; sizeBytes?: number; width?: number; height?: number };
type Message = { row_id: number; identity: string; chat_id: string; thread_id: string; telegram_id?: string | null; author_name: string; direction: "in" | "out";
  text: string; occurred_at: string | null; edited_at: string | null; delivery: string; attachment_state: string; attachments: Attachment[] };
type Page = { messages: Message[]; before: number | null };
const keyOf = (chat: Pick<Chat, "chat_id" | "thread_id">) => `${chat.chat_id}:${chat.thread_id}`;
const compareMessages = (a: Message, b: Message) => {
  const left = a.occurred_at ?? "", right = b.occurred_at ?? "";
  return left === right ? a.row_id - b.row_id : left < right ? -1 : 1;
};

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/telegram-observer/${path}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error("UNAVAILABLE");
  return response.json() as Promise<T>;
}
function chatName(chat: Chat) { return chat.chat_name || (chat.chat_id.startsWith("-") ? "Группа Telegram" : "Неизвестный чат"); }
function time(value: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
function fileUrl(message: Message, item: Attachment, download = false) {
  const params = new URLSearchParams({ message: message.identity });
  if (download) params.set("download", "1");
  return `/api/telegram-observer/files/${encodeURIComponent(item.artifactId)}?${params}`;
}

function TelegramAttachment({ message, item }: { message: Message; item: Attachment }) {
  const [imageState, setImageState] = useState<"loading" | "loaded" | "failed">("loading");
  const ratio = item.width && item.height && item.width > 0 && item.height > 0 ? `${item.width} / ${item.height}` : undefined;
  return <figure>
    {item.mimeType.startsWith("image/") && <a className="tg-image-preview" data-state={imageState} style={ratio ? { aspectRatio: ratio } : undefined}
      href={fileUrl(message, item)} target="_blank" rel="noopener noreferrer" aria-label={imageState === "failed" ? "Изображение недоступно" : "Открыть изображение"}>
      {imageState !== "loaded" && <span className="tg-image-placeholder" role="status">{imageState === "failed" ? "Изображение недоступно" : "Загрузка изображения…"}</span>}
      {imageState !== "failed" && <img src={fileUrl(message, item)} alt={item.filename || "Изображение"} loading="lazy" onLoad={() => setImageState("loaded")} onError={() => setImageState("failed")} />}
    </a>}
    {item.mimeType.startsWith("audio/") && <audio controls preload="none" src={fileUrl(message, item)} />}
    {item.mimeType.startsWith("video/") && <video controls preload="metadata" src={fileUrl(message, item)} />}
    {!item.mimeType.startsWith("image/") && !item.mimeType.startsWith("audio/") && <figcaption><a href={fileUrl(message, item, true)} download={item.filename}>{item.filename || "Скачать файл"}</a></figcaption>}
  </figure>;
}

/** Сохраняет прежнюю плашку там, где журнал наблюдения ещё не включён. */
export default function TelegramAgentEntry({ username, active = true, enabled = false }: { username: string | null; active?: boolean; enabled?: boolean }) {
  if (!enabled) return <main className="mx-auto flex h-full w-full max-w-3xl items-center justify-center p-6 sm:p-10">
    <section className="w-full rounded-2xl border bg-card p-8 text-card-foreground shadow-sm sm:p-10">
      <p className="text-sm font-medium text-muted-foreground">Brai Agent</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Продолжайте в Telegram</h1>
      <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">Откройте рабочий чат Brai в Telegram и отправьте сообщение боту{username ? ` @${username}` : ""}. Hermes продолжит разговор в этом чате.</p>
    </section>
  </main>;
  return <TelegramObserver username={username} active={active} />;
}

/** Показывает список бесед и актуальную переписку без возможности отправки. */
function TelegramObserver({ username, active }: { username: string | null; active: boolean }) {
  const [chats, setChats] = useState<Chat[]>([]), [selected, setSelected] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]), [before, setBefore] = useState<number | null>(null);
  const [connection, setConnection] = useState<"loading" | "live" | "reconnecting">("loading");
  const [error, setError] = useState(""), [loading, setLoading] = useState(false), [newCount, setNewCount] = useState(0);
  const [showList, setShowList] = useState(true);
  const selectedRef = useRef<Chat | null>(null), scroll = useRef<HTMLDivElement>(null), nearBottom = useRef(true);
  const started = useRef(0), eventSource = useRef<EventSource | null>(null);

  const loadChats = useCallback(async () => {
    let beforeCursor: number | null = null;
    const all: Chat[] = [];
    do {
      const page: { chats: Chat[]; before: number | null } = await get(`chats?limit=100${beforeCursor === null ? "" : `&before=${beforeCursor}`}`);
      all.push(...page.chats); beforeCursor = page.before;
    } while (beforeCursor !== null);
    setChats(all);
    setSelected(current => current ? all.find(value => keyOf(value) === keyOf(current)) ?? current : all[0] ?? null);
  }, []);

  useEffect(() => {
    if (!active) return;
    const epoch = ++started.current;
    let source: EventSource | null = null, retry: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined, stopped = false;
    const refreshChats = () => {
      if (refresh) return;
      refresh = setTimeout(() => {
        refresh = undefined;
        if (!stopped) void loadChats().catch(() => setConnection("reconnecting"));
      }, 300);
    };
    const start = async () => {
      try {
        const status = await get<{ cursor: number }>("status");
        await loadChats();
        if (stopped || started.current !== epoch) return;
        setError("");
        source = new EventSource(`/api/telegram-observer/events?after=${status.cursor}`);
        eventSource.current = source;
        source.onopen = () => setConnection("live");
        source.onerror = () => setConnection("reconnecting");
        source.onmessage = event => {
          try {
            const value = JSON.parse(event.data) as Message;
            refreshChats();
            if (!selectedRef.current || keyOf(selectedRef.current) !== keyOf(value)) return;
            setMessages(previous => {
              const updated = updateTelegramMessage(previous, value);
              if (updated) return updated;
              if (previous.length && compareMessages(value, previous[0]) < 0) return previous;
              if (!nearBottom.current) setNewCount(count => count + 1);
              return [...previous, value].sort(compareMessages);
            });
          } catch { setConnection("reconnecting"); }
        };
      } catch {
        if (!stopped) { setConnection("reconnecting"); setError("Не удалось загрузить переписку. Повторяем подключение."); retry = setTimeout(() => { void start(); }, 3000); }
      }
    };
    void start();
    return () => { stopped = true; if (retry) clearTimeout(retry); if (refresh) clearTimeout(refresh); source?.close(); if (eventSource.current === source) eventSource.current = null; };
  }, [active, loadChats]);

  useEffect(() => {
    selectedRef.current = selected;
    setMessages([]); setBefore(null); setNewCount(0); nearBottom.current = true;
    if (!active || !selected) return;
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ chatId: selected.chat_id, threadId: selected.thread_id });
    void get<Page>(`messages?${params}`, controller.signal).then(page => {
      if (!controller.signal.aborted) {
        setMessages(current => [...page.messages.filter(item => !current.some(live => live.identity === item.identity)), ...current].sort(compareMessages));
        setBefore(page.before); setError("");
      }
    }).catch(() => { if (!controller.signal.aborted) setError("Не удалось загрузить сообщения."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [active, selected?.chat_id, selected?.thread_id]);

  useEffect(() => { if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages]);
  const older = async () => {
    if (!selected || before === null || loading) return;
    const container = scroll.current, height = container?.scrollHeight ?? 0;
    setLoading(true);
    try {
      const params = new URLSearchParams({ chatId: selected.chat_id, threadId: selected.thread_id, before: String(before) });
      const page = await get<Page>(`messages?${params}`);
      nearBottom.current = false;
      setMessages(current => [...page.messages.filter(item => !current.some(old => old.identity === item.identity)), ...current]);
      setBefore(page.before);
      requestAnimationFrame(() => { if (container) container.scrollTop += container.scrollHeight - height; });
    } catch { setError("Не удалось загрузить более ранние сообщения."); }
    finally { setLoading(false); }
  };
  const select = (chat: Chat) => { setSelected(chat); setShowList(false); };
  const sections = [{ label: "Личные чаты", chats: chats.filter(chat => !chat.chat_id.startsWith("-")) },
    { label: "Группы и темы", chats: chats.filter(chat => chat.chat_id.startsWith("-")) }];
  return <main className="tg-observer" aria-label="Telegram-чаты Brai">
    <aside className="tg-sidebar" data-visible={showList} aria-label="Список чатов">
      <header className="tg-sidebar-head"><div><span className="tg-eyebrow">Brai Agent</span><h1>Telegram</h1></div><span className="tg-live" data-state={connection}><i />{connection === "live" ? "В эфире" : connection === "loading" ? "Подключение" : "Нет связи"}</span></header>
      <p className="tg-subtitle">Переписки с агентом · только просмотр</p>
      <div className="tg-chat-list">{sections.map(section => section.chats.length > 0 && <section key={section.label}>
        <h2>{section.label}</h2>{section.chats.map(chat => <button type="button" className="tg-chat" data-selected={selected && keyOf(chat) === keyOf(selected)} key={keyOf(chat)} onClick={() => select(chat)}>
          <span className="tg-avatar" aria-hidden="true">{chatName(chat).slice(0, 1).toUpperCase()}</span>
          <span className="tg-chat-copy"><strong>{chatName(chat)}{chat.thread_id ? ` · тема ${chat.thread_id}` : ""}</strong><span>{chat.last_text || "Вложение"}</span></span>
        </button>)}</section>)}{!chats.length && !error && <p className="tg-empty-list">Чаты появятся здесь после первого сообщения.</p>}</div>
      {username && <footer className="tg-sidebar-foot">Бот @{username}</footer>}
    </aside>
    <section className="tg-main" data-list-visible={showList} aria-label="Переписка">
      <header className="tg-header"><button type="button" className="tg-back" onClick={() => setShowList(true)} aria-label="Показать список чатов">←</button>
        <div><strong>{selected ? chatName(selected) : "Переписка"}</strong><span>{selected?.thread_id ? `Тема ${selected.thread_id} · ` : ""}Только просмотр</span></div>
      </header>
      {error && <p className="tg-error" role="status">{error}</p>}
      <div ref={scroll} className="tg-conversation" onScroll={event => { const el = event.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; if (nearBottom.current) setNewCount(0); }}>
        {!selected ? <div className="tg-empty"><span className="tg-empty-mark">✦</span><h2>Выберите чат</h2><p>Здесь появятся сообщения и файлы из Telegram.</p></div> :
          <div className="tg-timeline">{before !== null && <button className="tg-older" type="button" disabled={loading} onClick={() => { void older(); }}>Показать более ранние</button>}
            {loading && !messages.length && <p className="tg-muted" role="status">Загружаем сообщения…</p>}
            {messages.map(message => <article className="tg-message" data-direction={message.direction} key={message.identity}>
              <div className="tg-message-meta"><strong>{message.author_name || (message.direction === "out" ? "Brai" : selected && !selected.chat_id.startsWith("-") ? chatName(selected) : "Отправитель не указан")}</strong><time>{time(message.occurred_at)}</time>{message.edited_at && <span>изменено</span>}</div>
              {telegramText(message.text, message.attachments) && <Markdown text={telegramText(message.text, message.attachments)} />}
              {message.attachments.length > 0 && <div className="tg-attachments">{message.attachments.map(item => <TelegramAttachment key={item.artifactId} message={message} item={item} />)}</div>}
              {message.attachment_state === "pending" && <p className="tg-muted">Сохраняем вложения…</p>}
              {message.attachment_state === "failed" && <p className="tg-muted">Сохранение вложений не подтверждено.</p>}
              {message.attachment_state === "unavailable" && <p className="tg-muted">Вложение из старой истории недоступно.</p>}
              {message.direction === "out" && (message.delivery === "failed" || message.delivery === "pending") && <p className="tg-muted">{message.delivery === "failed" ? "Не удалось доставить сообщение." : "Ожидает доставки."}</p>}
            </article>)}
          </div>}
      </div>
      {newCount > 0 && <button type="button" className="tg-new" onClick={() => { nearBottom.current = true; setNewCount(0); if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }}>Новые сообщения: {newCount} ↓</button>}
    </section>
  </main>;
}
