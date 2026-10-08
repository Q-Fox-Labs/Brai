// ABOUTME: Показывает сохраняемую очередь и отдельную форму редактирования сообщения.
// ABOUTME: Форма владеет своими preview URL и не меняет основной composer.
import { useEffect, useRef, useState } from "react";
import type { ModelChoice, AgentMode, PermissionMode } from "@brai/agent/contracts";
import type { QueueEntry, QueueSettings } from "../../lib/agent/queue";
import type { QueueViewState } from "../../lib/agent/queue-controller";
import { prepareImage, releaseAttachmentPreview, type ComposerDraft, type Attachment } from "../../lib/agent/images";
import { limits } from "@brai/agent/contracts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Actions = {
  edit(id: string, draft: ComposerDraft, settings: QueueSettings): Promise<boolean>;
  move(id: string, direction: -1 | 1): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  dispatch(id: string, immediate: boolean): Promise<boolean>;
  reconcile(id: string): Promise<boolean>;
  pause(): void;
  resume(): Promise<boolean>;
};
const modeLabels = { default: "Обычный", plan: "Планирование", goal: "Цель" };
const states = { waiting: "В очереди", sending: "Отправляется…", failed: "Не отправлено", unknown: "Результат неизвестен" };

/** Управляет только выбранной очередью; отправку и хранение выполняют переданные операции. */
export default function QueuePanel({ state, models, actions }: { state: QueueViewState; models: ModelChoice[]; actions: Actions }) {
  const [editing, setEditing] = useState<QueueEntry | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const entry = editing;
  const unknown = state.entries.some(value => value.state === "unknown");
  const unavailable = !state.available || state.loading;
  if ((!state.scope || (state.available && !state.loading && !state.entries.length && !editing)) && !state.error) return null;
  return <section className="agent-queue" aria-label="Очередь сообщений">
    <div className="agent-queue-heading"><strong>Очередь{state.entries.length > 0 ? ` · ${state.entries.length}` : ""}</strong>
      <span role="status">{state.loading ? "Загрузка…" : state.paused ? "На паузе" : "Продолжена"}</span>
      {state.paused ? <Button type="button" variant="outline" size="sm" disabled={unavailable || unknown || !!editing} onClick={() => void actions.resume()}>Продолжить</Button> : <Button type="button" variant="outline" size="sm" disabled={unavailable} onClick={() => actions.pause()}>Пауза</Button>}
    </div>
    {state.paused && state.entries.length > 0 && <p className="agent-queue-hint">После перезагрузки и «Стоп» нажмите «Продолжить», чтобы отправлять очередь автоматически.</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {unknown && <p className="agent-queue-hint" role="status">Очередь остановлена: результат одной отправки неизвестен. Проверьте её или уберите запись. Удаление из очереди не отменяет возможное выполнение.</p>}
    {notice && <p role="status">{notice}</p>}
    {!!state.entries.length && <ol className="agent-queue-list">{state.entries.map((value, index) => <li key={value.id} className={`agent-queue-entry is-${value.state}`}>
      <div className="agent-queue-summary"><p>{value.draft.text || "Изображения"}</p><span>{modeLabels[value.settings.agentMode]} · {value.settings.model} · {value.settings.effort} · {states[value.state]}</span>
        {!!value.draft.images.length && <ul className="agent-queue-images" aria-label="Изображения в очереди">{value.draft.images.map(image => <li key={image.id}><img src={image.url ?? image.previewUrl} alt={image.name} /></li>)}</ul>}
        {value.error && <p role="alert">{value.error}</p>}
      </div>
      <div className="agent-queue-actions">
        <Button type="button" variant="ghost" size="sm" disabled={unavailable || !!editing || value.state === "sending" || value.state === "unknown"} onClick={() => { actions.pause(); setEditing(value); }}>Изменить</Button>
        <Button type="button" variant="ghost" size="sm" aria-label="Выше" disabled={unavailable || index === 0 || value.state === "sending" || value.state === "unknown" || ["sending", "unknown"].includes(state.entries[index - 1]?.state)} onClick={() => void actions.move(value.id, -1)}>↑</Button>
        <Button type="button" variant="ghost" size="sm" aria-label="Ниже" disabled={unavailable || index === state.entries.length - 1 || value.state === "sending" || value.state === "unknown" || ["sending", "unknown"].includes(state.entries[index + 1]?.state)} onClick={() => void actions.move(value.id, 1)}>↓</Button>
        {value.state === "unknown" ? <Button type="button" variant="outline" size="sm" disabled={unavailable || checking === value.id} onClick={async () => { setChecking(value.id); setNotice(""); const found = await actions.reconcile(value.id); setChecking(null); if (!found) setNotice("Подтверждение пока не найдено. Повторной отправки не было; запись остаётся заблокированной."); }}>Проверить</Button> : <Button type="button" variant="outline" size="sm" disabled={unavailable || !!editing || unknown || value.state === "sending"} onClick={() => void actions.dispatch(value.id, true)}>Отправить сейчас</Button>}
        <Button type="button" variant="ghost" size="sm" disabled={unavailable || value.id === editing?.id || value.state === "sending"} onClick={() => void actions.remove(value.id)}>{value.state === "unknown" ? "Убрать" : "Удалить"}</Button>
      </div>
    </li>)}</ol>}
    {entry && <QueueEditor key={entry.id} entry={entry} models={models} save={(draft, settings) => actions.edit(entry.id, draft, settings)} close={() => setEditing(null)} />}
  </section>;
}

/** Редактирует независимый черновик; закрывается только после успешного сохранения. */
export function QueueEditor({ entry, models, save, close }: { entry: QueueEntry; models: ModelChoice[]; save: (draft: ComposerDraft, settings: QueueSettings) => Promise<boolean>; close: () => void }) {
  const [draft, setDraft] = useState<ComposerDraft>(() => ({ ...entry.draft, images: entry.draft.images.map(image => ({ ...image, previewObjectUrl: false })) }));
  const initial = useRef(entry.draft);
  const owned = useRef<Attachment[]>([]);
  const [settings, setSettings] = useState(entry.settings);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    try {
      for (const image of initial.current.images) owned.current.push({ ...image, previewUrl: URL.createObjectURL(image.model), previewObjectUrl: true, url: undefined });
      setDraft(previous => ({ ...previous, images: [...owned.current] }));
    } catch {
      for (const image of owned.current) releaseAttachmentPreview(image);
      owned.current = []; setError("Не удалось подготовить изображения для редактирования.");
    }
    return () => { alive.current = false; for (const image of owned.current) releaseAttachmentPreview(image); owned.current = []; };
  }, []);
  const choice = models.find(value => value.model === settings.model);
  const allowed = settings.agentMode !== "goal" && choice?.inputModalities.includes("image");
  async function addImages(files: File[]) {
    setBusy(true); setError("");
    let next = draft;
    try {
      for (const file of files) {
        if (!allowed || next.images.length >= Math.min(limits.images, choice?.imageLimit ?? 0)) throw new Error("Для этой модели или режима нельзя добавить больше изображений.");
        const image = await prepareImage(file, limits.imageBytes - next.images.reduce((sum, value) => sum + value.bytes, 0));
        if (!alive.current) { releaseAttachmentPreview(image); return; }
        owned.current.push(image); next = { ...next, images: [...next.images, image] }; setDraft(next);
      }
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "Не удалось добавить изображение."); }
    finally { if (alive.current) setBusy(false); }
  }
  return <form className="agent-queue-editor" aria-label="Изменить сообщение в очереди" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(""); try { if (await save(draft, settings)) close(); else if (alive.current) setError("Не удалось сохранить изменения. Текст и изображения остаются в форме."); } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : "Не удалось сохранить изменения."); } finally { if (alive.current) setBusy(false); } }}>
    <label>Сообщение<Textarea value={draft.text} disabled={busy} onChange={event => setDraft(previous => ({ ...previous, text: event.target.value, revision: previous.revision + 1 }))} /></label>
    {!!draft.images.length && <ul className="agent-queue-images" aria-label="Редактируемые изображения">{draft.images.map(image => <li key={image.id}><img src={image.previewUrl} alt={image.name} /><Button type="button" variant="ghost" size="sm" disabled={busy} aria-label={`Удалить ${image.name}`} onClick={() => setDraft(previous => ({ ...previous, images: previous.images.filter(value => value.id !== image.id) }))}>×</Button></li>)}</ul>}
    <label>Добавить изображения<input type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={busy || !allowed} onChange={event => { void addImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} /></label>
    <div className="agent-queue-editor-settings">
      <label>Модель<select value={settings.model} disabled={busy} onChange={event => { const model = event.target.value; setSettings(previous => ({ ...previous, model, effort: models.find(value => value.model === model)?.defaultEffort ?? "" })); }}>{!choice && <option value={settings.model}>{settings.model} · недоступна</option>}{models.map(value => <option key={value.model} value={value.model}>{value.name}</option>)}</select></label>
      <label>Рассуждение<select value={settings.effort} disabled={busy} onChange={event => setSettings(previous => ({ ...previous, effort: event.target.value }))}>{!choice?.efforts.includes(settings.effort) && <option value={settings.effort}>{settings.effort} · недоступно</option>}{choice?.efforts.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Разрешения<select value={settings.permissionMode} disabled={busy} onChange={event => setSettings(previous => ({ ...previous, permissionMode: event.target.value as PermissionMode }))}><option value="ask">Запрашивать разрешение</option><option value="auto">Подтверждать за меня</option><option value="full">Полный доступ</option></select></label>
      <label>Режим<select value={settings.agentMode} disabled={busy} onChange={event => setSettings(previous => ({ ...previous, agentMode: event.target.value as AgentMode }))}>{Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </div>
    <p className="agent-queue-hint">Редактирование ставит очередь на паузу. После сохранения нажмите «Продолжить». При отправке в активный ход сохраняются его модель, режим и разрешения.</p>
    {error && <p role="alert">{error}</p>}
    <div className="agent-queue-actions"><Button type="submit" size="sm" disabled={busy || (!draft.text.trim() && !draft.images.length)}>Сохранить</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={close}>Отмена</Button></div>
  </form>;
}
