"use client";
// ABOUTME: Принимает аудиодневники и показывает обработанные записи в общей оболочке.
// ABOUTME: Повтор загрузки сохраняет ключ; принятый файл обрабатывается без браузера.
import {useCallback, useEffect, useRef, useState} from "react";
import {BookOpen, RefreshCw, Upload} from "lucide-react";
import WorkspaceFrame from "../shell/workspace-frame";
import {Button} from "@/components/ui/button";
import type {DiaryEntry, DiaryState, DiarySummary} from "./types";
import "./styles.css";

type Props = {userId: string; onUnauthorized: () => void};
type UploadInput = {requestId: string; filename: string; mimeType: string; recordedAt: string | null; timezone: string};
const stage: Record<DiaryState, string> = {
  awaiting_upload: "Ожидает загрузки", transcribing: "Расшифровывается",
  correcting: "Подготавливается текст", ready: "Готово", needs_attention: "Нужно внимание",
};
const active = (state: DiaryState) => ["awaiting_upload", "transcribing", "correcting"].includes(state);
/** Показывает календарную дату без перевода между часовыми поясами. */
export function diaryDate(value: string | null): string {
  return value ? new Date(value + "T12:00:00").toLocaleDateString("ru-RU", {day: "numeric", month: "long", year: "numeric"}) : "Дата не определена";
}
function message(code?: string): string {
  if (code === "UPLOAD_INTERRUPTED") return "Загрузка прервалась. Выберите тот же файл ещё раз, чтобы повторить её.";
  if (code === "TRANSCRIPT_LOST") return "Не удалось сохранить расшифровку. Исходное аудио остаётся в Дневнике.";
  if (code?.startsWith("LUNA_")) return "Подготовка текста остановилась. Исходная расшифровка сохранена; автоматического повтора нет.";
  if (code === "USER_REVOKED") return "Доступ к обработке этой записи изменился.";
  return "Обработка остановилась. Уже принятые материалы сохранены.";
}
/** Читает полный текст как текст: Markdown и инструкции дневника не исполняются. */
export function DiaryRecord({entry, userId}: {entry: DiaryEntry; userId: string}) {
  return <article className="diary-entry">
    <header><p className="diary-date">{diaryDate(entry.eventDate)}</p><h1>{entry.title}</h1>
      <p className="diary-muted">{stage[entry.state]}</p>
    </header>
    {active(entry.state) && <p className="diary-processing" role="status">{entry.state === "awaiting_upload" ? "Файл ещё загружается. Если передача прервалась, выберите его снова." : "Файл принят. Обработку можно дождаться позже — она продолжится на сервере."}</p>}
    {entry.state === "needs_attention" && <p className="diary-message diary-error" role="alert">{message(entry.errorCode ?? undefined)}</p>}
    {entry.state === "ready" && entry.eventDate === null && <p className="diary-processing">В записи не удалось однозначно определить дату события.</p>}
    {entry.correctedText !== null && <div className="diary-text">{entry.correctedText}</div>}
    {entry.rawText !== null && <details className="diary-original"><summary>Исходная расшифровка</summary><div className="diary-text">{entry.rawText}</div></details>}
    {entry.dateEvidence && <details className="diary-original"><summary>Основание даты</summary><p>{entry.dateEvidence}</p></details>}
    {entry.source === "audio" && entry.audioArtifactId && <div className="diary-audio"><h2>Аудиозапись</h2><audio controls preload="none" src={"/api/diary/file?id=" + encodeURIComponent(entry.id) + "&account=" + encodeURIComponent(userId)}/></div>}
    <p className="diary-received">Добавлено {new Date(entry.createdAt).toLocaleString("ru-RU")}</p>
  </article>;
}
/** Новый аккаунт получает отдельный экземпляр экрана и прекращает прежние запросы. */
export default function DiaryScreen(props: Props) { return <DiaryAccount key={props.userId} {...props}/>; }

function DiaryAccount({userId, onUnauthorized}: Props) {
  const [entries, setEntries] = useState<DiarySummary[]>([]), [selected, setSelected] = useState<string | null>(null);
  const [entry, setEntry] = useState<DiaryEntry | null>(null), [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false), [paging, setPaging] = useState(false);
  const alive = useRef(true), lifetime = useRef<AbortController | null>(null), locked = useRef(false);
  const readEpoch = useRef(0), input = useRef<HTMLInputElement>(null), unauthorized = useRef(onUnauthorized);
  const attempts = useRef(new Map<string, UploadInput>()), latestEntry = useRef(entry);
  latestEntry.current = entry;
  if (lifetime.current === null) lifetime.current = new AbortController();
  unauthorized.current = onUnauthorized;
  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; alive.current = true; return () => {alive.current = false; controller.abort(); readEpoch.current++;}; }, []);
  const api = useCallback(async (path: string, options: RequestInit = {}) => {
    const signal = lifetime.current!.signal;
    const response = await fetch("/api/diary" + path, {...options, cache: "no-store", signal,
      headers: {"x-brai-user": userId, ...options.headers}});
    if (response.status === 401) {unauthorized.current(); throw new Error("Войдите снова, чтобы открыть Дневник.");}
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw new Error(response.status === 413 ? "Файл превышает допустимый размер." : value.code === "IDEMPOTENCY_CONFLICT" ? "Для этой попытки уже принят другой файл. Выберите исходный файл." : "Не удалось подтвердить действие. Обновите запись перед повтором.");
    }
    const value = await response.json();
    if (signal.aborted) throw new DOMException("Request stopped", "AbortError");
    return value;
  }, [userId]);
  const refresh = useCallback(async () => {
    const data = await api("?offset=0");
    if (!alive.current) return;
    setEntries(data.entries); setHasMore(data.entries.length === 50);
  }, [api]);
  useEffect(() => {void refresh().catch(e => {if (alive.current && e.name !== "AbortError") setError(e.message);}).finally(() => {if (alive.current) setLoading(false);});}, [refresh]);
  const open = useCallback(async (id: string, quiet = false) => {
    const epoch = ++readEpoch.current;
    if (!quiet) {setSelected(id); setEntry(null); setReading(true); setError("");}
    try {
      const data = await api("/entry?id=" + encodeURIComponent(id));
      if (alive.current && epoch === readEpoch.current) setEntry(data.entry);
    } catch (e) {if (alive.current && epoch === readEpoch.current) setError((e as Error).message);}
    finally {if (alive.current && epoch === readEpoch.current) setReading(false);}
  }, [api]);
  // AIDEV-NOTE: Только чтение статуса; polling никогда не запускает повтор обработки.
  useEffect(() => {
    if (!entries.some(item => active(item.state))) return;
    let timer: ReturnType<typeof setTimeout>, stopped = false;
    const poll = async () => {
      try {await refresh(); if (!stopped && selected && (!latestEntry.current || active(latestEntry.current.state))) await open(selected, true);} catch { /* Сохранённый список остаётся доступным при обрыве. */ }
      if (!stopped && alive.current) timer = setTimeout(() => void poll(), 4000);
    };
    timer = setTimeout(() => void poll(), 4000); return () => {stopped = true; clearTimeout(timer);};
  }, [entries.some(item => active(item.state)), refresh, selected, open]);

  function uploadInput(file: File): UploadInput {
    const fingerprint = JSON.stringify([file.name, file.size, file.lastModified]);
    const key = "brai.diary.upload:" + userId + ":" + fingerprint;
    let prior = attempts.current.get(key);
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "null");
      if (!prior && stored && typeof stored.requestId === "string" && /^[0-9a-f-]{36}$/i.test(stored.requestId)
        && stored.filename === file.name && typeof stored.mimeType === "string"
        && (stored.recordedAt === null || typeof stored.recordedAt === "string") && typeof stored.timezone === "string") prior = stored;
    } catch { /* Работа продолжается с ключом в памяти, если storage недоступен. */ }
    if (!prior) prior = {requestId: crypto.randomUUID(), filename: file.name, mimeType: mime(file), recordedAt: null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"};
    attempts.current.set(key, prior);
    try {localStorage.setItem(key, JSON.stringify(prior));} catch { /* Отказ хранения не теряет текущий ключ. */ }
    return prior;
  }
  function mime(file: File): string {
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const known: Record<string, string> = {mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/opus", webm: "audio/webm", flac: "audio/flac", aac: "audio/aac"};
    return file.type.startsWith("audio/") ? file.type : known[extension] ?? "";
  }
  function put(id: string, file: File): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(), signal = lifetime.current!.signal;
      const stop = () => xhr.abort();
      const done = () => signal.removeEventListener("abort", stop);
      xhr.open("PUT", "/api/diary/upload?entry=" + encodeURIComponent(id));
      xhr.setRequestHeader("x-brai-user", userId); xhr.setRequestHeader("x-content-size", String(file.size)); xhr.timeout = 30 * 60 * 1000;
      xhr.upload.onprogress = event => {if (alive.current && event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100));};
      xhr.onload = () => {done(); if (xhr.status === 401) unauthorized.current(); xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Не удалось подтвердить загрузку. Выберите тот же файл для проверки и повтора."));};
      xhr.onerror = xhr.ontimeout = xhr.onabort = () => {done(); reject(new Error("Соединение прервалось. Выберите тот же файл, чтобы повторить загрузку."));};
      signal.addEventListener("abort", stop, {once: true});
      if (signal.aborted) {done(); reject(new Error("Запрос остановлен.")); return;}
      xhr.send(file);
    });
  }
  async function upload(files: File[]) {
    if (locked.current || !files.length) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try {
      for (const file of files) {
        if (!file.size || file.size > 2147483648 || !mime(file)) throw new Error("Выберите непустую аудиозапись размером до 2 ГБ.");
        const metadata = uploadInput(file);
        setNotice("Загружаем " + file.name); setProgress(0);
        const prepared = await api("/materials", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(metadata)});
        if (!alive.current) return;
        const id = prepared.entry.id as string;
        if (!prepared.ready) await put(id, file);
        if (!alive.current) return;
        setNotice("Файл принят. Можно закрыть страницу: обработка продолжится на сервере."); setProgress(null);
        await refresh(); await open(id);
      }
    } catch (e) {if (alive.current) {setNotice(""); setError((e as Error).message); void refresh().catch(() => {});}}
    finally {locked.current = false; if (alive.current) {setBusy(false); setProgress(null);}}
  }
  const rail = <div className="diary-rail">
    <Button onClick={() => input.current?.click()} disabled={busy}><Upload size={16}/> Загрузить аудио</Button>
    {loading ? <p role="status">Открываем Дневник…</p> : !entries.length ? <p>Сохранённые записи появятся здесь.</p> : <nav aria-label="Записи Дневника">{entries.map(item => <button key={item.id} type="button" className={selected === item.id ? "selected" : ""} onClick={() => void open(item.id)} aria-current={selected === item.id ? "page" : undefined}><strong>{item.title}</strong><span>{diaryDate(item.eventDate)}</span><small>{stage[item.state]}</small></button>)}</nav>}
    {hasMore && <Button variant="outline" disabled={paging} onClick={() => {setPaging(true); void api("?offset=" + entries.length).then(data => {if (alive.current) {setEntries(old => [...old, ...data.entries.filter((row: DiarySummary) => !old.some(x => x.id === row.id))]); setHasMore(data.entries.length === 50);}}).catch(e => {if (alive.current) setError(e.message);}).finally(() => {if (alive.current) setPaging(false);});}}>Ещё записи</Button>}
  </div>;
  return <WorkspaceFrame section="diary" userId={userId} title="Дневник" railTitle="Записи" rail={rail}>
    <input className="diary-file-input" ref={input} type="file" multiple accept="audio/*,.mp3,.m4a,.wav,.ogg,.opus,.webm,.flac,.aac" aria-label="Выбрать аудиодневники" disabled={busy} onChange={event => {const files = Array.from(event.target.files ?? []); event.target.value = ""; void upload(files);}}/>
    <div className="diary-screen">
      <div className="diary-toolbar"><p>Голосовые записи и тексты дневника</p><Button variant="outline" disabled={busy} onClick={() => {setError(""); void refresh().then(() => selected ? open(selected, true) : undefined).catch(e => {if (alive.current) setError(e.message);});}} aria-label="Обновить Дневник"><RefreshCw size={16}/></Button></div>
      {error && <p className="diary-message diary-error" role="alert">{error}</p>}
      {notice && <div className="diary-message" role="status"><p>{notice}</p>{progress !== null && <><progress value={progress} max={100}/><span>{progress}%</span><small>Не закрывайте страницу до окончания загрузки.</small></>}</div>}
      {reading && !entry ? <p role="status">Читаем запись…</p> : entry ? <DiaryRecord entry={entry} userId={userId}/> : <div className="diary-empty"><BookOpen size={36} strokeWidth={1.3}/><h1>Сохрани свой день</h1><p>Загрузи аудиозапись. Мы расшифруем её,<br/>подготовим текст и определим дату событий.</p><Button onClick={() => input.current?.click()} disabled={busy}><Upload size={16}/> Загрузить аудио</Button></div>}
    </div>
  </WorkspaceFrame>;
}
