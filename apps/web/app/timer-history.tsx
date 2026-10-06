"use client";
// ABOUTME: Показывает дневные сегменты истории и позволяет править исходную сессию целиком.
// ABOUTME: Статистика дня приходит полностью от сервиса; история страницы её не подменяет.
import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Crown, Minus, Pencil, Plus, Timer, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { formatDuration } from "../lib/model";
import type { Active, Interval, Statistics } from "../lib/types";
import { applyEditInput, applyEditStep, createEditDraft, draftChanged, draftRange, editRangeError, formatEditValue, formatHistoryDuration, formatIntervalEdge, groupIntervalsByMoscowDate, normalizeEditValue, type EditDraft, type EditField, type IntervalSegment } from "./timer-history-model";
import "./timer-history.css";

const russianDayFormatter = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" });

const fields: { key: EditField; label: string }[] = [
 { key: "start", label: "Старт" },
 { key: "duration", label: "Итого" },
 { key: "end", label: "Финиш" },
];

function formatPanelDayTotal(ms: number): string {
 const minutes = Math.floor(Math.round(Math.max(0, ms) / 1000) / 60);
 const hours = Math.floor(minutes / 60), remainder = minutes % 60;
 if (hours === 0 && remainder === 0) return "0 мин";
 if (hours === 0) return `${remainder} мин`;
 return remainder === 0 ? `${hours} ч` : `${hours} ч ${remainder} мин`;
}

function formatPanelDate(date: string): string {
 const [year, month, day] = date.split("-").map(Number);
 if (!year || !month || !day) return date;
 return russianDayFormatter.format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function formatPanelPercent(value: number): string {
 const safe = Number.isFinite(value) ? value : 0;
 if (safe === 0) return "0%";
 return safe < 100 ? `${safe.toFixed(1).replace(".", ",")}%` : `${safe.toFixed(0)}%`;
}

type Props = {
 items: Interval[];
 active: Active | null;
 statistics: Statistics | null;
 totalCompletedMs: number | null;
 cursor: string | null;
 loading: boolean;
 connected: boolean;
 onLoadMore: () => void;
 onEdit: (timerId: string, startedAt: string, stoppedAt: string) => string | null;
 onDelete: (timerId: string) => string | null;
};

/** Показывает загруженные записи, сохраняя canonical идентификаторы и owner totals. */
export default function TimerHistory({ items, active, statistics, totalCompletedMs, cursor, loading, connected, onLoadMore, onEdit, onDelete }: Props) {
 const days = useMemo(() => groupIntervalsByMoscowDate(items), [items]);
 const [draft, setDraft] = useState<EditDraft | null>(null);
 const [activeRowId, setActiveRowId] = useState<string | null>(null);
 const [editingField, setEditingField] = useState<EditField | null>(null);
 const [inputValue, setInputValue] = useState("");
 const [editorError, setEditorError] = useState("");
 const [deleteId, setDeleteId] = useState<string | null>(null);
 const [deleteError, setDeleteError] = useState("");
 useEffect(() => {
  if (draft && !items.some(item => item.timerId === draft.timerId)) { setDraft(null); setActiveRowId(null); setEditingField(null); setInputValue(""); setEditorError(""); }
  if (deleteId && !days.some(day => day.items.some(segment => segment.rowId === deleteId))) { setDeleteId(null); setDeleteError(""); }
 }, [items, days, draft, deleteId]);

 function closeEditor() { setDraft(null); setActiveRowId(null); setEditingField(null); setInputValue(""); setEditorError(""); }
 function openEditor(segment: IntervalSegment) {
  const next = createEditDraft(segment.interval);
  if (!next) { setEditorError("Не удалось открыть запись с некорректным диапазоном."); return; }
  setDraft(next); setActiveRowId(segment.rowId); setEditingField(null); setInputValue(""); setEditorError(""); setDeleteId(null);
 }
 function update(next: EditDraft | null) {
  if (!next) { setEditorError("Финиш должен быть позже старта."); return; }
  const error = editRangeError(next, items, active);
  if (error) { setEditorError(error); return; }
  setDraft(next); setEditorError("");
 }
 function beginInput(field: EditField) {
  if (!draft) return;
  setEditingField(field); setInputValue(formatEditValue(field, draft.startMs, draft.endMs)); setEditorError("");
 }
 function commitInput(): EditDraft | null {
  if (!draft || !editingField) return draft;
  const normalized = normalizeEditValue(editingField, inputValue);
  const next = normalized ? applyEditInput(draft, editingField, normalized) : null;
  if (!next) { setEditorError(editingField === "duration" ? "Введите длительность в формате ЧЧ:ММ больше нуля." : "Введите время в формате ЧЧ:ММ."); return null; }
  const error = editRangeError(next, items, active);
  if (error) { setEditorError(error); return null; }
  setDraft(next); setEditingField(null); setInputValue(normalized ?? ""); setEditorError("");
  return next;
 }
 function save() {
  const current = editingField ? commitInput() : draft;
  if (!current) return;
  if (!draftChanged(current)) { closeEditor(); return; }
  const error = editRangeError(current, items, active);
  if (error) { setEditorError(error); return; }
  const range = draftRange(current);
  const commandId = onEdit(current.timerId, range.startedAt, range.stoppedAt);
  if (!commandId) { setEditorError("Изменение не поставлено в очередь. Повторите сохранение."); return; }
  closeEditor();
 }
 function deleteInterval(timerId: string) {
  const commandId = onDelete(timerId);
  if (!commandId) { setDeleteError("Удаление не поставлено в очередь. Повторите попытку."); return; }
  setDeleteId(null); setDeleteError("");
  if (draft?.timerId === timerId) closeEditor();
 }

 return <section className="timer-history-content" aria-label="История фокуса">
  <div className="timer-history-global-total" aria-label="Общее сохранённое время"><span>Всего</span><strong>{totalCompletedMs === null ? "…" : formatDuration(totalCompletedMs)}</strong></div>
  {items.length === 0 ? <p className="timer-history-v2-empty">{loading || totalCompletedMs === null ? "Загружаем историю…" : "Пока нет завершённых интервалов."}</p> : null}
  {days.map(day => {
   const stats = statistics?.daily.find(entry => entry.date === day.date) ?? null;
   return <div className="history-group relative flex w-full min-w-0 flex-col rounded-2xl bg-muted/72 p-1" data-slot="frame" key={day.date}>
    <Collapsible defaultOpen>
     <header className="flex flex-row items-center justify-between gap-2 px-2 py-2" data-slot="frame-panel-header">
      <CollapsibleTrigger className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-semibold outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:[&_svg]:rotate-180">
       <ChevronDown className="size-4 shrink-0 transition-transform" aria-hidden="true" />
       <span className="min-w-0 truncate">{formatPanelDate(day.date)}</span>
      </CollapsibleTrigger>
      <div className="flex shrink-0 items-center justify-end gap-1.5">
       {stats?.achieved ? <Crown className="size-3.5 shrink-0 text-primary" aria-label="Цель достигнута" /> : null}
       <span className="w-12 text-right text-xs font-normal text-primary tabular-nums">{stats ? formatPanelPercent(stats.percent) : "…"}</span>
       <span className="w-24 max-w-24 text-right text-sm font-semibold text-primary tabular-nums">{stats ? formatPanelDayTotal(stats.completedMs) : "…"}</span>
      </div>
     </header>
     <CollapsibleContent>
      <Table className="timer-history-table" variant="card"><TableBody>
       {day.items.map(segment => {
        const item = segment.interval;
        return <Fragment key={segment.rowId}>
        <TableRow className="timer-history-entry" data-timer-id={item.timerId} data-segment-id={segment.rowId} data-state={activeRowId === segment.rowId ? "selected" : undefined}>
         <TableCell>
          <button className="timer-history-entry-open" type="button" onClick={() => openEditor(segment)} aria-label={`Редактировать: ${formatIntervalEdge(segment.startedAt, day.date)} — ${formatHistoryDuration(segment.durationMs)} — ${formatIntervalEdge(segment.stoppedAt)}`}>
           <time dateTime={segment.startedAt} title={`Начало: ${new Date(segment.startedAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`}>{formatIntervalEdge(segment.startedAt, day.date)}</time>
           <span className="timer-history-entry-rule" aria-hidden="true" />
           <strong title={`${segment.durationMs} мс`}>{formatHistoryDuration(segment.durationMs)}</strong>
           <span className="timer-history-entry-rule" aria-hidden="true" />
           <time dateTime={segment.stoppedAt} title={`Финиш: ${new Date(segment.stoppedAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`}>{formatIntervalEdge(segment.stoppedAt)}</time>
          </button>
         </TableCell>
         <TableCell className="timer-history-entry-label">В фокусе{segment.split ? <small title="Редактирование и удаление применяются ко всей сессии">Часть сессии</small> : null}</TableCell>
         <TableCell><Badge aria-label="Фокус" title="Фокус" variant="outline"><Timer aria-hidden="true" /></Badge></TableCell>
         <TableCell className="timer-history-entry-actions">
          <Button aria-label="Редактировать интервал" onClick={() => openEditor(segment)} size="icon-sm" type="button" variant="ghost"><Pencil aria-hidden="true" /></Button>
          <Button aria-label={deleteId === segment.rowId ? "Подтвердить удаление интервала" : "Удалить интервал"} onClick={() => { setDeleteError(""); setDeleteId(current => current === segment.rowId ? null : segment.rowId); closeEditor(); }} size="icon-sm" type="button" variant="ghost"><Trash2 aria-hidden="true" /></Button>
         </TableCell>
        </TableRow>
        {draft && activeRowId === segment.rowId ? <TableRow className="timer-history-editor"><TableCell colSpan={4}>
         <p className="timer-history-editor-range">{segment.split ? "Эта сессия показана в нескольких днях. Правка применяется ко всей сессии." : "Редактирование всей сессии."}</p>
         <div className="timer-history-editor-fields">{fields.map(({ key, label }) => {
          const changed = key === "start" ? draft.startMs !== draft.originalStartMs : key === "end" ? draft.endMs !== draft.originalEndMs : draft.endMs - draft.startMs !== draft.originalEndMs - draft.originalStartMs;
          const invalid = editingField === key && normalizeEditValue(key, inputValue) === null;
          return <fieldset className={changed ? "is-changed" : ""} key={key}><legend>{label}</legend><Button aria-label={editingField === key ? "Отменить ввод" : "Уменьшить на 5 минут"} onClick={() => editingField === key ? setEditingField(null) : update(applyEditStep(draft, key, -1))} size="icon-xs" type="button" variant="ghost">{editingField === key ? <X /> : <Minus />}</Button>
           {editingField === key ? <Input aria-invalid={invalid} aria-label={label} inputMode="numeric" onChange={event => setInputValue(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commitInput(); } if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditingField(null); } }} value={inputValue} /> : <button className="timer-history-editor-value" onClick={() => beginInput(key)} type="button">{formatEditValue(key, draft.startMs, draft.endMs)}</button>}
           <Button aria-label={editingField === key ? "Применить ввод" : "Увеличить на 5 минут"} disabled={invalid} onClick={() => editingField === key ? commitInput() : update(applyEditStep(draft, key, 1))} size="icon-xs" type="button" variant="ghost">{editingField === key ? <Check /> : <Plus />}</Button>
          </fieldset>;
         })}</div>
         <p className="timer-history-editor-range">{new Date(draft.startMs).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} — {new Date(draft.endMs).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}</p>
         {editorError ? <p className="timer-history-editor-error" role="alert">{editorError}</p> : null}
         <div className="timer-history-editor-actions"><Button onClick={closeEditor} type="button" variant="outline">Отмена</Button><Button disabled={!draftChanged(draft) && !editingField} onClick={save} type="button">Сохранить</Button></div>
        </TableCell></TableRow> : null}
        {deleteId === segment.rowId ? <TableRow className="timer-history-delete"><TableCell colSpan={4}>
         <span>{segment.split ? "Удалить всю сессию, включая части в других днях?" : "Удалить всю сессию из истории?"}</span>{deleteError ? <span className="timer-history-editor-error" role="alert">{deleteError}</span> : null}<div><Button onClick={() => { setDeleteId(null); setDeleteError(""); }} type="button" variant="outline">Отмена</Button><Button onClick={() => deleteInterval(item.timerId)} type="button" variant="destructive">Удалить</Button></div>
        </TableCell></TableRow> : null}
       </Fragment>;
       })}
      </TableBody></Table>
     </CollapsibleContent>
    </Collapsible>
   </div>;
  })}
  {statistics === null ? <p className="timer-history-v2-note">Дневные итоги загружаются…</p> : null}
  {cursor ? <div className="timer-history-v2-more"><Button disabled={loading || !connected} onClick={onLoadMore} type="button" variant="outline">{loading ? "Загрузка…" : connected ? "Загрузить ещё" : "Нет соединения"}</Button></div> : null}
 </section>;
}
